/**
 * Type definitions for the code-intelligence eval harness (P04 vertical slice).
 *
 * Scope: this file defines the data contracts for the slice. The full v1 plan
 * (`plans/plan-cognee-P04-eval-harness.md`) describes a richer surface
 * (benchmark adapters, rubric metrics, baseline diffing). The vertical slice
 * keeps the surface intentionally small: a flat list of cases with an
 * "expected" target set, scored by precision@K + MRR.
 *
 * Out of scope here (deferred to P04 v2):
 *   - fixture-project loading
 *   - tool-pluggable `invoke` per benchmark
 *   - `--baseline <git-ref>` diffing
 *   - HTML dashboards
 */

/**
 * A single benchmark case. The harness runs trace-mcp's `search` against
 * `query` (with the supplied filters) and checks whether the resulting
 * `RetrievalItem.file` paths intersect `expected_files`.
 *
 * Symbol-level grounding can come later; file-level is robust enough for
 * the slice because:
 *   - The harness runs against a *known* repository (trace-mcp itself).
 *   - A search that returns the wrong file is unambiguously wrong, even if
 *     the result happens to be from the same module.
 */
export interface BenchmarkCase {
  /** Stable identifier, used in the report rollup. */
  id: string;
  /** Short human description. */
  description: string;
  /** Natural-language or lexical query handed to trace-mcp `search`. */
  query: string;
  /**
   * Files whose presence in the top-K results counts as a hit. At least one
   * file must be listed. The first listed file is treated as the "primary"
   * target for MRR purposes (rank of the first match wins).
   *
   * Paths are repo-relative POSIX paths.
   */
  expected_files: string[];
  /**
   * Optional filters forwarded to `search`. Kept minimal — we only support
   * the filters trace-mcp `search` accepts as plain strings.
   */
  filters?: {
    kind?: string;
    language?: string;
    filePattern?: string;
  };
}

/**
 * Top-level benchmark dataset. Loaded from JSON; the loader validates the
 * shape via `BenchmarkDatasetSchema` in `datasets/loader.ts`.
 */
export interface BenchmarkDataset {
  /** Dataset slug; matches the JSON filename without extension. */
  id: string;
  /** Short human description shown in the CLI header. */
  description: string;
  /**
   * Project root the dataset is calibrated against. The slice ships a single
   * dataset calibrated against this repository, but the field is kept so a
   * future dataset can ship its own fixture project.
   */
  project_root: '.' | string;
  /** Cases evaluated by the runner. */
  cases: BenchmarkCase[];
}

/**
 * Numeric metric attached to a single case. `details` is a free-form bag
 * used by metric implementations to surface diagnostic info.
 */
export interface MetricResult {
  name: string;
  value: number;
  details?: Record<string, unknown>;
}

/**
 * Top-K result row recorded for a single case. Captured verbatim from the
 * search response so reports can show the rejected candidates the searcher
 * returned, not just the score.
 */
export interface CaseResultItem {
  rank: number;
  symbol_id: string;
  name: string;
  kind: string;
  file: string;
  score: number;
}

/**
 * Outcome of evaluating one case.
 */
export interface CaseResult {
  case_id: string;
  query: string;
  expected_files: string[];
  /** Top-K items the searcher returned. */
  results: CaseResultItem[];
  /** Per-case metrics computed from `results`. */
  metrics: MetricResult[];
  /** Wall-clock for the `search` call (ms). */
  latency_ms: number;
  /**
   * Convenience field: the 1-indexed rank where the first expected file was
   * found, or null if no expected file appeared in top-K. Used directly by
   * MRR and for the human-readable report.
   */
  first_hit_rank: number | null;
}

/**
 * Aggregate metric across all cases — mean, min, max, count.
 */
export interface MetricRollup {
  metric: string;
  mean: number;
  min: number;
  max: number;
  n: number;
}

/**
 * Final report emitted by `BenchmarkRunner.run`.
 */
export interface BenchmarkReport {
  dataset_id: string;
  dataset_description: string;
  ran_at: string;
  duration_ms: number;
  k: number;
  total_cases: number;
  /** Per-case results in dataset order. */
  cases: CaseResult[];
  /** Aggregate stats keyed by metric name (precision@k, mrr, first_hit_rank). */
  rollup: MetricRollup[];
}
