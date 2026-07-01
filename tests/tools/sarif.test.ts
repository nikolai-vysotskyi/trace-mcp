import { describe, expect, it } from 'vitest';
import {
  antipatternFindingsToSarif,
  qualityGateReportToSarif,
  SARIF_SCHEMA_URL,
  securityFindingsToSarif,
  toSarifLog,
  type NormalizedFinding,
} from '../../src/tools/quality/sarif.js';

// The canonical, stable SARIF 2.1.0 schema location published by OASIS. This is
// the schema's own `$id` and resolves (HTTP 200); the old
// raw.githubusercontent.com/oasis-tcs/sarif-spec/master/... path is dead (404)
// because the upstream repo was reorganized.
const SARIF_SCHEMA =
  'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';

describe('SARIF 2.1.0 serializer', () => {
  it('embeds the canonical OASIS schema URL (not the dead raw.githubusercontent path)', () => {
    expect(SARIF_SCHEMA_URL).toBe(SARIF_SCHEMA);
    // Guard against regressing to the 404 URL.
    expect(SARIF_SCHEMA_URL).not.toContain('raw.githubusercontent.com');
    const log = toSarifLog(
      [{ ruleId: 'r', ruleName: 'R', level: 'error', file: 'a.ts', line: 1, message: 'm' }],
      { toolName: 't' },
    );
    expect(log.$schema).toBe(SARIF_SCHEMA);
  });

  describe('toSarifLog', () => {
    it('produces a valid SARIF 2.1.0 envelope for a single finding', () => {
      const findings: NormalizedFinding[] = [
        {
          ruleId: 'sql_injection',
          ruleName: 'SQL Injection',
          level: 'error',
          cwe: 'CWE-89',
          file: 'src/db/query.ts',
          line: 42,
          column: 7,
          message: 'Unsanitized input concatenated into SQL query.',
        },
      ];

      const log = toSarifLog(findings, { toolName: 'scan_security' });

      // Envelope shape
      expect(log.version).toBe('2.1.0');
      expect(log.$schema).toBe(SARIF_SCHEMA);
      expect(Array.isArray(log.runs)).toBe(true);
      expect(log.runs).toHaveLength(1);

      const run = log.runs[0];
      expect(run.tool.driver.name).toBe('scan_security');

      // Rule metadata is collected into tool.driver.rules
      expect(run.tool.driver.rules).toHaveLength(1);
      const rule = run.tool.driver.rules[0];
      expect(rule.id).toBe('sql_injection');
      expect(rule.name).toBe('SQL Injection');
      // CWE surfaces as a taxonomy relationship / property
      expect(rule.properties?.cwe).toBe('CWE-89');

      // Results carry level, ruleId, message, and a physical location
      expect(run.results).toHaveLength(1);
      const result = run.results[0];
      expect(result.ruleId).toBe('sql_injection');
      expect(result.level).toBe('error');
      expect(result.message.text).toBe('Unsanitized input concatenated into SQL query.');

      const loc = result.locations[0].physicalLocation;
      expect(loc.artifactLocation.uri).toBe('src/db/query.ts');
      expect(loc.region.startLine).toBe(42);
      expect(loc.region.startColumn).toBe(7);
    });

    it('deduplicates rule definitions across multiple results', () => {
      const findings: NormalizedFinding[] = [
        { ruleId: 'xss', ruleName: 'XSS', level: 'warning', file: 'a.ts', line: 1, message: 'x' },
        { ruleId: 'xss', ruleName: 'XSS', level: 'warning', file: 'b.ts', line: 2, message: 'y' },
      ];
      const log = toSarifLog(findings, { toolName: 'scan_security' });
      expect(log.runs[0].tool.driver.rules).toHaveLength(1);
      expect(log.runs[0].results).toHaveLength(2);
      // ruleIndex points back into the deduped rules array
      expect(log.runs[0].results[0].ruleIndex).toBe(0);
      expect(log.runs[0].results[1].ruleIndex).toBe(0);
    });

    it('maps severities to valid SARIF levels and omits column/region gracefully', () => {
      const findings: NormalizedFinding[] = [
        { ruleId: 'r1', ruleName: 'R1', level: 'note', file: 'c.ts', line: 0, message: 'm' },
      ];
      const log = toSarifLog(findings, { toolName: 't' });
      const result = log.runs[0].results[0];
      expect(['error', 'warning', 'note', 'none']).toContain(result.level);
      // line 0 / missing column → region falls back to line 1, no startColumn
      expect(result.locations[0].physicalLocation.region.startLine).toBeGreaterThanOrEqual(1);
    });

    it('emits an empty results array (not undefined) for zero findings', () => {
      const log = toSarifLog([], { toolName: 'scan_security' });
      expect(log.runs[0].results).toEqual([]);
      expect(log.runs[0].tool.driver.rules).toEqual([]);
    });
  });

  describe('securityFindingsToSarif', () => {
    it('maps a SecurityScanResult finding to SARIF with error level for high severity', () => {
      const log = securityFindingsToSarif({
        files_scanned: 1,
        findings: [
          {
            rule_id: 'CWE-89',
            rule_name: 'SQL Injection',
            severity: 'high',
            file: 'src/q.ts',
            line: 10,
            column: 3,
            snippet: 'db.query(`SELECT ${x}`)',
            fix: 'Use parameterized queries.',
            confidence: 'high',
          } as never,
        ],
        summary: { critical: 0, high: 1, medium: 0, low: 0 },
      } as never);

      expect(log.version).toBe('2.1.0');
      const result = log.runs[0].results[0];
      expect(result.level).toBe('error');
      expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe('src/q.ts');
      // The rule_id (CWE-89) is preserved as the CWE property on the rule.
      const rule = log.runs[0].tool.driver.rules.find((r) => r.id === 'CWE-89');
      expect(rule?.properties?.cwe).toBe('CWE-89');
    });
  });

  describe('antipatternFindingsToSarif', () => {
    it('maps an antipattern finding (null line tolerated) to SARIF', () => {
      const log = antipatternFindingsToSarif({
        findings: [
          {
            id: 'ap1',
            category: 'n_plus_one_risk',
            severity: 'medium',
            title: 'N+1 query risk',
            description: 'Loop issues a query per row.',
            file: 'src/loop.ts',
            line: null,
            fix: 'Eager-load the relation.',
            confidence: 0.8,
          },
        ],
      } as never);
      const result = log.runs[0].results[0];
      expect(result.ruleId).toBe('n_plus_one_risk');
      expect(result.level).toBe('warning');
      expect(result.locations[0].physicalLocation.region.startLine).toBe(1);
    });
  });

  describe('qualityGateReportToSarif', () => {
    it('maps failing/warning gates to SARIF results and skips passing gates', () => {
      const log = qualityGateReportToSarif({
        gates: [
          { rule: 'max_cyclomatic', status: 'error', actual: 40, threshold: 30 },
          { rule: 'max_coupling', status: 'warning', actual: 0.95, threshold: 0.9 },
          { rule: 'circular_imports', status: 'pass', actual: 0, threshold: 0 },
        ],
        summary: { total: 3, passed: 1, warnings: 1, errors: 1, result: 'FAIL' },
      } as never);
      // Only non-passing gates become results
      expect(log.runs[0].results).toHaveLength(2);
      const levels = log.runs[0].results.map((r) => r.level).sort();
      expect(levels).toEqual(['error', 'warning']);
    });
  });
});
