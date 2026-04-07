/**
 * `trace-mcp status` command.
 * Shows indexing progress for the current project by reading from the SQLite database.
 */

import { Command } from 'commander';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { getDbPath } from '../global.js';
import { getProject } from '../registry.js';
import { findProjectRoot } from '../project-root.js';
import { readProgressFromDb, type PipelineProgressSnapshot } from '../progress.js';

function resolveDbPath(projectRoot: string): string {
  const entry = getProject(projectRoot);
  if (entry) return entry.dbPath;
  return getDbPath(projectRoot);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function formatPipeline(name: string, p: PipelineProgressSnapshot): string {
  const label = name.padEnd(16);

  switch (p.phase) {
    case 'idle':
      return `  ${label} idle`;
    case 'running': {
      const pct = p.percentage !== null ? `(${p.percentage}%)` : '';
      const count = p.total > 0 ? `${p.processed}/${p.total}` : `${p.processed}`;
      const elapsed = p.elapsedMs > 0 ? `  ${formatDuration(p.elapsedMs)} elapsed` : '';
      return `  ${label} running    ${count} ${pct}${elapsed}`;
    }
    case 'completed': {
      const count = p.total > 0 ? `${p.processed}/${p.total}` : `${p.processed}`;
      const elapsed = p.elapsedMs > 0 ? `  ${formatDuration(p.elapsedMs)}` : '';
      return `  ${label} completed  ${count} (100%)${elapsed}`;
    }
    case 'error':
      return `  ${label} error      ${p.error ?? 'unknown error'}`;
    default:
      return `  ${label} ${p.phase}`;
  }
}

export const statusCommand = new Command('status')
  .description('Show indexing progress for the current project')
  .option('--json', 'Output as JSON')
  .action((opts: { json?: boolean }) => {
    let projectRoot: string;
    try {
      projectRoot = findProjectRoot(process.cwd());
    } catch {
      projectRoot = process.cwd();
    }

    const dbPath = resolveDbPath(projectRoot);
    if (!fs.existsSync(dbPath)) {
      console.log(`No index found for ${projectRoot}`);
      console.log('Run `trace-mcp serve` or `trace-mcp index` first.');
      process.exit(1);
    }

    const db = new Database(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');

    try {
      const progress = readProgressFromDb(db);

      // Basic stats
      const stats = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM files) as files,
          (SELECT COUNT(*) FROM symbols) as symbols,
          (SELECT COUNT(*) FROM edges) as edges
      `).get() as { files: number; symbols: number; edges: number };

      if (opts.json) {
        console.log(JSON.stringify({ projectRoot, stats, progress }, null, 2));
        return;
      }

      console.log(`\ntrace-mcp status — ${projectRoot}\n`);

      if (progress) {
        console.log(formatPipeline('Indexing:', progress.indexing));
        console.log(formatPipeline('Summarization:', progress.summarization));
        console.log(formatPipeline('Embedding:', progress.embedding));
      } else {
        console.log('  No progress data available (server may not have run yet)');
      }

      console.log(`\n  Stats: ${stats.files} files · ${stats.symbols} symbols · ${stats.edges} edges\n`);
    } finally {
      db.close();
    }
  });
