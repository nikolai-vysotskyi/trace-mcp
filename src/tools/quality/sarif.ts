/**
 * SARIF 2.1.0 serializer for trace-mcp quality findings.
 *
 * Static Analysis Results Interchange Format (SARIF) is the OASIS standard that
 * GitHub code-scanning, GitLab, and Azure DevOps ingest. This module maps the
 * native finding shapes produced by `scan_security`, `detect_antipatterns`, and
 * `check_quality_gates` into a SARIF log so those findings can flow into a code
 * scanning dashboard with zero glue code on the CI side.
 *
 * The serializer is intentionally dependency-free and pure — it takes findings
 * and returns a plain object. Callers JSON-stringify the result.
 *
 * Spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 */

/** Canonical schema URL embedded in the `$schema` field of a SARIF log. */
export const SARIF_SCHEMA_URL =
  'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json';

/** Valid SARIF result levels. */
export type SarifLevel = 'error' | 'warning' | 'note' | 'none';

/**
 * A tool-agnostic, normalized finding. Each quality tool has its own native
 * shape; the adapters below project those shapes onto this common structure
 * before handing off to {@link toSarifLog}.
 */
export interface NormalizedFinding {
  /** Stable rule identifier (becomes SARIF `result.ruleId` and `rule.id`). */
  ruleId: string;
  /** Human-readable rule name (becomes SARIF `rule.name`). */
  ruleName: string;
  /** SARIF severity level. */
  level: SarifLevel;
  /** Optional CWE identifier (e.g. "CWE-89") surfaced as a rule property + tag. */
  cwe?: string;
  /** Repo-relative file path (becomes `artifactLocation.uri`). */
  file: string;
  /** 1-indexed line. Values < 1 are clamped to 1. */
  line: number;
  /** 1-indexed column. Omitted from the region when absent or < 1. */
  column?: number;
  /** Result message text. */
  message: string;
  /** Optional remediation text surfaced as a result property. */
  fix?: string;
  /** Optional free-form properties attached to the result (e.g. confidence). */
  properties?: Record<string, unknown>;
}

// --- SARIF type surface (minimal subset we emit) -------------------------------

interface SarifRule {
  id: string;
  name: string;
  shortDescription?: { text: string };
  helpUri?: string;
  properties?: Record<string, unknown>;
}

interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: SarifLevel;
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region: { startLine: number; startColumn?: number };
    };
  }>;
  properties?: Record<string, unknown>;
}

interface SarifRun {
  tool: {
    driver: {
      name: string;
      informationUri: string;
      version?: string;
      rules: SarifRule[];
    };
  };
  results: SarifResult[];
}

export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: SarifRun[];
}

export interface ToSarifOptions {
  /** Name of the producing tool (driver.name). */
  toolName: string;
  /** Optional driver version. */
  toolVersion?: string;
  /** Optional driver informationUri (defaults to the trace-mcp repo). */
  informationUri?: string;
}

const DEFAULT_INFO_URI = 'https://github.com/nikolai-vysotskyi/trace-mcp';

/** Extract a CWE token (e.g. "CWE-89") from an arbitrary string, if present. */
function extractCwe(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = /CWE-\d+/i.exec(s);
  return m ? m[0].toUpperCase() : undefined;
}

/**
 * Serialize a list of normalized findings into a SARIF 2.1.0 log.
 *
 * Rules are deduplicated by `ruleId`; each result carries a `ruleIndex` pointing
 * back into `tool.driver.rules`. Zero findings still produce a well-formed run
 * with empty `rules` and `results` arrays (never `undefined`).
 */
export function toSarifLog(findings: NormalizedFinding[], opts: ToSarifOptions): SarifLog {
  const rules: SarifRule[] = [];
  const ruleIndexById = new Map<string, number>();
  const results: SarifResult[] = [];

  for (const f of findings) {
    let idx = ruleIndexById.get(f.ruleId);
    if (idx === undefined) {
      const cwe = f.cwe ?? extractCwe(f.ruleId) ?? extractCwe(f.ruleName);
      const rule: SarifRule = {
        id: f.ruleId,
        name: f.ruleName,
        shortDescription: { text: f.ruleName },
      };
      if (cwe) {
        rule.properties = {
          cwe,
          // GitHub renders `tags` in the code-scanning UI; "external/cwe/cwe-89"
          // is the convention CodeQL uses.
          tags: ['security', `external/cwe/${cwe.toLowerCase()}`],
        };
        rule.helpUri = `https://cwe.mitre.org/data/definitions/${cwe.replace(/\D/g, '')}.html`;
      }
      idx = rules.length;
      rules.push(rule);
      ruleIndexById.set(f.ruleId, idx);
    }

    const region: { startLine: number; startColumn?: number } = {
      startLine: f.line && f.line >= 1 ? f.line : 1,
    };
    if (typeof f.column === 'number' && f.column >= 1) {
      region.startColumn = f.column;
    }

    const result: SarifResult = {
      ruleId: f.ruleId,
      ruleIndex: idx,
      level: f.level,
      message: { text: f.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: f.file },
            region,
          },
        },
      ],
    };

    const props: Record<string, unknown> = { ...(f.properties ?? {}) };
    if (f.fix) props.fix = f.fix;
    if (Object.keys(props).length > 0) result.properties = props;

    results.push(result);
  }

  return {
    $schema: SARIF_SCHEMA_URL,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: opts.toolName,
            informationUri: opts.informationUri ?? DEFAULT_INFO_URI,
            ...(opts.toolVersion ? { version: opts.toolVersion } : {}),
            rules,
          },
        },
        results,
      },
    ],
  };
}

// --- Severity mappings ---------------------------------------------------------

/** OWASP/antipattern severity → SARIF level. */
function fourLevelSeverityToLevel(sev: 'critical' | 'high' | 'medium' | 'low'): SarifLevel {
  switch (sev) {
    case 'critical':
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    case 'low':
      return 'note';
  }
}

/** Quality-gate status → SARIF level. */
function gateStatusToLevel(status: 'pass' | 'warning' | 'error'): SarifLevel {
  switch (status) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'pass':
      return 'none';
  }
}

// --- Tool adapters -------------------------------------------------------------

interface SecurityFindingLike {
  rule_id: string;
  rule_name: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  file: string;
  line: number;
  column?: number;
  fix?: string;
  confidence?: string;
}

interface SecurityScanResultLike {
  findings: SecurityFindingLike[];
}

/**
 * Map a `scan_security` result to SARIF. The native `rule_id` is the CWE token
 * (e.g. "CWE-89"); `rule_name` is the human label (e.g. "SQL Injection").
 */
export function securityFindingsToSarif(
  result: SecurityScanResultLike,
  opts?: Partial<ToSarifOptions>,
): SarifLog {
  const normalized: NormalizedFinding[] = result.findings.map((f) => ({
    ruleId: f.rule_id,
    ruleName: f.rule_name,
    level: fourLevelSeverityToLevel(f.severity),
    cwe: extractCwe(f.rule_id),
    file: f.file,
    line: f.line,
    column: f.column,
    message: f.rule_name,
    fix: f.fix,
    properties: f.confidence ? { confidence: f.confidence } : undefined,
  }));
  return toSarifLog(normalized, { toolName: opts?.toolName ?? 'scan_security', ...opts });
}

interface AntipatternFindingLike {
  id: string;
  category: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  description: string;
  file: string;
  line: number | null;
  fix?: string;
  confidence?: number;
}

interface AntipatternResultLike {
  findings: AntipatternFindingLike[];
}

/** Map a `detect_antipatterns` result to SARIF. `line` may be null. */
export function antipatternFindingsToSarif(
  result: AntipatternResultLike,
  opts?: Partial<ToSarifOptions>,
): SarifLog {
  const normalized: NormalizedFinding[] = result.findings.map((f) => ({
    ruleId: f.category,
    ruleName: f.title,
    level: fourLevelSeverityToLevel(f.severity),
    file: f.file,
    line: f.line ?? 1,
    message: f.description || f.title,
    fix: f.fix,
    properties: typeof f.confidence === 'number' ? { confidence: f.confidence } : undefined,
  }));
  return toSarifLog(normalized, { toolName: opts?.toolName ?? 'detect_antipatterns', ...opts });
}

interface GateCheckResultLike {
  rule: string;
  status: 'pass' | 'warning' | 'error';
  actual: number | string;
  threshold: number | string;
  message?: string;
  details?: string;
}

interface QualityGateReportLike {
  gates: GateCheckResultLike[];
}

/**
 * Map a `check_quality_gates` report to SARIF. Passing gates are dropped — only
 * `warning`/`error` gates become SARIF results (a code-scanning dashboard only
 * cares about violations). Quality gates have no file/line, so they are anchored
 * to a synthetic project-level artifact.
 */
export function qualityGateReportToSarif(
  report: QualityGateReportLike,
  opts?: Partial<ToSarifOptions>,
): SarifLog {
  const normalized: NormalizedFinding[] = report.gates
    .filter((g) => g.status !== 'pass')
    .map((g) => ({
      ruleId: g.rule,
      ruleName: g.rule,
      level: gateStatusToLevel(g.status),
      file: '.trace-mcp/quality-gates',
      line: 1,
      message:
        g.message ?? `Gate "${g.rule}" violated: actual ${g.actual}, threshold ${g.threshold}.`,
      properties: { actual: g.actual, threshold: g.threshold, details: g.details },
    }));
  return toSarifLog(normalized, { toolName: opts?.toolName ?? 'check_quality_gates', ...opts });
}
