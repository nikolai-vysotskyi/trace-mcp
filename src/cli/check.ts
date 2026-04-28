/**
 * `trace-mcp check` command.
 * Evaluates quality gates against the indexed project.
 * Exit code 0 = pass, 1 = fail. Designed for CI pipelines.
 */

import fs from 'node:fs';
import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { initializeDatabase } from '../db/schema.js';
import { Store } from '../db/store.js';
import { ensureGlobalDirs, getDbPath } from '../global.js';
import { IndexingPipeline } from '../indexer/pipeline.js';
import { logger } from '../logger.js';
import { PluginRegistry } from '../plugin-api/registry.js';
import { findProjectRoot } from '../project-root.js';
import { getProject } from '../registry.js';
import {
  evaluateQualityGates,
  formatGateReport,
  type QualityGatesConfig,
  QualityGatesConfigSchema,
} from '../tools/quality/quality-gates.js';

function resolveDbPath(projectRoot: string): string {
  const entry = getProject(projectRoot);
  if (entry) return entry.dbPath;
  return getDbPath(projectRoot);
}

export const checkCommand = new Command('check')
  .description('Run quality gate checks against the indexed project (exit code 0 = pass, 1 = fail)')
  .option('--config <path>', 'Path to config file with quality_gates section')
  .option('--format <fmt>', 'Output format: text | json (default: text)', 'text')
  .option('--index', 'Re-index the project before checking', false)
  .option('--fail-on <level>', 'Override fail_on: error | warning | none')
  .action(async (opts: { config?: string; format: string; index: boolean; failOn?: string }) => {
    let projectRoot: string;
    try {
      projectRoot = findProjectRoot(process.cwd());
    } catch {
      projectRoot = process.cwd();
    }

    // Load config
    const configResult = await loadConfig(projectRoot);
    const config = configResult.isOk()
      ? configResult.value
      : {
          root: projectRoot,
          include: ['**/*'],
          exclude: ['vendor/**', 'node_modules/**', '.git/**'],
          db: { path: '' },
          plugins: [],
        };

    // Load quality gates config
    let gatesConfig: QualityGatesConfig;

    if (opts.config) {
      // Load from explicit config file
      try {
        const raw = JSON.parse(fs.readFileSync(opts.config, 'utf-8'));
        const parsed = QualityGatesConfigSchema.safeParse(raw.quality_gates ?? raw);
        if (!parsed.success) {
          console.error(
            `Invalid quality gates config: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          );
          process.exit(2);
        }
        gatesConfig = parsed.data;
      } catch (e) {
        console.error(`Failed to read config: ${e instanceof Error ? e.message : e}`);
        process.exit(2);
      }
    } else {
      // Try loading from project config's quality_gates section
      const rawConfig = config as Record<string, unknown>;
      if (rawConfig.quality_gates) {
        const parsed = QualityGatesConfigSchema.safeParse(rawConfig.quality_gates);
        gatesConfig = parsed.success ? parsed.data : getDefaultGatesConfig();
      } else {
        gatesConfig = getDefaultGatesConfig();
      }
    }

    // Override fail_on from CLI flag
    if (opts.failOn) {
      gatesConfig.fail_on = opts.failOn as 'error' | 'warning' | 'none';
    }

    if (!gatesConfig.enabled) {
      console.log('Quality gates are disabled.');
      return;
    }

    // Check if any rules are configured
    const hasRules = Object.values(gatesConfig.rules).some((r) => r !== undefined);
    if (!hasRules) {
      console.log('No quality gate rules configured. Using defaults.');
      gatesConfig = getDefaultGatesConfig();
    }

    // Initialize database
    const dbPath = resolveDbPath(projectRoot);
    ensureGlobalDirs();
    const db = initializeDatabase(dbPath);
    const store = new Store(db);

    // Optionally re-index
    if (opts.index) {
      const registry = PluginRegistry.createWithDefaults();
      logger.info('Indexing project before quality check...');
      const pipeline = new IndexingPipeline(store, registry, config, projectRoot);
      await pipeline.indexAll(false);
      logger.info('Indexing complete');
    }

    // Run quality gates
    const report = evaluateQualityGates(store, projectRoot, gatesConfig, {
      sinceDays: config.predictive?.git_since_days,
      moduleDepth: config.predictive?.module_depth,
    });

    db.close();

    // Output
    if (opts.format === 'json') {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(formatGateReport(report));
    }

    // Exit code
    if (report.summary.result === 'FAIL') {
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Default gates — sensible defaults for most projects
// ---------------------------------------------------------------------------

function getDefaultGatesConfig(): QualityGatesConfig {
  return {
    enabled: true,
    fail_on: 'error',
    rules: {
      max_cyclomatic_complexity: { threshold: 30, severity: 'warning' },
      max_circular_import_chains: { threshold: 0, severity: 'error' },
      max_security_critical_findings: { threshold: 0, severity: 'error' },
      max_tech_debt_grade: { threshold: 'D', severity: 'warning' },
    },
  };
}
