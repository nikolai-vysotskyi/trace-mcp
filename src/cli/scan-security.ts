/**
 * `trace-mcp scan-security` command.
 * Runs the OWASP Top-10 pattern scan against the indexed project.
 * Exit code 0 = no findings at/above --fail-on severity, 1 = findings found.
 * Bridges scan_security (MCP-tool-only until now) to CI: the tool's
 * output_format: "sarif" path had no way to reach a workflow step without
 * spinning up an MCP client.
 */
import { Command } from 'commander';
import { loadConfig, TraceMcpConfigSchema } from '../config.js';
import { initializeDatabase } from '../db/schema.js';
import { Store } from '../db/store.js';
import { formatToolError } from '../errors.js';
import { ensureGlobalDirs, getDbPath } from '../global.js';
import { findProjectRoot } from '../project-root.js';
import { getProject } from '../registry.js';
import { type RuleName, scanSecurity, type Severity } from '../tools/quality/security-scan.js';
import { securityFindingsToSarif } from '../tools/quality/sarif.js';

function resolveDbPath(projectRoot: string): string {
  const entry = getProject(projectRoot);
  if (entry) return entry.dbPath;
  return getDbPath(projectRoot);
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export const scanSecurityCommand = new Command('scan-security')
  .description('Run the OWASP Top-10 security scan against the indexed project')
  .option('--scope <path>', 'Directory to scan (default: whole project)')
  .option('--rules <rules>', 'Comma-separated rule list, or "all" (default: all)', 'all')
  .option('--severity-threshold <level>', 'Minimum severity to report: critical|high|medium|low')
  .option(
    '--include-low-confidence',
    'Report weakly-grounded ("low" confidence) findings too (default: suppressed)',
  )
  .option('--format <fmt>', 'Output format: json | sarif (default: json)', 'json')
  .option(
    '--fail-on <level>',
    'Exit 1 when a finding at/above this severity exists: critical|high|medium|low|none',
    'high',
  )
  .action(
    async (opts: {
      scope?: string;
      rules: string;
      severityThreshold?: string;
      includeLowConfidence?: boolean;
      format: string;
      failOn: string;
    }) => {
      let projectRoot: string;
      try {
        projectRoot = findProjectRoot(process.cwd());
      } catch {
        projectRoot = process.cwd();
      }

      const configResult = await loadConfig(projectRoot);
      if (configResult.isErr()) {
        // scanSecurity only needs a DB handle, not the parsed config — a
        // missing/invalid config file is not fatal here (matches check.ts).
        TraceMcpConfigSchema.parse({ root: projectRoot });
      }

      const dbPath = resolveDbPath(projectRoot);
      ensureGlobalDirs();
      const db = initializeDatabase(dbPath);
      const store = new Store(db);

      const rules = (opts.rules === 'all' ? ['all'] : opts.rules.split(',')) as RuleName[];
      const result = scanSecurity(store, projectRoot, {
        scope: opts.scope,
        rules,
        severityThreshold: opts.severityThreshold as Severity | undefined,
        includeLowConfidence: opts.includeLowConfidence,
      });

      db.close();

      if (result.isErr()) {
        console.error(JSON.stringify(formatToolError(result.error)));
        process.exit(2);
      }

      const report = result.value;

      if (opts.format === 'sarif') {
        process.stdout.write(`${JSON.stringify(securityFindingsToSarif(report), null, 2)}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }

      if (opts.failOn === 'none') return;
      const failRank = SEVERITY_RANK[opts.failOn as Severity] ?? SEVERITY_RANK.high;
      const hasBlockingFinding = report.findings.some((f) => SEVERITY_RANK[f.severity] >= failRank);
      if (hasBlockingFinding) {
        process.exit(1);
      }
    },
  );
