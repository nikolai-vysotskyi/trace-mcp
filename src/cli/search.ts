/**
 * `trace-mcp search` command.
 *
 * Thin CLI wrapper over the same retrieval surface used by the MCP `search`
 * tool. Surfaces the memoir-style retrieval modes (single | tiered | drill |
 * flat | get) so callers can pick the right precision/cost tradeoff from the
 * shell.
 *
 * Usage:
 *   trace-mcp search "User"                            # single (default)
 *   trace-mcp search "User" --mode tiered              # high/medium/low buckets
 *   trace-mcp search "save" --mode drill --drill-from src/db/store.ts
 *   trace-mcp search "TODO" --mode flat                # raw FTS hits
 *   trace-mcp search "src/db/store.ts" --mode get      # exact lookup
 */

import { Command } from 'commander';
import { initializeDatabase } from '../db/schema.js';
import { Store } from '../db/store.js';
import { findProjectRoot, hasRootMarkers } from '../project-root.js';
import { getProject } from '../registry.js';
import { search } from '../tools/navigation/navigation.js';
import {
  bucketize,
  isRetrievalMode,
  RETRIEVAL_MODES,
  type RetrievalItem,
  type RetrievalMode,
  selectRetrievalMode,
  TIERED_TOTAL_LIMIT,
} from '../ai/retrieval-modes.js';
import { searchFts } from '../db/fts.js';

interface SearchCliOpts {
  mode?: string;
  drillFrom?: string;
  kind?: string;
  language?: string;
  filePattern?: string;
  limit: string;
  json?: boolean;
}

function projectionItem(
  symbol: {
    symbol_id: string;
    name: string;
    kind: string;
    fqn: string | null;
    file_id: number;
    line_start: number | null;
  },
  file: { path: string },
  score: number,
): RetrievalItem {
  return {
    symbol_id: symbol.symbol_id,
    name: symbol.name,
    kind: symbol.kind,
    fqn: symbol.fqn,
    file: file.path,
    line: symbol.line_start,
    score,
  };
}

export const searchCommand = new Command('search')
  .description('Search the indexed codebase with memoir-style retrieval modes')
  .argument('<query>', 'Search query (path-shaped queries auto-route to mode=get)')
  .option(
    '--mode <mode>',
    `Retrieval mode: ${RETRIEVAL_MODES.join('|')} (default: auto-pick based on query)`,
  )
  .option(
    '--drill-from <id-or-path>',
    'Scope drill mode to a parent symbol_id or file path subtree',
  )
  .option('--kind <kind>', 'Filter by symbol kind (class, method, function, ...)')
  .option('--language <lang>', 'Filter by language')
  .option('--file-pattern <glob>', 'Filter by file path pattern')
  .option('--limit <n>', 'Max results returned', '20')
  .option('--json', 'Emit JSON instead of human-readable text')
  .action(async (query: string, opts: SearchCliOpts) => {
    if (opts.mode && !isRetrievalMode(opts.mode)) {
      console.error(`Unknown --mode "${opts.mode}". Choices: ${RETRIEVAL_MODES.join(', ')}.`);
      process.exit(1);
    }

    const cwd = process.cwd();
    let projectRoot: string;
    try {
      projectRoot = findProjectRoot(cwd);
    } catch {
      if (hasRootMarkers(cwd)) {
        projectRoot = cwd;
      } else {
        console.error(`No project found in ${cwd}. Run \`trace-mcp add\` first.`);
        process.exit(1);
        return;
      }
    }

    const entry = getProject(projectRoot);
    if (!entry) {
      console.error(`Project not indexed. Run \`trace-mcp add ${projectRoot}\` first.`);
      process.exit(1);
      return;
    }

    const db = initializeDatabase(entry.dbPath);
    const store = new Store(db);

    try {
      const limit = Math.max(1, parseInt(opts.limit, 10) || 20);
      const mode: RetrievalMode =
        (opts.mode as RetrievalMode | undefined) ??
        selectRetrievalMode(query, { drillFrom: opts.drillFrom });

      // ─── get mode: exact lookup, no search ───────────────────
      if (mode === 'get') {
        const bySym = store.getSymbolBySymbolId(query) ?? store.getSymbolByFqn(query);
        let item: RetrievalItem | null = null;
        if (bySym) {
          const file = store.getFileById(bySym.file_id);
          if (file) item = projectionItem(bySym, file, 1);
        } else {
          const file = store.getFile(query);
          if (file) {
            const syms = store.getSymbolsByFile(file.id);
            const first = syms[0];
            if (first) item = projectionItem(first, file, 1);
          }
        }
        const payload = { mode: 'get' as const, item };
        if (opts.json) console.log(JSON.stringify(payload, null, 2));
        else if (item)
          console.log(`${item.file}:${item.line ?? '?'}  ${item.name}  [${item.kind}]`);
        else console.log('(no match)');
        return;
      }

      // ─── flat mode: raw FTS, no PageRank ─────────────────────
      if (mode === 'flat') {
        const fts = searchFts(
          db,
          query,
          limit,
          0,
          opts.kind || opts.language || opts.filePattern
            ? {
                kind: opts.kind,
                language: opts.language,
                filePattern: opts.filePattern,
              }
            : undefined,
        );
        const symMap = store.getSymbolsByIds(fts.map((r) => r.symbolId));
        const fileIds = [...new Set(fts.map((r) => r.fileId))];
        const fileMap = store.getFilesByIds(fileIds);
        const items: RetrievalItem[] = [];
        for (const r of fts) {
          const symbol = symMap.get(r.symbolId);
          if (!symbol) continue;
          const file = fileMap.get(symbol.file_id);
          if (!file) continue;
          items.push(projectionItem(symbol, file, r.rank));
        }
        const payload = { mode: 'flat' as const, items, total: items.length };
        if (opts.json) console.log(JSON.stringify(payload, null, 2));
        else printItems(items);
        return;
      }

      // ─── single | tiered | drill: full ranker ────────────────
      const fetchLimit = mode === 'tiered' ? Math.max(limit, TIERED_TOTAL_LIMIT) : limit;
      const result = await search(
        store,
        query,
        {
          kind: opts.kind,
          language: opts.language,
          filePattern: opts.filePattern,
        },
        fetchLimit,
        0,
      );
      let items: RetrievalItem[] = result.items.map(({ symbol, file, score }) =>
        projectionItem(symbol, file, score),
      );

      if (mode === 'drill' && opts.drillFrom) {
        const scope = opts.drillFrom;
        items = items.filter(
          (it) =>
            it.file === scope ||
            it.file.startsWith(`${scope}/`) ||
            it.file.startsWith(scope) ||
            it.symbol_id === scope ||
            it.symbol_id.startsWith(`${scope}:`),
        );
      }

      if (mode === 'tiered') {
        const buckets = bucketize(items.slice(0, TIERED_TOTAL_LIMIT));
        const payload = { mode: 'tiered' as const, buckets, total: items.length };
        if (opts.json) console.log(JSON.stringify(payload, null, 2));
        else {
          console.log('--- high ---');
          printItems(buckets.high);
          console.log('--- medium ---');
          printItems(buckets.medium);
          console.log('--- low ---');
          printItems(buckets.low);
        }
        return;
      }

      const payload =
        mode === 'drill'
          ? { mode: 'drill' as const, parent: opts.drillFrom ?? '', items, total: items.length }
          : { mode: 'single' as const, items, total: items.length };
      if (opts.json) console.log(JSON.stringify(payload, null, 2));
      else printItems(items);
    } finally {
      try {
        store.db.close();
      } catch {
        /* already closed */
      }
    }
  });

function printItems(items: RetrievalItem[]): void {
  if (items.length === 0) {
    console.log('(no results)');
    return;
  }
  for (const it of items) {
    console.log(
      `${it.file}:${it.line ?? '?'}  ${it.name}  [${it.kind}]  score=${it.score.toFixed(3)}`,
    );
  }
}
