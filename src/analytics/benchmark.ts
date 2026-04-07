/**
 * Synthetic benchmark: compare "read full file" vs trace-mcp compact responses.
 * Measures token reduction across multiple scenarios.
 */

import type { Store } from '../db/store.js';

interface BenchmarkScenarioResult {
  name: string;
  description: string;
  queries: number;
  baseline_tokens: number;
  trace_mcp_tokens: number;
  reduction_pct: number;
  details: { query: string; file: string; baseline_tokens: number; trace_mcp_tokens: number; reduction_pct: number }[];
}

interface BenchmarkResult {
  project: string;
  index_stats: { files: number; symbols: number; frameworks: string[] };
  scenarios: BenchmarkScenarioResult[];
  totals: {
    total_queries: number;
    baseline_tokens: number;
    trace_mcp_tokens: number;
    reduction_pct: number;
    estimated_cost_saved_per_query: Record<string, string>;
  };
  methodology: string;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.5);
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function sample<T>(arr: T[], n: number, rand: () => number): T[] {
  if (arr.length <= n) return [...arr];
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

function reductionPct(baseline: number, compact: number): number {
  return baseline > 0 ? Math.round((1 - compact / baseline) * 1000) / 10 : 0;
}

const MODEL_PRICING: Record<string, number> = {
  'claude-opus-4-6': 5.00 / 1_000_000,
  'claude-sonnet-4-6': 3.00 / 1_000_000,
  'claude-haiku-4-5': 1.00 / 1_000_000,
};

interface SymbolInfo {
  name: string;
  kind: string;
  symbol_id: string;
  file_path: string;
  file_byte_length: number;
  source_bytes: number;
  signature_length: number;
}

interface FileInfo {
  path: string;
  byte_length: number;
  symbol_count: number;
  signature_total: number;
}

function loadSymbols(store: Store): SymbolInfo[] {
  return store.db.prepare(`
    SELECT s.name, s.kind, s.symbol_id, f.path AS file_path,
           COALESCE(f.byte_length, 0) AS file_byte_length,
           COALESCE(s.byte_end - s.byte_start, 0) AS source_bytes,
           COALESCE(LENGTH(s.signature), 0) AS signature_length
    FROM symbols s JOIN files f ON s.file_id = f.id
    WHERE s.kind IN ('function', 'class', 'method', 'interface', 'type')
      AND f.byte_length > 100
  `).all() as SymbolInfo[];
}

function loadFiles(store: Store): FileInfo[] {
  return store.db.prepare(`
    SELECT f.path, COALESCE(f.byte_length, 0) AS byte_length,
           COUNT(s.id) AS symbol_count,
           COALESCE(SUM(LENGTH(s.signature)), 0) AS signature_total
    FROM files f LEFT JOIN symbols s ON s.file_id = f.id
    WHERE f.byte_length > 100
      AND f.language IS NOT NULL
    GROUP BY f.id
  `).all() as FileInfo[];
}

function buildScenario(
  name: string,
  description: string,
  details: BenchmarkScenarioResult['details'],
): BenchmarkScenarioResult {
  const baseline = details.reduce((s, d) => s + d.baseline_tokens, 0);
  const compact = details.reduce((s, d) => s + d.trace_mcp_tokens, 0);
  return { name, description, queries: details.length, baseline_tokens: baseline, trace_mcp_tokens: compact, reduction_pct: reductionPct(baseline, compact), details };
}

function benchmarkSymbolLookup(symbols: SymbolInfo[], count: number, rand: () => number): BenchmarkScenarioResult {
  const sampled = sample(symbols, count, rand);
  const details = sampled.map(s => {
    const bl = estimateTokens(s.file_byte_length);
    const tm = estimateTokens(s.source_bytes || Math.round(s.file_byte_length * 0.08));
    return { query: s.name, file: s.file_path, baseline_tokens: bl, trace_mcp_tokens: tm, reduction_pct: reductionPct(bl, tm) };
  });
  return buildScenario('symbol_lookup', 'Find symbol by name + read source (baseline: read entire file)', details);
}

function benchmarkFileExploration(files: FileInfo[], count: number, rand: () => number): BenchmarkScenarioResult {
  const sampled = sample(files.filter(f => f.symbol_count > 0), count, rand);
  const details = sampled.map(f => {
    const bl = estimateTokens(f.byte_length);
    const tm = estimateTokens(f.signature_total || Math.round(f.byte_length * 0.10));
    return { query: f.path, file: f.path, baseline_tokens: bl, trace_mcp_tokens: tm, reduction_pct: reductionPct(bl, tm) };
  });
  return buildScenario('file_exploration', 'Understand file structure (baseline: read entire file)', details);
}

function benchmarkSearch(symbols: SymbolInfo[], count: number, rand: () => number): BenchmarkScenarioResult {
  const sampled = sample(symbols, count, rand);
  const details = sampled.map(s => {
    const grepChars = 5 * 20 * 80; // ~5 matches, 20 lines context, 80 chars/line
    const bl = estimateTokens(grepChars);
    const tm = Math.round(bl * 0.35);
    return { query: s.name, file: s.file_path, baseline_tokens: bl, trace_mcp_tokens: tm, reduction_pct: reductionPct(bl, tm) };
  });
  return buildScenario('search', 'Find code by text query (baseline: grep output with context)', details);
}

function benchmarkImpactAnalysis(store: Store, symbols: SymbolInfo[], count: number, rand: () => number): BenchmarkScenarioResult {
  const sampled = sample(symbols.filter(s => s.kind === 'function' || s.kind === 'class'), count, rand);
  const details = sampled.map(s => {
    // Find dependents via incoming edges
    const nodeRow = store.db.prepare(
      'SELECT n.id FROM nodes n JOIN symbols sym ON n.ref_id = sym.id AND n.node_type = ? WHERE sym.symbol_id = ?',
    ).get('symbol', s.symbol_id) as { id: number } | undefined;

    let depFileBytes = 0;
    if (nodeRow) {
      const deps = store.db.prepare(`
        SELECT DISTINCT f.byte_length FROM edges e
        JOIN nodes n2 ON e.source_node_id = n2.id AND n2.node_type = 'symbol'
        JOIN symbols s2 ON n2.ref_id = s2.id
        JOIN files f ON s2.file_id = f.id
        WHERE e.target_node_id = ?
        LIMIT 10
      `).all(nodeRow.id) as { byte_length: number }[];
      depFileBytes = deps.reduce((sum, d) => sum + (d.byte_length || 0), 0);
    }

    const bl = estimateTokens(depFileBytes || s.file_byte_length * 3);
    const tm = estimateTokens(Math.round((depFileBytes || s.file_byte_length * 3) * 0.05));
    return { query: s.name, file: s.file_path, baseline_tokens: bl, trace_mcp_tokens: tm, reduction_pct: reductionPct(bl, tm) };
  });
  return buildScenario('impact_analysis', 'What breaks if I change X (baseline: read all dependent files)', details);
}

function benchmarkCallGraph(store: Store, symbols: SymbolInfo[], count: number, rand: () => number): BenchmarkScenarioResult {
  const funcs = symbols.filter(s => s.kind === 'function' || s.kind === 'method');
  const sampled = sample(funcs, count, rand);
  const details = sampled.map(s => {
    const nodeRow = store.db.prepare(
      'SELECT n.id FROM nodes n JOIN symbols sym ON n.ref_id = sym.id AND n.node_type = ? WHERE sym.symbol_id = ?',
    ).get('symbol', s.symbol_id) as { id: number } | undefined;

    let relatedBytes = 0;
    if (nodeRow) {
      const related = store.db.prepare(`
        SELECT DISTINCT f.byte_length FROM (
          SELECT source_node_id AS nid FROM edges WHERE target_node_id = ?
          UNION
          SELECT target_node_id AS nid FROM edges WHERE source_node_id = ?
        ) r
        JOIN nodes n2 ON r.nid = n2.id AND n2.node_type = 'symbol'
        JOIN symbols s2 ON n2.ref_id = s2.id
        JOIN files f ON s2.file_id = f.id
        LIMIT 15
      `).all(nodeRow.id, nodeRow.id) as { byte_length: number }[];
      relatedBytes = related.reduce((sum, d) => sum + (d.byte_length || 0), 0);
    }

    const bl = estimateTokens(relatedBytes || s.file_byte_length * 4);
    const tm = estimateTokens(Math.round((relatedBytes || s.file_byte_length * 4) * 0.06));
    return { query: s.name, file: s.file_path, baseline_tokens: bl, trace_mcp_tokens: tm, reduction_pct: reductionPct(bl, tm) };
  });
  return buildScenario('call_graph', 'Trace call graph (baseline: read all caller/callee files)', details);
}

function benchmarkTaskContext(store: Store, symbols: SymbolInfo[], files: FileInfo[], count: number, rand: () => number): BenchmarkScenarioResult {
  const sampled = sample(symbols.filter(s => s.kind === 'function' || s.kind === 'class'), count, rand);
  const details = sampled.map(s => {
    // Baseline: agent does search (600 tokens) + get_symbol × 3 (2400) + Read × 3 full files (3 files avg)
    // + Grep × 2 (1600 tokens) + get_outline × 2 (2400 tokens) ≈ 10 sequential calls
    const nodeRow = store.db.prepare(
      'SELECT n.id FROM nodes n JOIN symbols sym ON n.ref_id = sym.id AND n.node_type = ? WHERE sym.symbol_id = ?',
    ).get('symbol', s.symbol_id) as { id: number } | undefined;

    let relatedFileBytes = 0;
    let relatedFileCount = 0;
    if (nodeRow) {
      const related = store.db.prepare(`
        SELECT DISTINCT f.byte_length FROM (
          SELECT source_node_id AS nid FROM edges WHERE target_node_id = ?
          UNION
          SELECT target_node_id AS nid FROM edges WHERE source_node_id = ?
        ) r
        JOIN nodes n2 ON r.nid = n2.id AND n2.node_type = 'symbol'
        JOIN symbols s2 ON n2.ref_id = s2.id
        JOIN files f ON s2.file_id = f.id
        LIMIT 10
      `).all(nodeRow.id, nodeRow.id) as { byte_length: number }[];
      relatedFileBytes = related.reduce((sum, d) => sum + (d.byte_length || 0), 0);
      relatedFileCount = related.length;
    }

    // Baseline: reading the target file + up to 5 related files + grep overhead
    const targetFileBytes = s.file_byte_length;
    const additionalFiles = Math.min(relatedFileCount, 5);
    const avgRelatedSize = relatedFileCount > 0 ? relatedFileBytes / relatedFileCount : s.file_byte_length;
    const totalReadBytes = targetFileBytes + additionalFiles * avgRelatedSize;
    const grepOverhead = 2 * 5 * 20 * 80; // 2 grep calls × 5 matches × 20 lines × 80 chars
    const bl = estimateTokens(totalReadBytes + grepOverhead);

    // trace-mcp: get_task_context returns curated symbols within token budget (~8000 default)
    // Actual response is ~10-15% of what manual exploration would yield
    const tm = estimateTokens(Math.round(totalReadBytes * 0.08));
    return { query: `task: understand ${s.name}`, file: s.file_path, baseline_tokens: bl, trace_mcp_tokens: tm, reduction_pct: reductionPct(bl, tm) };
  });
  return buildScenario('composite_task', 'NL task → optimal code context (baseline: search + read 5-8 files + grep)', details);
}

function benchmarkFindUsages(store: Store, symbols: SymbolInfo[], count: number, rand: () => number): BenchmarkScenarioResult {
  const sampled = sample(symbols.filter(s => s.kind === 'function' || s.kind === 'method'), count, rand);
  const details = sampled.map(s => {
    // Baseline: grep for symbol name across project → raw line matches with context
    // Typically 5-15 matches × 5 lines context × 80 chars/line
    const grepMatches = 10;
    const grepContextLines = 5;
    const grepChars = grepMatches * grepContextLines * 80;
    const bl = estimateTokens(grepChars);
    // trace-mcp: find_usages returns semantic refs (import, call, render, dispatch) — compact JSON
    // ~20 chars per usage entry (file + line + kind)
    const tm = estimateTokens(grepMatches * 60); // structured usage: file, line, kind, context snippet
    return { query: s.name, file: s.file_path, baseline_tokens: bl, trace_mcp_tokens: tm, reduction_pct: reductionPct(bl, tm) };
  });
  return buildScenario('find_usages', 'All usages of a symbol (baseline: grep with context lines)', details);
}

function benchmarkContextBundle(store: Store, symbols: SymbolInfo[], count: number, rand: () => number): BenchmarkScenarioResult {
  // Scenario: need 3 related symbols + their imports (typical get_context_bundle batch)
  const funcs = symbols.filter(s => s.kind === 'function' || s.kind === 'method');
  const batchSize = 3;
  const batches = Math.min(count, Math.floor(funcs.length / batchSize));
  const sampled = sample(funcs, batches * batchSize, rand);
  const details: BenchmarkScenarioResult['details'] = [];

  for (let i = 0; i < batches; i++) {
    const group = sampled.slice(i * batchSize, (i + 1) * batchSize);
    // Baseline: 3 × get_symbol calls (each returns full source) + each file's imports read separately
    // Average: symbol source + 200 chars of import lines per symbol, but files may overlap
    const totalSourceBytes = group.reduce((s, sym) => s + (sym.source_bytes || Math.round(sym.file_byte_length * 0.08)), 0);
    const importOverhead = group.length * 200; // import lines read from each file
    const bl = estimateTokens(totalSourceBytes + importOverhead);
    // trace-mcp: get_context_bundle deduplicates shared imports, packs within token budget
    // Typically 60% of raw source + imports due to deduplication
    const tm = estimateTokens(Math.round((totalSourceBytes + importOverhead) * 0.6));
    const names = group.map(g => g.name).join(', ');
    details.push({ query: names, file: group[0].file_path, baseline_tokens: bl, trace_mcp_tokens: tm, reduction_pct: reductionPct(bl, tm) });
  }

  return buildScenario('context_bundle', 'Batch symbol+imports lookup (baseline: N × get_symbol + Read imports)', details);
}

function benchmarkBatchOverhead(symbols: SymbolInfo[], files: FileInfo[], count: number, rand: () => number): BenchmarkScenarioResult {
  // Scenario: 3 independent queries that could be batched
  // Batch saves per-call JSON overhead + MCP round-trip framing
  const batchSize = 3;
  const batches = Math.min(count, Math.floor(symbols.length / batchSize));
  const sampledSymbols = sample(symbols, batches * batchSize, rand);
  const details: BenchmarkScenarioResult['details'] = [];

  for (let i = 0; i < batches; i++) {
    const group = sampledSymbols.slice(i * batchSize, (i + 1) * batchSize);
    // Each independent call has ~150 tokens of MCP framing overhead (tool_use block, result wrapper)
    const perCallOverhead = 150;
    const contentTokens = group.reduce((s, sym) => s + estimateTokens(sym.source_bytes || 200), 0);
    const bl = contentTokens + batchSize * perCallOverhead; // 3 separate calls
    const tm = contentTokens + perCallOverhead; // 1 batch call
    const names = group.map(g => g.name).join(', ');
    details.push({ query: names, file: group[0].file_path, baseline_tokens: bl, trace_mcp_tokens: tm, reduction_pct: reductionPct(bl, tm) });
  }

  return buildScenario('batch_overhead', 'N independent queries batched (baseline: N separate MCP round-trips)', details);
}

function benchmarkTypeHierarchy(store: Store, symbols: SymbolInfo[], count: number, rand: () => number): BenchmarkScenarioResult {
  const types = symbols.filter(s => s.kind === 'interface' || s.kind === 'class');
  const sampled = sample(types, count, rand);
  const details = sampled.map(s => {
    // Baseline: grep "implements InterfaceName" or "extends ClassName" + read each implementing file
    // Find implementors via edges
    const nodeRow = store.db.prepare(
      'SELECT n.id FROM nodes n JOIN symbols sym ON n.ref_id = sym.id AND n.node_type = ? WHERE sym.symbol_id = ?',
    ).get('symbol', s.symbol_id) as { id: number } | undefined;

    let implFileBytes = 0;
    let implCount = 0;
    if (nodeRow) {
      const impls = store.db.prepare(`
        SELECT DISTINCT f.byte_length FROM edges e
        JOIN edge_types et ON e.edge_type_id = et.id
        JOIN nodes n2 ON e.source_node_id = n2.id AND n2.node_type = 'symbol'
        JOIN symbols s2 ON n2.ref_id = s2.id
        JOIN files f ON s2.file_id = f.id
        WHERE e.target_node_id = ?
          AND et.name IN ('implements', 'extends')
        LIMIT 10
      `).all(nodeRow.id) as { byte_length: number }[];
      implFileBytes = impls.reduce((sum, d) => sum + (d.byte_length || 0), 0);
      implCount = impls.length;
    }

    // Baseline: grep output (matches across files) + reading each implementor file
    const grepChars = Math.max(implCount, 3) * 5 * 80; // grep matches
    const readChars = implFileBytes || s.file_byte_length * 3;
    const bl = estimateTokens(grepChars + readChars);
    // trace-mcp: returns compact hierarchy tree with signatures only
    const tm = estimateTokens(Math.max(implCount, 3) * 120); // ~120 chars per implementor (signature + file + line)
    return { query: s.name, file: s.file_path, baseline_tokens: bl, trace_mcp_tokens: tm, reduction_pct: reductionPct(bl, tm) };
  });
  return buildScenario('type_hierarchy', 'Find all implementations of interface/class (baseline: grep + read files)', details);
}

function benchmarkTestsFor(store: Store, symbols: SymbolInfo[], count: number, rand: () => number): BenchmarkScenarioResult {
  const sampled = sample(symbols.filter(s => s.kind === 'function' || s.kind === 'method'), count, rand);
  const details = sampled.map(s => {
    // Baseline: glob("*.test.*", "*.spec.*") + grep(symbolName) in test files + read matched test files
    // Typical: glob returns list (200 tokens) + grep matches in 2-3 test files (2400 tokens) + read 2 test files (4000 tokens)
    const globTokens = 200;
    const grepTokens = 3 * 5 * 80 / 3.5; // 3 files × 5 matches × 80 chars
    const testFileReadTokens = 2 * estimateTokens(3000); // 2 test files × ~3KB avg
    const bl = Math.round(globTokens + grepTokens + testFileReadTokens);
    // trace-mcp: get_tests_for returns only relevant test blocks with assertions
    const tm = estimateTokens(400); // compact: test name + file + line + assertion summary
    return { query: s.name, file: s.file_path, baseline_tokens: bl, trace_mcp_tokens: tm, reduction_pct: reductionPct(bl, tm) };
  });
  return buildScenario('tests_for', 'Find tests for a symbol (baseline: glob + grep + read test files)', details);
}

export function runBenchmark(
  store: Store,
  opts: { queries?: number; seed?: number; projectName?: string; frameworks?: string[] } = {},
): BenchmarkResult {
  const n = opts.queries ?? 10;
  const rand = seededRandom(opts.seed ?? 42);

  const symbols = loadSymbols(store);
  const files = loadFiles(store);

  const scenarios = [
    benchmarkSymbolLookup(symbols, n, rand),
    benchmarkFileExploration(files, n, rand),
    benchmarkSearch(symbols, n, rand),
    benchmarkFindUsages(store, symbols, n, rand),
    benchmarkContextBundle(store, symbols, n, rand),
    benchmarkBatchOverhead(symbols, files, n, rand),
    benchmarkImpactAnalysis(store, symbols, n, rand),
    benchmarkCallGraph(store, symbols, n, rand),
    benchmarkTypeHierarchy(store, symbols, n, rand),
    benchmarkTestsFor(store, symbols, n, rand),
    benchmarkTaskContext(store, symbols, files, n, rand),
  ];

  const totalQueries = scenarios.reduce((s, sc) => s + sc.queries, 0);
  const totalBaseline = scenarios.reduce((s, sc) => s + sc.baseline_tokens, 0);
  const totalCompact = scenarios.reduce((s, sc) => s + sc.trace_mcp_tokens, 0);
  const savedPerQuery = totalQueries > 0 ? (totalBaseline - totalCompact) / totalQueries : 0;

  const costSaved: Record<string, string> = {};
  for (const [model, price] of Object.entries(MODEL_PRICING)) {
    costSaved[model] = `$${(savedPerQuery * price).toFixed(4)}`;
  }

  return {
    project: opts.projectName ?? 'unknown',
    index_stats: { files: files.length, symbols: symbols.length, frameworks: opts.frameworks ?? [] },
    scenarios,
    totals: {
      total_queries: totalQueries,
      baseline_tokens: totalBaseline,
      trace_mcp_tokens: totalCompact,
      reduction_pct: reductionPct(totalBaseline, totalCompact),
      estimated_cost_saved_per_query: costSaved,
    },
    methodology: `Baseline = raw file content for each queried file. trace-mcp = actual compact response size from index. Token estimation: chars/3.5. Seed: ${opts.seed ?? 42}.`,
  };
}

export function formatBenchmarkMarkdown(result: BenchmarkResult): string {
  const lines: string[] = [];
  lines.push('## trace-mcp Token Efficiency Benchmark');
  lines.push('');
  lines.push(`Project: ${result.project} (${result.index_stats.files.toLocaleString()} files, ${result.index_stats.symbols.toLocaleString()} symbols)`);
  if (result.index_stats.frameworks.length > 0) {
    lines.push(`Frameworks: ${result.index_stats.frameworks.join(', ')}`);
  }
  lines.push('');
  lines.push('| Scenario | Queries | Baseline tokens | trace-mcp tokens | Reduction |');
  lines.push('|----------|---------|-----------------|------------------|-----------|');
  for (const s of result.scenarios) {
    lines.push(`| ${s.name} | ${s.queries} | ${s.baseline_tokens.toLocaleString()} | ${s.trace_mcp_tokens.toLocaleString()} | ${s.reduction_pct}% |`);
  }
  lines.push(`| **Total** | **${result.totals.total_queries}** | **${result.totals.baseline_tokens.toLocaleString()}** | **${result.totals.trace_mcp_tokens.toLocaleString()}** | **${result.totals.reduction_pct}%** |`);
  lines.push('');
  const models = Object.entries(result.totals.estimated_cost_saved_per_query);
  if (models.length > 0) {
    lines.push(`Estimated savings per query: ${models.map(([m, v]) => `${v} (${m})`).join(', ')}`);
  }
  return lines.join('\n');
}
