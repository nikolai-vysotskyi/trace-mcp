/**
 * Synthetic benchmark: estimate "read full file" cost vs trace-mcp compact-response cost
 * across multiple scenarios.
 *
 * IMPORTANT — this is a SYNTHETIC ESTIMATOR, not a real measurement harness:
 *  - The baseline side is computed from real file byte_length values stored in the
 *    SQLite index. It is NOT a re-read from disk.
 *  - The trace-mcp side is computed from per-scenario fixed multipliers (e.g.
 *    `bytes * 0.08`), NOT from actual tool invocations. The reduction percentages
 *    are therefore upper-bound estimates, not measured savings.
 *  - Tokens are estimated from character count. With `gpt-tokenizer` installed the
 *    estimator calibrates against a sample to give a more accurate chars-per-token
 *    ratio; otherwise it falls back to the legacy chars/3.5 heuristic (documented
 *    in BenchmarkResult.methodology and accuracy).
 *  - Each scenario is sampled `samples` times with seed-shifted re-rolls so the
 *    output includes a mean, stddev, and p95 — single-shot is no longer the only
 *    reported figure.
 */

import type { Store } from '../db/store.js';

interface ScenarioStats {
  mean: number;
  stddev: number;
  p95: number;
  samples: number;
}

interface BenchmarkScenarioResult {
  name: string;
  description: string;
  queries: number;
  baseline_tokens: number;
  trace_mcp_tokens: number;
  reduction_pct: number;
  /** Multi-sample dispersion of reduction_pct across `samples` runs. */
  reduction_stats?: ScenarioStats;
  details: {
    query: string;
    file: string;
    baseline_tokens: number;
    trace_mcp_tokens: number;
    reduction_pct: number;
  }[];
}

interface BenchmarkAccuracy {
  /** "synthetic-estimator" — neither side is a real tool invocation. */
  kind: 'synthetic-estimator';
  /** Calibrated characters-per-token ratio used by estimateTokens. */
  chars_per_token: number;
  /** Whether a real tokenizer was used to calibrate (gpt-tokenizer cl100k_base). */
  tokenizer_calibrated: boolean;
  /** How many seed-shifted re-runs were averaged. */
  samples: number;
  /** Caveats consumers should not strip from machine-readable output. */
  caveats: string[];
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
    /** Reduction-pct dispersion across scenarios (cross-scenario, not cross-sample). */
    reduction_stats?: ScenarioStats;
    estimated_cost_saved_per_query: Record<string, string>;
  };
  methodology: string;
  accuracy: BenchmarkAccuracy;
}

/**
 * Characters-per-token ratio used to convert char counts to token estimates.
 *
 * BEFORE: hardcoded `3.5` everywhere, which overestimates Claude/GPT tokens for
 * source code by ~14% versus a real BPE tokenizer (cl100k_base typically yields
 * ~3.9-4.1 chars/token for TypeScript-ish text).
 *
 * AFTER: defaults to 4.0 (closer to cl100k_base on code), and is replaced by a
 * calibrated value when `gpt-tokenizer` is loaded successfully and given a sample.
 */
const DEFAULT_CHARS_PER_TOKEN = 4.0;
const LEGACY_CHARS_PER_TOKEN = 3.5; // retained only for tests that assert the legacy ratio

let CALIBRATED_CHARS_PER_TOKEN: number = DEFAULT_CHARS_PER_TOKEN;
let TOKENIZER_CALIBRATED = false;

function estimateTokensWith(chars: number, charsPerToken: number): number {
  return Math.ceil(chars / charsPerToken);
}

function estimateTokens(chars: number): number {
  return estimateTokensWith(chars, CALIBRATED_CHARS_PER_TOKEN);
}

/**
 * Calibrate CALIBRATED_CHARS_PER_TOKEN against a real BPE tokenizer when available.
 *
 * BEFORE: a single hardcoded constant (3.5) was used to convert chars→tokens, with
 * no way to verify how far off it was on actual source code.
 *
 * AFTER: tries `gpt-tokenizer` (cl100k_base). If the import succeeds we tokenize a
 * representative TypeScript sample and store the measured ratio; otherwise we keep
 * the documented default and flag `tokenizer_calibrated: false` in the result.
 *
 * Idempotent — first successful calibration sticks for process lifetime.
 */
export async function calibrateTokenizer(sample?: string): Promise<void> {
  return tryCalibrateTokenizer(sample);
}

async function tryCalibrateTokenizer(sample?: string): Promise<void> {
  if (TOKENIZER_CALIBRATED) return;
  const calibrationSample =
    sample ??
    `import { describe, it, expect } from 'vitest';\n` +
      `export function parseInput(input: string): AST {\n` +
      `  const tokens = tokenize(input);\n` +
      `  return buildTree(tokens);\n` +
      `}\n` +
      `class Parser { constructor(private opts: ParserOptions) {} parse(src: string) { /* ... */ } }`;
  try {
    const mod = (await import('gpt-tokenizer')) as { encode?: (s: string) => number[] };
    if (typeof mod.encode === 'function') {
      const tokens = mod.encode(calibrationSample);
      if (tokens.length > 0) {
        const ratio = calibrationSample.length / tokens.length;
        // Clamp to a sane band — guards against weird tokenizers / empty samples.
        if (ratio >= 2.0 && ratio <= 6.0) {
          CALIBRATED_CHARS_PER_TOKEN = ratio;
          TOKENIZER_CALIBRATED = true;
        }
      }
    }
  } catch {
    // gpt-tokenizer not installed or failed to load — keep default.
  }
}

/**
 * Test/internal hook: reset the calibrated ratio so unit tests can exercise both
 * "tokenizer available" and "fallback" code paths deterministically.
 */
export function _resetTokenizerCalibrationForTests(
  ratio: number = DEFAULT_CHARS_PER_TOKEN,
  calibrated = false,
): void {
  CALIBRATED_CHARS_PER_TOKEN = ratio;
  TOKENIZER_CALIBRATED = calibrated;
}

export function _getCharsPerTokenForTests(): { ratio: number; calibrated: boolean } {
  return { ratio: CALIBRATED_CHARS_PER_TOKEN, calibrated: TOKENIZER_CALIBRATED };
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((s, v) => s + (v - m) * (v - m), 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function buildStats(values: number[]): ScenarioStats {
  return {
    mean: Math.round(mean(values) * 100) / 100,
    stddev: Math.round(stddev(values) * 100) / 100,
    p95: Math.round(percentile(values, 95) * 100) / 100,
    samples: values.length,
  };
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
  'claude-opus-4-6': 5.0 / 1_000_000,
  'claude-sonnet-4-6': 3.0 / 1_000_000,
  'claude-haiku-4-5': 1.0 / 1_000_000,
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
  return store.db
    .prepare(`
    SELECT s.name, s.kind, s.symbol_id, f.path AS file_path,
           COALESCE(f.byte_length, 0) AS file_byte_length,
           COALESCE(s.byte_end - s.byte_start, 0) AS source_bytes,
           COALESCE(LENGTH(s.signature), 0) AS signature_length
    FROM symbols s JOIN files f ON s.file_id = f.id
    WHERE s.kind IN ('function', 'class', 'method', 'interface', 'type')
      AND f.byte_length > 100
  `)
    .all() as SymbolInfo[];
}

function loadFiles(store: Store): FileInfo[] {
  return store.db
    .prepare(`
    SELECT f.path, COALESCE(f.byte_length, 0) AS byte_length,
           COUNT(s.id) AS symbol_count,
           COALESCE(SUM(LENGTH(s.signature)), 0) AS signature_total
    FROM files f LEFT JOIN symbols s ON s.file_id = f.id
    WHERE f.byte_length > 100
      AND f.language IS NOT NULL
    GROUP BY f.id
  `)
    .all() as FileInfo[];
}

function buildScenario(
  name: string,
  description: string,
  details: BenchmarkScenarioResult['details'],
): BenchmarkScenarioResult {
  const baseline = details.reduce((s, d) => s + d.baseline_tokens, 0);
  const compact = details.reduce((s, d) => s + d.trace_mcp_tokens, 0);
  return {
    name,
    description,
    queries: details.length,
    baseline_tokens: baseline,
    trace_mcp_tokens: compact,
    reduction_pct: reductionPct(baseline, compact),
    details,
  };
}

function benchmarkSymbolLookup(
  symbols: SymbolInfo[],
  count: number,
  rand: () => number,
): BenchmarkScenarioResult {
  const sampled = sample(symbols, count, rand);
  const details = sampled.map((s) => {
    const bl = estimateTokens(s.file_byte_length);
    const tm = estimateTokens(s.source_bytes || Math.round(s.file_byte_length * 0.08));
    return {
      query: s.name,
      file: s.file_path,
      baseline_tokens: bl,
      trace_mcp_tokens: tm,
      reduction_pct: reductionPct(bl, tm),
    };
  });
  return buildScenario(
    'symbol_lookup',
    'Find symbol by name + read source (baseline: read entire file)',
    details,
  );
}

function benchmarkFileExploration(
  files: FileInfo[],
  count: number,
  rand: () => number,
): BenchmarkScenarioResult {
  const sampled = sample(
    files.filter((f) => f.symbol_count > 0),
    count,
    rand,
  );
  const details = sampled.map((f) => {
    const bl = estimateTokens(f.byte_length);
    const tm = estimateTokens(f.signature_total || Math.round(f.byte_length * 0.1));
    return {
      query: f.path,
      file: f.path,
      baseline_tokens: bl,
      trace_mcp_tokens: tm,
      reduction_pct: reductionPct(bl, tm),
    };
  });
  return buildScenario(
    'file_exploration',
    'Understand file structure (baseline: read entire file)',
    details,
  );
}

function benchmarkSearch(
  symbols: SymbolInfo[],
  count: number,
  rand: () => number,
): BenchmarkScenarioResult {
  const sampled = sample(symbols, count, rand);
  const details = sampled.map((s) => {
    const grepChars = 5 * 20 * 80; // ~5 matches, 20 lines context, 80 chars/line
    const bl = estimateTokens(grepChars);
    const tm = Math.round(bl * 0.35);
    return {
      query: s.name,
      file: s.file_path,
      baseline_tokens: bl,
      trace_mcp_tokens: tm,
      reduction_pct: reductionPct(bl, tm),
    };
  });
  return buildScenario(
    'search',
    'Find code by text query (baseline: grep output with context)',
    details,
  );
}

function benchmarkImpactAnalysis(
  store: Store,
  symbols: SymbolInfo[],
  count: number,
  rand: () => number,
): BenchmarkScenarioResult {
  const sampled = sample(
    symbols.filter((s) => s.kind === 'function' || s.kind === 'class'),
    count,
    rand,
  );
  const details = sampled.map((s) => {
    // Find dependents via incoming edges
    const nodeRow = store.db
      .prepare(
        'SELECT n.id FROM nodes n JOIN symbols sym ON n.ref_id = sym.id AND n.node_type = ? WHERE sym.symbol_id = ?',
      )
      .get('symbol', s.symbol_id) as { id: number } | undefined;

    let depFileBytes = 0;
    if (nodeRow) {
      const deps = store.db
        .prepare(`
        SELECT DISTINCT f.byte_length FROM edges e
        JOIN nodes n2 ON e.source_node_id = n2.id AND n2.node_type = 'symbol'
        JOIN symbols s2 ON n2.ref_id = s2.id
        JOIN files f ON s2.file_id = f.id
        WHERE e.target_node_id = ?
        LIMIT 10
      `)
        .all(nodeRow.id) as { byte_length: number }[];
      depFileBytes = deps.reduce((sum, d) => sum + (d.byte_length || 0), 0);
    }

    const bl = estimateTokens(depFileBytes || s.file_byte_length * 3);
    const tm = estimateTokens(Math.round((depFileBytes || s.file_byte_length * 3) * 0.05));
    return {
      query: s.name,
      file: s.file_path,
      baseline_tokens: bl,
      trace_mcp_tokens: tm,
      reduction_pct: reductionPct(bl, tm),
    };
  });
  return buildScenario(
    'impact_analysis',
    'What breaks if I change X (baseline: read all dependent files)',
    details,
  );
}

function benchmarkCallGraph(
  store: Store,
  symbols: SymbolInfo[],
  count: number,
  rand: () => number,
): BenchmarkScenarioResult {
  const funcs = symbols.filter((s) => s.kind === 'function' || s.kind === 'method');
  const sampled = sample(funcs, count, rand);
  const details = sampled.map((s) => {
    const nodeRow = store.db
      .prepare(
        'SELECT n.id FROM nodes n JOIN symbols sym ON n.ref_id = sym.id AND n.node_type = ? WHERE sym.symbol_id = ?',
      )
      .get('symbol', s.symbol_id) as { id: number } | undefined;

    let relatedBytes = 0;
    if (nodeRow) {
      const related = store.db
        .prepare(`
        SELECT DISTINCT f.byte_length FROM (
          SELECT source_node_id AS nid FROM edges WHERE target_node_id = ?
          UNION
          SELECT target_node_id AS nid FROM edges WHERE source_node_id = ?
        ) r
        JOIN nodes n2 ON r.nid = n2.id AND n2.node_type = 'symbol'
        JOIN symbols s2 ON n2.ref_id = s2.id
        JOIN files f ON s2.file_id = f.id
        LIMIT 15
      `)
        .all(nodeRow.id, nodeRow.id) as { byte_length: number }[];
      relatedBytes = related.reduce((sum, d) => sum + (d.byte_length || 0), 0);
    }

    const bl = estimateTokens(relatedBytes || s.file_byte_length * 4);
    const tm = estimateTokens(Math.round((relatedBytes || s.file_byte_length * 4) * 0.06));
    return {
      query: s.name,
      file: s.file_path,
      baseline_tokens: bl,
      trace_mcp_tokens: tm,
      reduction_pct: reductionPct(bl, tm),
    };
  });
  return buildScenario(
    'call_graph',
    'Trace call graph (baseline: read all caller/callee files)',
    details,
  );
}

function benchmarkTaskContext(
  store: Store,
  symbols: SymbolInfo[],
  files: FileInfo[],
  count: number,
  rand: () => number,
): BenchmarkScenarioResult {
  const sampled = sample(
    symbols.filter((s) => s.kind === 'function' || s.kind === 'class'),
    count,
    rand,
  );
  const details = sampled.map((s) => {
    // Baseline: agent does search (600 tokens) + get_symbol × 3 (2400) + Read × 3 full files (3 files avg)
    // + Grep × 2 (1600 tokens) + get_outline × 2 (2400 tokens) ≈ 10 sequential calls
    const nodeRow = store.db
      .prepare(
        'SELECT n.id FROM nodes n JOIN symbols sym ON n.ref_id = sym.id AND n.node_type = ? WHERE sym.symbol_id = ?',
      )
      .get('symbol', s.symbol_id) as { id: number } | undefined;

    let relatedFileBytes = 0;
    let relatedFileCount = 0;
    if (nodeRow) {
      const related = store.db
        .prepare(`
        SELECT DISTINCT f.byte_length FROM (
          SELECT source_node_id AS nid FROM edges WHERE target_node_id = ?
          UNION
          SELECT target_node_id AS nid FROM edges WHERE source_node_id = ?
        ) r
        JOIN nodes n2 ON r.nid = n2.id AND n2.node_type = 'symbol'
        JOIN symbols s2 ON n2.ref_id = s2.id
        JOIN files f ON s2.file_id = f.id
        LIMIT 10
      `)
        .all(nodeRow.id, nodeRow.id) as { byte_length: number }[];
      relatedFileBytes = related.reduce((sum, d) => sum + (d.byte_length || 0), 0);
      relatedFileCount = related.length;
    }

    // Baseline: reading the target file + up to 5 related files + grep overhead
    const targetFileBytes = s.file_byte_length;
    const additionalFiles = Math.min(relatedFileCount, 5);
    const avgRelatedSize =
      relatedFileCount > 0 ? relatedFileBytes / relatedFileCount : s.file_byte_length;
    const totalReadBytes = targetFileBytes + additionalFiles * avgRelatedSize;
    const grepOverhead = 2 * 5 * 20 * 80; // 2 grep calls × 5 matches × 20 lines × 80 chars
    const bl = estimateTokens(totalReadBytes + grepOverhead);

    // trace-mcp: get_task_context returns curated symbols within token budget (~8000 default)
    // Actual response is ~10-15% of what manual exploration would yield
    const tm = estimateTokens(Math.round(totalReadBytes * 0.08));
    return {
      query: `task: understand ${s.name}`,
      file: s.file_path,
      baseline_tokens: bl,
      trace_mcp_tokens: tm,
      reduction_pct: reductionPct(bl, tm),
    };
  });
  return buildScenario(
    'composite_task',
    'NL task → optimal code context (baseline: search + read 5-8 files + grep)',
    details,
  );
}

function benchmarkFindUsages(
  store: Store,
  symbols: SymbolInfo[],
  count: number,
  rand: () => number,
): BenchmarkScenarioResult {
  const sampled = sample(
    symbols.filter((s) => s.kind === 'function' || s.kind === 'method'),
    count,
    rand,
  );
  const details = sampled.map((s) => {
    // Baseline: grep for symbol name across project → raw line matches with context
    // Typically 5-15 matches × 5 lines context × 80 chars/line
    const grepMatches = 10;
    const grepContextLines = 5;
    const grepChars = grepMatches * grepContextLines * 80;
    const bl = estimateTokens(grepChars);
    // trace-mcp: find_usages returns semantic refs (import, call, render, dispatch) — compact JSON
    // ~20 chars per usage entry (file + line + kind)
    const tm = estimateTokens(grepMatches * 60); // structured usage: file, line, kind, context snippet
    return {
      query: s.name,
      file: s.file_path,
      baseline_tokens: bl,
      trace_mcp_tokens: tm,
      reduction_pct: reductionPct(bl, tm),
    };
  });
  return buildScenario(
    'find_usages',
    'All usages of a symbol (baseline: grep with context lines)',
    details,
  );
}

function benchmarkContextBundle(
  store: Store,
  symbols: SymbolInfo[],
  count: number,
  rand: () => number,
): BenchmarkScenarioResult {
  // Scenario: need 3 related symbols + their imports (typical get_context_bundle batch)
  const funcs = symbols.filter((s) => s.kind === 'function' || s.kind === 'method');
  const batchSize = 3;
  const batches = Math.min(count, Math.floor(funcs.length / batchSize));
  const sampled = sample(funcs, batches * batchSize, rand);
  const details: BenchmarkScenarioResult['details'] = [];

  for (let i = 0; i < batches; i++) {
    const group = sampled.slice(i * batchSize, (i + 1) * batchSize);
    // Baseline: 3 × get_symbol calls (each returns full source) + each file's imports read separately
    // Average: symbol source + 200 chars of import lines per symbol, but files may overlap
    const totalSourceBytes = group.reduce(
      (s, sym) => s + (sym.source_bytes || Math.round(sym.file_byte_length * 0.08)),
      0,
    );
    const importOverhead = group.length * 200; // import lines read from each file
    // Baseline also includes per-call _hints overhead (~120 tokens per call)
    const perCallHintsOverhead = group.length * 120;
    const bl = estimateTokens(totalSourceBytes + importOverhead) + perCallHintsOverhead;
    // trace-mcp: get_context_bundle deduplicates shared imports, packs within token budget
    // Budget redistribution reclaims empty category allocations (callers/typeContext often empty)
    // File read cache avoids re-reading same file for multiple symbols
    // Lazy source: only top-N deps get full source, rest get signature-only
    // Shared imports from same module are deduplicated
    // Effective reduction: ~55% of raw content + no per-call hints overhead
    const tm = estimateTokens(Math.round((totalSourceBytes + importOverhead) * 0.45));
    const names = group.map((g) => g.name).join(', ');
    details.push({
      query: names,
      file: group[0].file_path,
      baseline_tokens: bl,
      trace_mcp_tokens: tm,
      reduction_pct: reductionPct(bl, tm),
    });
  }

  return buildScenario(
    'context_bundle',
    'Batch symbol+imports lookup (baseline: N × get_symbol + Read imports)',
    details,
  );
}

function benchmarkBatchOverhead(
  symbols: SymbolInfo[],
  files: FileInfo[],
  count: number,
  rand: () => number,
): BenchmarkScenarioResult {
  // Scenario: 3 independent queries that could be batched
  // Batch saves per-call JSON overhead + MCP round-trip framing + per-call metadata
  const batchSize = 3;
  const batches = Math.min(count, Math.floor(symbols.length / batchSize));
  const sampledSymbols = sample(symbols, batches * batchSize, rand);
  const details: BenchmarkScenarioResult['details'] = [];

  for (let i = 0; i < batches; i++) {
    const group = sampledSymbols.slice(i * batchSize, (i + 1) * batchSize);
    // Each independent call has overhead from:
    // - MCP framing: tool_use block + result wrapper (~150 tokens)
    // - _hints array per result (~120 tokens with 3 hints)
    // - _optimization_hint / _budget_warning (~40 tokens when present)
    const perCallFramingOverhead = 150;
    const perCallHintsOverhead = 120;
    const perCallMetadataOverhead = 40;
    const perCallOverhead = perCallFramingOverhead + perCallHintsOverhead + perCallMetadataOverhead;
    const contentTokens = group.reduce((s, sym) => s + estimateTokens(sym.source_bytes || 200), 0);
    const bl = contentTokens + batchSize * perCallOverhead; // 3 separate calls
    // Batch: 1 framing overhead, _hints/_optimization_hint stripped from sub-results
    const tm = contentTokens + perCallFramingOverhead; // 1 batch call, no per-result metadata
    const names = group.map((g) => g.name).join(', ');
    details.push({
      query: names,
      file: group[0].file_path,
      baseline_tokens: bl,
      trace_mcp_tokens: tm,
      reduction_pct: reductionPct(bl, tm),
    });
  }

  return buildScenario(
    'batch_overhead',
    'N independent queries batched (baseline: N separate MCP round-trips)',
    details,
  );
}

function benchmarkTypeHierarchy(
  store: Store,
  symbols: SymbolInfo[],
  count: number,
  rand: () => number,
): BenchmarkScenarioResult {
  const types = symbols.filter((s) => s.kind === 'interface' || s.kind === 'class');
  const sampled = sample(types, count, rand);
  const details = sampled.map((s) => {
    // Baseline: grep "implements InterfaceName" or "extends ClassName" + read each implementing file
    // Find implementors via edges
    const nodeRow = store.db
      .prepare(
        'SELECT n.id FROM nodes n JOIN symbols sym ON n.ref_id = sym.id AND n.node_type = ? WHERE sym.symbol_id = ?',
      )
      .get('symbol', s.symbol_id) as { id: number } | undefined;

    let implFileBytes = 0;
    let implCount = 0;
    if (nodeRow) {
      const impls = store.db
        .prepare(`
        SELECT DISTINCT f.byte_length FROM edges e
        JOIN edge_types et ON e.edge_type_id = et.id
        JOIN nodes n2 ON e.source_node_id = n2.id AND n2.node_type = 'symbol'
        JOIN symbols s2 ON n2.ref_id = s2.id
        JOIN files f ON s2.file_id = f.id
        WHERE e.target_node_id = ?
          AND et.name IN ('implements', 'extends')
        LIMIT 10
      `)
        .all(nodeRow.id) as { byte_length: number }[];
      implFileBytes = impls.reduce((sum, d) => sum + (d.byte_length || 0), 0);
      implCount = impls.length;
    }

    // Baseline: grep output (matches across files) + reading each implementor file
    const grepChars = Math.max(implCount, 3) * 5 * 80; // grep matches
    const readChars = implFileBytes || s.file_byte_length * 3;
    const bl = estimateTokens(grepChars + readChars);
    // trace-mcp: returns compact hierarchy tree with signatures only
    const tm = estimateTokens(Math.max(implCount, 3) * 120); // ~120 chars per implementor (signature + file + line)
    return {
      query: s.name,
      file: s.file_path,
      baseline_tokens: bl,
      trace_mcp_tokens: tm,
      reduction_pct: reductionPct(bl, tm),
    };
  });
  return buildScenario(
    'type_hierarchy',
    'Find all implementations of interface/class (baseline: grep + read files)',
    details,
  );
}

function benchmarkTestsFor(
  store: Store,
  symbols: SymbolInfo[],
  count: number,
  rand: () => number,
): BenchmarkScenarioResult {
  const sampled = sample(
    symbols.filter((s) => s.kind === 'function' || s.kind === 'method'),
    count,
    rand,
  );
  const details = sampled.map((s) => {
    // Baseline: glob("*.test.*", "*.spec.*") + grep(symbolName) in test files + read matched test files
    // Typical: glob returns list (200 tokens) + grep matches in 2-3 test files (2400 tokens) + read 2 test files (4000 tokens)
    const globTokens = 200;
    // BEFORE: divided chars by 3.5 directly here while everywhere else used
    // estimateTokens() (which Math.ceil-rounds and follows the calibrated ratio).
    // This produced inconsistent fractional tokens. AFTER: route through
    // estimateTokens() so the tokenizer-calibration logic applies uniformly.
    const grepTokens = estimateTokens(3 * 5 * 80); // 3 files × 5 matches × 80 chars
    const testFileReadTokens = 2 * estimateTokens(3000); // 2 test files × ~3KB avg
    const bl = globTokens + grepTokens + testFileReadTokens;
    // trace-mcp: get_tests_for returns only relevant test blocks with assertions
    const tm = estimateTokens(400); // compact: test name + file + line + assertion summary
    return {
      query: s.name,
      file: s.file_path,
      baseline_tokens: bl,
      trace_mcp_tokens: tm,
      reduction_pct: reductionPct(bl, tm),
    };
  });
  return buildScenario(
    'tests_for',
    'Find tests for a symbol (baseline: glob + grep + read test files)',
    details,
  );
}

/** Run all scenarios once with a given rng. Pulled out so we can multi-sample. */
function runScenariosOnce(
  store: Store,
  symbols: SymbolInfo[],
  files: FileInfo[],
  n: number,
  rand: () => number,
): BenchmarkScenarioResult[] {
  return [
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
}

export function runBenchmark(
  store: Store,
  opts: {
    queries?: number;
    seed?: number;
    projectName?: string;
    frameworks?: string[];
    /**
     * Number of seed-shifted re-runs to average over. Default 5.
     *
     * BEFORE: each scenario ran once and the single reduction_pct was reported
     * as if it were an exact figure. AFTER: we re-roll the sampling seed
     * `samples` times, compute reduction_pct per run, and report mean / stddev / p95
     * in `reduction_stats`. Detail rows still come from the first run for shape
     * compatibility.
     */
    samples?: number;
    /**
     * Calibrate the chars-per-token ratio against a real tokenizer (gpt-tokenizer,
     * cl100k_base) before estimating. Default true. Setting false uses the
     * documented default ratio without attempting tokenizer import.
     */
    calibrateTokenizer?: boolean;
  } = {},
): BenchmarkResult {
  const n = opts.queries ?? 10;
  const seed = opts.seed ?? 42;
  const samples = Math.max(1, Math.min(opts.samples ?? 5, 20));

  // Calibrate tokenizer synchronously-ish: we awaited it for tests via the
  // dedicated test helper. For production runs we attempt calibration lazily on
  // the first call and cache the result; subsequent runs in the same process
  // reuse it. We deliberately use a fire-and-forget import here because this is
  // a CLI/tool path and not blocking the event loop is more important than
  // first-run calibration accuracy.
  if (opts.calibrateTokenizer !== false && !TOKENIZER_CALIBRATED) {
    // We attempt sync require via dynamic import; if it has not resolved by the
    // time we compute tokens we fall through with the default ratio. Tests use
    // calibrateTokenizerForTests() to guarantee state.
    void tryCalibrateTokenizer();
  }

  const symbols = loadSymbols(store);
  const files = loadFiles(store);

  // Primary run — its detail rows are what we surface for stable output shape.
  const primary = runScenariosOnce(store, symbols, files, n, seededRandom(seed));

  // Re-roll for variance. Use seed + i so reproducible.
  const perScenarioReductions: number[][] = primary.map((s) => [s.reduction_pct]);
  for (let i = 1; i < samples; i++) {
    const reroll = runScenariosOnce(store, symbols, files, n, seededRandom(seed + i * 1000003));
    reroll.forEach((sc, idx) => {
      perScenarioReductions[idx].push(sc.reduction_pct);
    });
  }

  const scenarios: BenchmarkScenarioResult[] = primary.map((sc, idx) => ({
    ...sc,
    reduction_stats: buildStats(perScenarioReductions[idx]),
  }));

  const totalQueries = scenarios.reduce((s, sc) => s + sc.queries, 0);
  const totalBaseline = scenarios.reduce((s, sc) => s + sc.baseline_tokens, 0);
  const totalCompact = scenarios.reduce((s, sc) => s + sc.trace_mcp_tokens, 0);
  const savedPerQuery = totalQueries > 0 ? (totalBaseline - totalCompact) / totalQueries : 0;

  const costSaved: Record<string, string> = {};
  for (const [model, price] of Object.entries(MODEL_PRICING)) {
    costSaved[model] = `$${(savedPerQuery * price).toFixed(4)}`;
  }

  // Aggregate dispersion across scenarios — gives readers a single "how noisy
  // are these numbers?" signal alongside the totals line.
  const allReductions = scenarios.map((s) => s.reduction_pct);

  const accuracy: BenchmarkAccuracy = {
    kind: 'synthetic-estimator',
    chars_per_token: Math.round(CALIBRATED_CHARS_PER_TOKEN * 100) / 100,
    tokenizer_calibrated: TOKENIZER_CALIBRATED,
    samples,
    caveats: [
      'Baseline is computed from file byte_length stored in the index, not a fresh disk read.',
      'trace-mcp side uses fixed per-scenario multipliers, not real tool invocations.',
      'Token counts are estimates; calibrated against cl100k_base when gpt-tokenizer is available.',
      'reduction_pct is a single-run figure; see reduction_stats for cross-sample dispersion.',
    ],
  };

  return {
    project: opts.projectName ?? 'unknown',
    index_stats: {
      files: files.length,
      symbols: symbols.length,
      frameworks: opts.frameworks ?? [],
    },
    scenarios,
    totals: {
      total_queries: totalQueries,
      baseline_tokens: totalBaseline,
      trace_mcp_tokens: totalCompact,
      reduction_pct: reductionPct(totalBaseline, totalCompact),
      reduction_stats: buildStats(allReductions),
      estimated_cost_saved_per_query: costSaved,
    },
    methodology:
      `SYNTHETIC ESTIMATOR. Baseline = file byte_length from index. trace-mcp side = fixed ` +
      `per-scenario multipliers (NOT real tool calls). Token estimate: chars/${accuracy.chars_per_token.toFixed(2)} ` +
      `${TOKENIZER_CALIBRATED ? '(calibrated via gpt-tokenizer cl100k_base)' : '(default heuristic; install gpt-tokenizer for calibration)'}. ` +
      `Samples: ${samples}. Seed: ${seed}.`,
    accuracy,
  };
}

export function formatBenchmarkMarkdown(result: BenchmarkResult): string {
  const lines: string[] = [];
  lines.push('## trace-mcp Token Efficiency Benchmark');
  lines.push('');
  lines.push(
    `Project: ${result.project} (${result.index_stats.files.toLocaleString()} files, ${result.index_stats.symbols.toLocaleString()} symbols)`,
  );
  if (result.index_stats.frameworks.length > 0) {
    lines.push(`Frameworks: ${result.index_stats.frameworks.join(', ')}`);
  }
  lines.push('');
  // Surface the methodology kind so readers don't read this as a measured number.
  lines.push(
    `> Synthetic estimator. Tokens via chars/${result.accuracy.chars_per_token.toFixed(2)} ` +
      `${result.accuracy.tokenizer_calibrated ? '(calibrated)' : '(uncalibrated heuristic)'}. ` +
      `${result.accuracy.samples} samples per scenario.`,
  );
  lines.push('');
  lines.push(
    '| Scenario | Queries | Baseline tokens | trace-mcp tokens | Reduction | ± stddev | p95 |',
  );
  lines.push(
    '|----------|---------|-----------------|------------------|-----------|----------|-----|',
  );
  for (const s of result.scenarios) {
    const stats = s.reduction_stats;
    const stddevPart = stats ? `±${stats.stddev.toFixed(1)}%` : 'n/a';
    const p95Part = stats ? `${stats.p95.toFixed(1)}%` : 'n/a';
    lines.push(
      `| ${s.name} | ${s.queries} | ${s.baseline_tokens.toLocaleString()} | ${s.trace_mcp_tokens.toLocaleString()} | ${s.reduction_pct}% | ${stddevPart} | ${p95Part} |`,
    );
  }
  const totStats = result.totals.reduction_stats;
  const totStddev = totStats ? `±${totStats.stddev.toFixed(1)}%` : 'n/a';
  const totP95 = totStats ? `${totStats.p95.toFixed(1)}%` : 'n/a';
  lines.push(
    `| **Total** | **${result.totals.total_queries}** | **${result.totals.baseline_tokens.toLocaleString()}** | **${result.totals.trace_mcp_tokens.toLocaleString()}** | **${result.totals.reduction_pct}%** | **${totStddev}** | **${totP95}** |`,
  );
  lines.push('');
  const models = Object.entries(result.totals.estimated_cost_saved_per_query);
  if (models.length > 0) {
    lines.push(`Estimated savings per query: ${models.map(([m, v]) => `${v} (${m})`).join(', ')}`);
  }
  lines.push('');
  lines.push('Caveats:');
  for (const c of result.accuracy.caveats) {
    lines.push(`- ${c}`);
  }
  return lines.join('\n');
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function projectLabel(project: string): string {
  if (!project || project === 'unknown') return 'this project';
  const parts = project.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || project;
}

/**
 * Share-friendly summary card. Designed to be paste-able into Slack, GitHub
 * issues, X, HN comments — surfaces the recomputation-leak headline, top
 * hotspots, and a one-line CTA so the report itself is a growth loop.
 */
export function formatBenchmarkShareReport(result: BenchmarkResult): string {
  const wasted = result.totals.baseline_tokens - result.totals.trace_mcp_tokens;
  const sonnetPrice = MODEL_PRICING['claude-sonnet-4-6'] ?? 3.0 / 1_000_000;
  const wastedDollars = wasted * sonnetPrice;
  const opusPrice = MODEL_PRICING['claude-opus-4-6'] ?? 5.0 / 1_000_000;
  const wastedDollarsOpus = wasted * opusPrice;

  const top = [...result.scenarios]
    .sort(
      (a, b) => b.baseline_tokens - b.trace_mcp_tokens - (a.baseline_tokens - a.trace_mcp_tokens),
    )
    .slice(0, 3);

  const bar = '━'.repeat(56);
  const lines: string[] = [];
  lines.push(bar);
  lines.push(` trace-mcp benchmark · ${projectLabel(result.project)}`);
  lines.push(bar);
  lines.push('');
  lines.push(' Estimated token waste in this codebase:');
  lines.push(
    `   ~${formatTokens(wasted)} tokens per benchmark run · ~$${wastedDollars.toFixed(2)} (Sonnet) / ~$${wastedDollarsOpus.toFixed(2)} (Opus)`,
  );
  const totStats = result.totals.reduction_stats;
  if (totStats) {
    lines.push(`   ± stddev ${totStats.stddev.toFixed(1)}% across ${totStats.samples} samples`);
  }
  lines.push('');
  lines.push(` trace-mcp cuts this by ~${result.totals.reduction_pct}%:`);
  lines.push(
    `   ${formatTokens(result.totals.baseline_tokens)} → ${formatTokens(result.totals.trace_mcp_tokens)} tokens`,
  );
  lines.push(
    `   across ${result.index_stats.files.toLocaleString()} files / ${result.index_stats.symbols.toLocaleString()} symbols`,
  );
  lines.push('');
  if (top.length > 0) {
    lines.push(' Top recomputation hotspots:');
    top.forEach((s, i) => {
      const pct = `${s.reduction_pct.toFixed(1)}%`.padStart(6);
      const name = s.name.padEnd(20);
      lines.push(
        `   ${i + 1}. ${name} ${pct} saved   (${formatTokens(s.baseline_tokens)} → ${formatTokens(s.trace_mcp_tokens)})`,
      );
    });
    lines.push('');
  }
  lines.push(' Run on your own codebase:');
  lines.push('   npx trace-mcp benchmark .');
  lines.push('');
  lines.push(
    `   (synthetic estimator · chars/${result.accuracy.chars_per_token.toFixed(2)}${result.accuracy.tokenizer_calibrated ? ' calibrated' : ''} · ${result.accuracy.samples} samples)`,
  );
  lines.push('');
  lines.push(' trace-mcp.com · github.com/nikolai-vysotskyi/trace-mcp');
  lines.push(bar);
  return lines.join('\n');
}
