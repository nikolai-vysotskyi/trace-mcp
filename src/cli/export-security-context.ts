/**
 * `trace-mcp export-security-context` CLI command.
 *
 * Exports code intelligence context for MCP server security analysis.
 * Generates enrichment JSON that skill-scan can consume via --enrich
 * for cross-file annotation verification and data flow analysis.
 */

import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import { initializeDatabase } from '../db/schema.js';
import { Store } from '../db/store.js';
import { loadConfig } from '../config.js';
import { getDbPath, ensureGlobalDirs } from '../global.js';
import { getProject } from '../registry.js';
import { findProjectRoot } from '../project-root.js';
import { logger } from '../logger.js';
import { PluginRegistry } from '../plugin-api/registry.js';
import { IndexingPipeline } from '../indexer/pipeline.js';
import { exportSecurityContext } from '../tools/quality/security-context-export.js';

function resolveDbPath(projectRoot: string): string {
  const entry = getProject(projectRoot);
  if (entry) return entry.dbPath;
  return getDbPath(projectRoot);
}

export const exportSecurityContextCommand = new Command('export-security-context')
  .description('Export security context for MCP server analysis (enrichment JSON for skill-scan)')
  .option('-o, --output <path>', 'Output file path (default: stdout)', '-')
  .option('--scope <path>', 'Limit analysis to directory (relative to project root)')
  .option('--depth <n>', 'Call graph traversal depth (default: 3, max: 5)', '3')
  .option('--index', 'Re-index project before export', false)
  .action(async (opts: { output: string; scope?: string; depth: string; index?: boolean }) => {
    let projectRoot: string;
    try {
      projectRoot = findProjectRoot(process.cwd());
    } catch {
      projectRoot = process.cwd();
    }

    const dbPath = resolveDbPath(projectRoot);
    ensureGlobalDirs();

    const db = initializeDatabase(dbPath);
    const store = new Store(db);

    try {
      // Optional re-index
      if (opts.index) {
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

        const registry = PluginRegistry.createWithDefaults();

        logger.info('Indexing project...');
        const pipeline = new IndexingPipeline(store, registry, config, projectRoot);
        await pipeline.indexAll(false);
        logger.info('Indexing complete');
      }

      // Check that the project has been indexed
      const stats = store.getStats();
      if (stats.totalFiles === 0) {
        console.error(
          'Error: No files indexed. Run `trace-mcp reindex` first or use --index flag.',
        );
        process.exit(2);
      }

      const depth = Math.min(Math.max(parseInt(opts.depth, 10) || 3, 1), 5);

      const result = exportSecurityContext(store, projectRoot, {
        scope: opts.scope,
        depth,
      });

      if (result.isErr()) {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }

      const json = JSON.stringify(result.value, null, 2);

      if (opts.output === '-') {
        process.stdout.write(json + '\n');
      } else {
        const outputPath = path.resolve(opts.output);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, json, 'utf-8');
        logger.info({ path: outputPath }, 'Security context exported');
        console.error(
          `Exported to ${outputPath} (${result.value.tool_registrations.length} tool registrations)`,
        );
      }
    } finally {
      db.close();
    }
  });
