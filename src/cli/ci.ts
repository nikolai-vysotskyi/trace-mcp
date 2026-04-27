/**
 * `trace-mcp ci-report` command.
 * Generates a structured change impact report for a PR/branch.
 * Produces markdown or JSON output suitable for GitHub PR comments.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { captureBaseline, compareWithBaseline } from '../ci/baseline.js';
import {
  formatAnnotationsJson,
  formatGitHubActions,
  generateAnnotations,
} from '../ci/github-annotations.js';
import { formatJson, formatMarkdown } from '../ci/markdown-formatter.js';
import { generateReport } from '../ci/report-generator.js';
import { loadConfig } from '../config.js';
import { initializeDatabase } from '../db/schema.js';
import { Store } from '../db/store.js';
import { ensureGlobalDirs, getDbPath } from '../global.js';
import { IndexingPipeline } from '../indexer/pipeline.js';
import { logger } from '../logger.js';
import { PluginRegistry } from '../plugin-api/registry.js';
import { findProjectRoot } from '../project-root.js';
import { getProject } from '../registry.js';

function resolveDbPath(projectRoot: string): string {
  const entry = getProject(projectRoot);
  if (entry) return entry.dbPath;
  return getDbPath(projectRoot);
}

export const ciReportCommand = new Command('ci-report')
  .description('Generate a change impact report for a PR/branch')
  .option('--base <ref>', 'Base git ref (default: main)', 'main')
  .option('--head <ref>', 'Head git ref (default: HEAD)', 'HEAD')
  .option('--format <fmt>', 'Output format: markdown | json (default: markdown)', 'markdown')
  .option('--output <path>', 'Output file path (default: stdout, use - for stdout)', '-')
  .option('--fail-on <level>', 'Exit with code 1 if risk >= level: critical | high | medium', '')
  .option('--index', 'Index the project before generating the report', false)
  .option('--no-project-aware', 'Disable domain/ownership/deployment analysis')
  .option('--save-baseline', 'Save current scores as quality baseline', false)
  .option('--fail-regression', 'Exit 1 if quality regressed vs baseline', false)
  .option('--annotations <format>', 'Output annotations: github-actions | json')
  .action(
    async (opts: {
      base: string;
      head: string;
      format: string;
      output: string;
      failOn: string;
      index: boolean;
      projectAware: boolean;
      saveBaseline: boolean;
      failRegression: boolean;
      annotations?: string;
    }) => {
      // Find project root
      let projectRoot: string;
      try {
        projectRoot = findProjectRoot(process.cwd());
      } catch {
        projectRoot = process.cwd();
      }

      // Get changed files from git
      const changedFiles = getChangedFiles(projectRoot, opts.base, opts.head);

      if (changedFiles.length === 0) {
        const msg = 'No changed files found between base and head.';
        if (opts.format === 'json') {
          writeOutput(opts.output, JSON.stringify({ message: msg, changedFiles: [] }));
        } else {
          writeOutput(opts.output, `## trace-mcp Change Impact Report\n\n${msg}\n`);
        }
        return;
      }

      logger.info(
        { base: opts.base, head: opts.head, fileCount: changedFiles.length },
        'CI report: changed files detected',
      );

      // Initialize database
      const configResult = await loadConfig(projectRoot);
      const config = configResult.isOk()
        ? configResult.value
        : {
            root: projectRoot,
            include: ['**/*'],
            exclude: ['vendor/**', 'node_modules/**', '.git/**'],
            db: { path: '' },
            plugins: [] as string[],
            ignore: { directories: [] as string[], patterns: [] as string[] },
            watch: { enabled: false, debounceMs: 2000 },
          };

      const dbPath = resolveDbPath(projectRoot);
      ensureGlobalDirs();

      const db = initializeDatabase(dbPath);
      const store = new Store(db);

      // Optionally index first
      if (opts.index) {
        const registry = PluginRegistry.createWithDefaults();

        logger.info('CI report: indexing project...');
        const pipeline = new IndexingPipeline(store, registry, config, projectRoot);
        await pipeline.indexAll(false);
        logger.info('CI report: indexing complete');
      }

      // Generate report
      const report = generateReport({
        changedFiles,
        store,
        rootPath: projectRoot,
        enableProjectAware: opts.projectAware,
      });

      // Compare with baseline (if exists)
      const baseline = compareWithBaseline(store, report);
      if (baseline) {
        (report as any).baseline = baseline;
      }

      // Save baseline if requested
      if (opts.saveBaseline) {
        let commitHash = 'unknown';
        try {
          commitHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
            cwd: projectRoot,
            encoding: 'utf-8',
            timeout: 5000,
          }).trim();
        } catch {
          /* ignore */
        }
        captureBaseline(store, report, commitHash);
        logger.info({ commit: commitHash }, 'CI report: baseline saved');
      }

      // Format output
      const output = opts.format === 'json' ? formatJson(report) : formatMarkdown(report);

      writeOutput(opts.output, output);

      // Output annotations if requested
      if (opts.annotations) {
        const annotations = generateAnnotations(report);
        if (annotations.length > 0) {
          const annotationOutput =
            opts.annotations === 'json'
              ? formatAnnotationsJson(annotations)
              : formatGitHubActions(annotations);
          writeOutput('-', annotationOutput);
        }
      }

      db.close();

      // Exit with code 1 if --fail-on threshold is met
      if (opts.failOn) {
        const levels = ['low', 'medium', 'high', 'critical'];
        const thresholdIdx = levels.indexOf(opts.failOn);
        const actualIdx = levels.indexOf(report.summary.riskLevel);

        if (thresholdIdx >= 0 && actualIdx >= thresholdIdx) {
          logger.warn(
            { level: report.summary.riskLevel, threshold: opts.failOn },
            'CI report: risk threshold exceeded',
          );
          process.exit(1);
        }
      }

      // Exit with code 1 if regression detected
      if (opts.failRegression && baseline?.regressionDetected) {
        logger.warn({ riskDelta: baseline.riskDelta }, 'CI report: quality regression detected');
        process.exit(1);
      }
    },
  );

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function getChangedFiles(cwd: string, base: string, head: string): string[] {
  try {
    const output = execFileSync(
      'git',
      ['diff', '--name-only', '--diff-filter=ACMR', `${base}...${head}`],
      {
        cwd,
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((f) => !f.startsWith('.'));
  } catch {
    // Fallback: try two-dot diff (works when merge base isn't available)
    try {
      const output = execFileSync(
        'git',
        ['diff', '--name-only', '--diff-filter=ACMR', `${base}..${head}`],
        {
          cwd,
          encoding: 'utf-8',
          timeout: 30000,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      return output
        .trim()
        .split('\n')
        .filter(Boolean)
        .filter((f) => !f.startsWith('.'));
    } catch {
      logger.error('Failed to get changed files from git');
      return [];
    }
  }
}

function writeOutput(outputPath: string, content: string): void {
  if (outputPath === '-' || !outputPath) {
    process.stdout.write(`${content}\n`);
  } else {
    const resolved = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf-8');
    logger.info({ path: resolved }, 'CI report written');
  }
}
