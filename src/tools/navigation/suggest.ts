/**
 * suggest_queries — onboarding helper for new users.
 * Shows top imported files, most connected symbols, language stats, and example queries.
 */
import type { Store } from '../../db/store.js';
import { buildFileGraph } from '../analysis/graph-analysis.js';
import { computePageRank } from '../../scoring/pagerank.js';

interface LanguageStat {
  language: string;
  files: number;
}

interface SymbolKindStat {
  kind: string;
  count: number;
}

interface TopFile {
  path: string;
  importers: number;
}

interface TopSymbol {
  symbol_id: string;
  name: string;
  kind: string;
  file: string;
  pagerank: number;
}

interface ExampleQuery {
  tool: string;
  description: string;
  params: Record<string, unknown>;
}

interface SuggestQueriesResult {
  stats: {
    files: number;
    symbols: number;
    edges: number;
    routes: number;
    components: number;
  };
  languages: LanguageStat[];
  symbol_kinds: SymbolKindStat[];
  top_imported_files: TopFile[];
  top_symbols: TopSymbol[];
  example_queries: ExampleQuery[];
}

export function suggestQueries(store: Store): SuggestQueriesResult {
  const stats = store.getStats();

  // Language breakdown
  const languages = store.db.prepare(`
    SELECT language, COUNT(*) as files FROM files
    WHERE language IS NOT NULL
    GROUP BY language ORDER BY files DESC
  `).all() as LanguageStat[];

  // Symbol kind breakdown
  const symbol_kinds = store.db.prepare(`
    SELECT kind, COUNT(*) as count FROM symbols
    GROUP BY kind ORDER BY count DESC LIMIT 15
  `).all() as SymbolKindStat[];

  // Top imported files (by in-degree)
  const graph = buildFileGraph(store);
  const filesByImporters: Array<{ fileId: number; count: number }> = [];
  for (const [fileId, importers] of graph.reverse) {
    filesByImporters.push({ fileId, count: importers.size });
  }
  filesByImporters.sort((a, b) => b.count - a.count);

  const top_imported_files: TopFile[] = filesByImporters.slice(0, 10).map((f) => ({
    path: graph.pathMap.get(f.fileId) ?? `[file:${f.fileId}]`,
    importers: f.count,
  }));

  // Top symbols by PageRank
  const pagerankMap = computePageRank(store.db);
  const nodeScores = [...pagerankMap.entries()].sort((a, b) => b[1] - a[1]);
  const topNodeIds = nodeScores.slice(0, 30).map((e) => e[0]);

  const nodeRefs = store.getNodeRefsBatch(topNodeIds);
  const symbolRefIds = [...nodeRefs.entries()]
    .filter(([, r]) => r.nodeType === 'symbol')
    .map(([, r]) => r.refId);

  const symbolMap = store.getSymbolsByIds(symbolRefIds);
  const fileIds = [...new Set([...symbolMap.values()].map((s) => s.file_id))];
  const fileMap = store.getFilesByIds(fileIds);

  const top_symbols: TopSymbol[] = [];
  for (const [nodeId, score] of nodeScores) {
    if (top_symbols.length >= 10) break;
    const ref = nodeRefs.get(nodeId);
    if (!ref || ref.nodeType !== 'symbol') continue;
    const sym = symbolMap.get(ref.refId);
    if (!sym) continue;
    const file = fileMap.get(sym.file_id);
    top_symbols.push({
      symbol_id: sym.symbol_id,
      name: sym.name,
      kind: sym.kind,
      file: file?.path ?? '',
      pagerank: Math.round(score * 1e6) / 1e6,
    });
  }

  // Generate example queries from real data
  const example_queries: ExampleQuery[] = [];

  if (top_symbols.length > 0) {
    const s = top_symbols[0];
    example_queries.push({
      tool: 'get_symbol',
      description: `Read the most connected symbol: ${s.name}`,
      params: { symbol_id: s.symbol_id },
    });
  }

  if (top_symbols.length >= 2) {
    example_queries.push({
      tool: 'get_change_impact',
      description: `What breaks if ${top_symbols[1].name} changes?`,
      params: { symbol_id: top_symbols[1].symbol_id },
    });
  }

  if (top_imported_files.length > 0) {
    example_queries.push({
      tool: 'get_outline',
      description: `Explore the most-imported file`,
      params: { file_path: top_imported_files[0].path },
    });
  }

  if (stats.totalRoutes > 0) {
    example_queries.push({
      tool: 'get_request_flow',
      description: 'Trace a request through the stack',
      params: { method: 'GET', url: '/' },
    });
  }

  example_queries.push({
    tool: 'get_feature_context',
    description: 'Get AI-ready context for a task',
    params: { description: 'authentication flow', token_budget: 8000 },
  });

  if (top_symbols.length > 0) {
    example_queries.push({
      tool: 'search',
      description: 'Signal Fusion search — best ranking via multi-channel WRR (BM25 + PageRank + identity)',
      params: { query: top_symbols[0].name, fusion: true },
    });
  }

  if (stats.totalSymbols > 50) {
    example_queries.push({
      tool: 'get_project_health',
      description: 'One-shot project health triage',
      params: {},
    });
  }

  return {
    stats: {
      files: stats.totalFiles,
      symbols: stats.totalSymbols,
      edges: stats.totalEdges,
      routes: stats.totalRoutes,
      components: stats.totalComponents,
    },
    languages,
    symbol_kinds,
    top_imported_files,
    top_symbols,
    example_queries,
  };
}
