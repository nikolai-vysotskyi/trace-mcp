/**
 * Shared confidence classification helpers for analytical tools.
 *
 * Tools that combine multiple independent signals (dead code, bug prediction,
 * antipattern detection, risk hotspots) all expose two layers:
 *
 *   1. A numeric `score` (the existing per-tool semantics: 0..1, count, etc.)
 *   2. A `confidence_level` string telling consumers how many independent
 *      signals actually agree, which is what should drive automation decisions.
 *
 * Plus an optional `_methodology` block on the result envelope, so callers
 * can read exactly how the score was produced and what its limitations are.
 */

export type ConfidenceLevel = 'low' | 'medium' | 'high' | 'multi_signal';

export interface Methodology {
  /** Short identifier for the algorithm used. */
  algorithm: string;
  /** Human-readable list of independent signals combined to produce the score. */
  signals: string[];
  /** Plain-language description of how the score / level is derived. */
  confidence_formula: string;
  /** Known limitations and false-positive sources. */
  limitations: string[];
}

/**
 * Map a count of independent agreeing signals (and the maximum possible) to a
 * categorical confidence level. Tools should pass the count of signals that
 * actually fired, not the raw score.
 *
 *   1 signal               → low
 *   2 signals              → medium
 *   3 signals (max ≤ 3)    → multi_signal
 *   3 signals (max  > 3)   → high
 *   ≥ 4 signals            → multi_signal
 */
export function classifyConfidence(signalsFired: number, maxSignals: number): ConfidenceLevel {
  if (signalsFired <= 0) return 'low';
  if (signalsFired >= 4) return 'multi_signal';
  if (signalsFired === 3) return maxSignals <= 3 ? 'multi_signal' : 'high';
  if (signalsFired === 2) return 'medium';
  return 'low';
}

/**
 * Classify a single numeric confidence (0..1) from a single-detector tool into
 * a categorical level. Use this for findings that come from one detector
 * (antipattern rules, code smells, security scanners) where there is no notion
 * of multiple independent signals agreeing.
 *
 *   < 0.40 → low
 *   < 0.75 → medium
 *   ≥ 0.75 → high
 */
export function classifyNumericConfidence(value: number): ConfidenceLevel {
  if (value < 0.4) return 'low';
  if (value < 0.75) return 'medium';
  return 'high';
}

// ─── Per-tool methodology constants ──────────────────────────────────────────

export const CALL_GRAPH_METHODOLOGY: Methodology = {
  algorithm: 'index_call_graph',
  signals: [
    'import edges extracted from AST by language plugins',
    'explicit call references tracked during symbol indexing',
    'LSP call hierarchy resolution (when lsp.enabled, for supported languages)',
  ],
  confidence_formula:
    'Tier-based: lsp_resolved (compiler-grade) > ast_resolved (static AST) > ' +
    'ast_inferred (heuristic) > text_matched (name similarity). ' +
    'Dynamic dispatch resolved when LSP enabled; otherwise limited to static AST.',
  limitations: [
    'LSP resolution requires lsp.enabled and language server installed',
    'dynamic dispatch resolved only with LSP; AST-only misses polymorphism',
    'higher-order function calls may be missing without LSP',
    'accuracy depends on language plugin AST pass completeness',
    'stale if index has not been refreshed since last edit',
  ],
};

export const CHANGE_IMPACT_METHODOLOGY: Methodology = {
  algorithm: 'reverse_dependency_graph_bfs',
  signals: [
    'static import/export edges from the dependency graph',
    'co-change pairs from git history (temporal coupling)',
    'breaking-change detection via exported-symbol comparison',
  ],
  confidence_formula:
    'medium — BFS over reverse dependency edges gives the static blast radius; ' +
    'co-change couplings add hidden runtime coupling. Dynamic requires/imports ' +
    'and runtime DI bindings are not traced.',
  limitations: [
    'dynamic require() / import() calls not resolved',
    'runtime dependency injection bindings not traversed',
    'transitive depth capped — very deep chains may be truncated',
    'co-change signal requires git history; absent in fresh repos',
  ],
};

export const GIT_CHURN_METHODOLOGY: Methodology = {
  algorithm: 'git_log_file_stats',
  signals: [
    'commit count per file from git log --follow',
    'unique author count per file',
    'first-seen and last-modified timestamps',
  ],
  confidence_formula:
    'high — derived directly from git history, which is ground truth for change frequency. ' +
    'Volatility buckets: stable (≤1 commit/week), active (≤3), volatile (>3).',
  limitations: [
    'requires git history; returns empty on non-git repos',
    'file renames tracked via --follow but may break on complex rename chains',
    'binary files counted but not semantically meaningful',
  ],
};

export const COMPLEXITY_METHODOLOGY: Methodology = {
  algorithm: 'stored_ast_metrics',
  signals: [
    'cyclomatic complexity computed from AST branch count during indexing',
    'max nesting depth from AST node depth traversal',
    'parameter count from function signature AST node',
  ],
  confidence_formula:
    'medium — metrics are accurate for the indexed snapshot but may be stale ' +
    'if the file was edited after the last reindex. Cyclomatic = 1 + decision points ' +
    '(if/else/loop/catch/ternary/&&/||).',
  limitations: [
    'stale if file modified after last reindex — run register_edit or reindex to refresh',
    'language plugin must support complexity extraction; unsupported languages return null',
    'cyclomatic does not capture cognitive complexity (nesting weight)',
  ],
};
