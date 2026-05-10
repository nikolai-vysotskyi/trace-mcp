/**
 * CLI: trace-mcp memory — decision memory commands.
 *
 * Usage:
 *   trace-mcp memory mine [--project=.] [--force] [--min-confidence=0.6]
 *   trace-mcp memory search "query" [--project=.] [--limit=20]
 *   trace-mcp memory stats [--project=.]
 *   trace-mcp memory decisions [--project=.] [--type=tech_choice] [--search="query"] [--branch=current|all|<name>]
 *   trace-mcp memory timeline [--project=.] [--file=path]
 *   trace-mcp memory index [--project=.] [--force]
 */

import * as path from 'node:path';
import { Command } from 'commander';
import { DECISIONS_DB_PATH, ensureGlobalDirs } from '../global.js';
import { mineSessions } from '../memory/conversation-miner.js';
import { DecisionStore } from '../memory/decision-store.js';
import { indexSessions } from '../memory/session-indexer.js';
import { assembleWakeUp } from '../memory/wake-up.js';
import { getCurrentBranch } from '../utils/git-branch.js';

function openStore(): DecisionStore {
  ensureGlobalDirs();
  return new DecisionStore(DECISIONS_DB_PATH);
}

export const memoryCommand = new Command('memory')
  .description('Decision memory — mine, search, and manage architectural decisions')
  .alias('mem');

// ── memory mine ─────────────────────────────────────────────────────

memoryCommand
  .command('mine')
  .description('Mine Claude Code / Claw Code session logs for decisions')
  .option('--project <path>', 'Project root to mine (default: current directory)', process.cwd())
  .option('--force', 'Re-mine already processed sessions')
  .option('--min-confidence <n>', 'Minimum confidence threshold (default: 0.6)', '0.6')
  .action(async (opts: { project: string; force?: boolean; minConfidence: string }) => {
    const store = openStore();
    try {
      const projectRoot = path.resolve(opts.project);
      console.log(`Mining sessions for: ${projectRoot}`);

      const result = await mineSessions(store, {
        projectRoot,
        force: opts.force,
        minConfidence: parseFloat(opts.minConfidence),
      });

      console.log(`\n  Sessions scanned: ${result.sessions_scanned}`);
      console.log(`  Sessions mined:   ${result.sessions_mined}`);
      console.log(`  Sessions skipped: ${result.sessions_skipped}`);
      console.log(`  Decisions found:  ${result.decisions_extracted}`);
      console.log(`  Errors:           ${result.errors}`);
      console.log(`  Duration:         ${result.duration_ms}ms`);
      console.log();
    } finally {
      store.close();
    }
  });

// ── memory index ────────────────────────────────────────────────────

memoryCommand
  .command('index')
  .description('Index session content for cross-session search')
  .option('--project <path>', 'Project root to index (default: current directory)', process.cwd())
  .option('--force', 'Re-index already processed sessions')
  .action((opts: { project: string; force?: boolean }) => {
    const store = openStore();
    try {
      const projectRoot = path.resolve(opts.project);
      console.log(`Indexing session content for: ${projectRoot}`);

      const result = indexSessions(store, {
        projectRoot,
        force: opts.force,
      });

      console.log(`\n  Sessions scanned: ${result.sessions_scanned}`);
      console.log(`  Sessions indexed: ${result.sessions_indexed}`);
      console.log(`  Sessions skipped: ${result.sessions_skipped}`);
      console.log(`  Chunks added:     ${result.chunks_added}`);
      console.log(`  Errors:           ${result.errors}`);
      console.log(`  Duration:         ${result.duration_ms}ms`);
      console.log();
    } finally {
      store.close();
    }
  });

// ── memory search ───────────────────────────────────────────────────

memoryCommand
  .command('search <query>')
  .description('Search across past session conversations')
  .option('--project <path>', 'Filter to project (default: current directory)', process.cwd())
  .option('--limit <n>', 'Max results (default: 20)', '20')
  .action((query: string, opts: { project: string; limit: string }) => {
    const store = openStore();
    try {
      const projectRoot = path.resolve(opts.project);
      const results = store.searchSessions(query, {
        project_root: projectRoot,
        limit: parseInt(opts.limit, 10),
      });

      if (results.length === 0) {
        const chunkCount = store.getSessionChunkCount(projectRoot);
        if (chunkCount === 0) {
          console.log('No sessions indexed yet. Run `trace-mcp memory index` first.');
        } else {
          console.log(`No results for "${query}" (${chunkCount} chunks indexed).`);
        }
        return;
      }

      console.log(`Found ${results.length} results for "${query}":\n`);
      for (const r of results) {
        const preview = r.content.length > 150 ? `${r.content.slice(0, 147)}...` : r.content;
        console.log(`  [${r.session_id}] ${r.role} (${r.timestamp})`);
        console.log(`    ${preview}`);
        if (r.referenced_files) {
          console.log(`    Files: ${r.referenced_files}`);
        }
        console.log();
      }
    } finally {
      store.close();
    }
  });

// ── memory decisions ────────────────────────────────────────────────

memoryCommand
  .command('decisions')
  .description('List decisions in the knowledge graph')
  .option('--project <path>', 'Filter to project (default: current directory)', process.cwd())
  .option(
    '--type <type>',
    'Filter by type (architecture_decision, tech_choice, bug_root_cause, preference, tradeoff, discovery, convention)',
  )
  .option('--search <query>', 'Full-text search query')
  .option(
    '--branch <name>',
    'Branch filter: "current" (default) → current branch + branch-agnostic; "all" → every branch; <name> → that branch + branch-agnostic',
    'current',
  )
  .option('--limit <n>', 'Max results (default: 20)', '20')
  .option('--json', 'Output as JSON')
  .action(
    (opts: {
      project: string;
      type?: string;
      search?: string;
      branch: string;
      limit: string;
      json?: boolean;
    }) => {
      const store = openStore();
      try {
        const projectRoot = path.resolve(opts.project);
        // Resolve the three-mode branch filter; mirrors the MCP tool semantics.
        let branchFilter: string | null | 'all' | undefined;
        if (opts.branch === 'all') {
          branchFilter = 'all';
        } else if (opts.branch === 'current') {
          branchFilter = getCurrentBranch(projectRoot) ?? 'all';
        } else {
          branchFilter = opts.branch;
        }
        const decisions = store.queryDecisions({
          project_root: projectRoot,
          type: opts.type as Parameters<typeof store.queryDecisions>[0]['type'],
          search: opts.search,
          git_branch: branchFilter,
          limit: parseInt(opts.limit, 10),
        });

        if (opts.json) {
          console.log(JSON.stringify(decisions, null, 2));
          return;
        }

        if (decisions.length === 0) {
          console.log(
            'No decisions found. Run `trace-mcp memory mine` to extract from session logs.',
          );
          return;
        }

        console.log(`${decisions.length} decisions:\n`);
        for (const d of decisions) {
          const status = d.valid_until ? '(invalidated)' : '(active)';
          const link = d.symbol_id ? ` → ${d.symbol_id}` : d.file_path ? ` → ${d.file_path}` : '';
          console.log(`  #${d.id} [${d.type}] ${d.title} ${status}${link}`);
          console.log(`    ${d.content.slice(0, 120)}${d.content.length > 120 ? '...' : ''}`);
          console.log(
            `    Source: ${d.source} | Confidence: ${(d.confidence * 100).toFixed(0)}% | Since: ${d.valid_from}`,
          );
          console.log();
        }
      } finally {
        store.close();
      }
    },
  );

// ── memory stats ────────────────────────────────────────────────────

memoryCommand
  .command('stats')
  .description('Show decision memory statistics')
  .option('--project <path>', 'Filter to project (default: current directory)', process.cwd())
  .option('--json', 'Output as JSON')
  .action((opts: { project: string; json?: boolean }) => {
    const store = openStore();
    try {
      const projectRoot = path.resolve(opts.project);
      const stats = store.getStats(projectRoot);
      const minedCount = store.getMinedSessionCount();
      const chunkCount = store.getSessionChunkCount(projectRoot);
      const indexedSessions = store.getIndexedSessionIds(projectRoot);

      const fullStats = {
        ...stats,
        sessions_mined: minedCount,
        sessions_indexed: indexedSessions.length,
        content_chunks: chunkCount,
      };

      if (opts.json) {
        console.log(JSON.stringify(fullStats, null, 2));
        return;
      }

      console.log('Decision Memory Stats:\n');
      console.log(`  Total decisions:  ${stats.total}`);
      console.log(`  Active:           ${stats.active}`);
      console.log(`  Invalidated:      ${stats.invalidated}`);
      console.log(`  Sessions mined:   ${minedCount}`);
      console.log(`  Sessions indexed: ${indexedSessions.length}`);
      console.log(`  Content chunks:   ${chunkCount}`);
      console.log();
      if (Object.keys(stats.by_type).length > 0) {
        console.log('  By type:');
        for (const [type, count] of Object.entries(stats.by_type)) {
          console.log(`    ${type}: ${count}`);
        }
        console.log();
      }
      if (Object.keys(stats.by_source).length > 0) {
        console.log('  By source:');
        for (const [source, count] of Object.entries(stats.by_source)) {
          console.log(`    ${source}: ${count}`);
        }
      }
    } finally {
      store.close();
    }
  });

// ── memory wake-up ──────────────────────────────────────────────────
//
// Compact orientation context (~300 tokens) for SessionStart hook injection.
// Shells out cheaply: opens DecisionStore, calls assembleWakeUp, prints JSON.
// Designed for the SessionStart lifecycle hook — must complete in <2s on a
// warm SQLite connection. No daemon round-trip required.

memoryCommand
  .command('wake-up')
  .description('Compact wake-up context (project + recent decisions + memory stats)')
  .option('--project <path>', 'Project root (default: current directory)', process.cwd())
  .option('--max-decisions <n>', 'Max recent decisions to include (default: 10)', '10')
  .option('--json', 'Output as JSON (default: pretty text)')
  .action((opts: { project: string; maxDecisions: string; json?: boolean }) => {
    const store = openStore();
    try {
      const projectRoot = path.resolve(opts.project);
      const wakeUp = assembleWakeUp(store, projectRoot, {
        maxDecisions: parseInt(opts.maxDecisions, 10),
      });

      if (opts.json) {
        console.log(JSON.stringify(wakeUp, null, 2));
        return;
      }

      console.log(`Project: ${wakeUp.project.name}`);
      console.log(`  Root: ${wakeUp.project.root}`);
      console.log();
      console.log(
        `Decisions: ${wakeUp.decisions.total_active} active, showing ${wakeUp.decisions.recent.length} recent`,
      );
      for (const d of wakeUp.decisions.recent) {
        const link = d.symbol ? ` → ${d.symbol}` : d.file ? ` → ${d.file}` : '';
        console.log(`  #${d.id} [${d.type}] ${d.title}${link}`);
      }
      console.log();
      console.log(
        `Memory: ${wakeUp.memory.total_decisions} decisions, ${wakeUp.memory.sessions_mined} sessions mined, ${wakeUp.memory.sessions_indexed} indexed`,
      );
      console.log(`Estimated tokens: ${wakeUp.estimated_tokens}`);
    } finally {
      store.close();
    }
  });

// ── memory timeline ─────────────────────────────────────────────────

memoryCommand
  .command('timeline')
  .description('Show chronological timeline of decisions')
  .option('--project <path>', 'Filter to project (default: current directory)', process.cwd())
  .option('--file <path>', 'Filter to decisions about this file')
  .option('--symbol <id>', 'Filter to decisions about this symbol')
  .option('--limit <n>', 'Max entries (default: 50)', '50')
  .action((opts: { project: string; file?: string; symbol?: string; limit: string }) => {
    const store = openStore();
    try {
      const projectRoot = path.resolve(opts.project);
      const timeline = store.getTimeline({
        project_root: projectRoot,
        file_path: opts.file,
        symbol_id: opts.symbol,
        limit: parseInt(opts.limit, 10),
      });

      if (timeline.length === 0) {
        console.log('No decision timeline found.');
        return;
      }

      console.log('Decision Timeline:\n');
      for (const entry of timeline) {
        const status = entry.is_active ? '●' : '○';
        const end = entry.valid_until ? ` → ${entry.valid_until}` : '';
        console.log(`  ${status} ${entry.valid_from}${end}`);
        console.log(`    [${entry.type}] ${entry.title}`);
        console.log();
      }
    } finally {
      store.close();
    }
  });
