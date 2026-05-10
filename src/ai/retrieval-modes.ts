/**
 * Memoir-style tiered retrieval modes for `search` and `gatherContext`.
 *
 * Provides five explicit retrieval strategies so callers (especially the agent)
 * can pick the right precision/cost tradeoff:
 *
 * - `single` — current default behavior, one shot, top-K returned (BC).
 * - `tiered` — return results stratified by relevance buckets (high/medium/low),
 *              with explicit bucket labels in the response. Caller can show only
 *              the high tier or expand.
 * - `drill`  — given a previous result-set's top hit (or an explicit
 *              `parent_path` / `parent_symbol_id`), return only results within
 *              that subtree. Iterative deepening.
 * - `flat`   — no ranking buckets, no PageRank weighting, just raw FTS hits.
 *              Cheapest. For "I just want grep semantics".
 * - `get`    — exact-path lookup only. No search at all. If `query` looks like
 *              a path/symbol_id, return that one item or empty.
 *
 * The default mode is `single` so behavior is unchanged for current callers.
 */

/** Identifier for the active retrieval strategy. */
export type RetrievalMode = 'single' | 'tiered' | 'drill' | 'flat' | 'get';

/** All modes as a literal tuple — re-use for zod enums and CLI choices. */
export const RETRIEVAL_MODES = ['single', 'tiered', 'drill', 'flat', 'get'] as const;

/** Type guard: narrow an arbitrary string to a `RetrievalMode`. */
export function isRetrievalMode(value: unknown): value is RetrievalMode {
  return typeof value === 'string' && (RETRIEVAL_MODES as readonly string[]).includes(value);
}

/** Hint for `selectRetrievalMode` — overrides the default heuristic. */
export interface RetrievalModeHint {
  /** Prefer a particular mode unless the query shape contradicts it. */
  prefer?: RetrievalMode;
  /** Explicit drill scope — when present, `selectRetrievalMode` returns `drill`. */
  drillFrom?: string;
}

/**
 * Heuristic check: does `query` look like a file path or a symbol_id?
 * - Symbol IDs in trace-mcp are typically `<lang>:<path>:<line>:<col>:<name>`
 *   — they contain colons and forward slashes and rarely whitespace.
 * - File paths contain `/` or end with a known code extension and have no
 *   spaces (`src/foo/bar.ts`, `app/Http/Controllers/UserController.php`).
 *
 * The heuristic is conservative — when in doubt it returns `false` so that
 * the query falls back to a normal search.
 */
export function isPathShapedQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  // Whitespace anywhere → almost certainly natural language, not a path.
  if (/\s/.test(trimmed)) return false;
  // Symbol IDs use multiple colons (lang:path:line:col:name).
  if (trimmed.includes(':') && trimmed.split(':').length >= 3) return true;
  // Path-shaped: contains slash AND no exotic characters.
  if (trimmed.includes('/')) return true;
  // File extension on a single token (e.g. "store.ts" — leaf-only path).
  if (/\.[a-zA-Z][a-zA-Z0-9]{0,5}$/.test(trimmed) && !trimmed.endsWith('.')) return true;
  return false;
}

/**
 * Pick a sensible default mode for a given query + hint.
 *
 * Resolution order:
 *   1. `hint.drillFrom` present → `drill`
 *   2. `hint.prefer` present and not contradicted → use it
 *   3. Path-shaped query → `get`
 *   4. Otherwise → `single`
 */
export function selectRetrievalMode(query: string, hint?: RetrievalModeHint): RetrievalMode {
  if (hint?.drillFrom) return 'drill';
  if (hint?.prefer) {
    // If the caller explicitly asks for `get` but the query is clearly NL,
    // honor the request anyway — `get` will simply return empty, which is the
    // documented contract. We only override `prefer` when nothing was asked.
    return hint.prefer;
  }
  if (isPathShapedQuery(query)) return 'get';
  return 'single';
}

// ---------------------------------------------------------------------------
// Per-mode result shapes
// ---------------------------------------------------------------------------

/** A single search hit projected to AI-useful fields. */
export interface RetrievalItem {
  symbol_id: string;
  name: string;
  kind: string;
  fqn: string | null;
  file: string;
  line: number | null;
  score: number;
}

/** Result for `single` mode — flat top-K list (matches existing `search`). */
export interface SingleModeResult {
  mode: 'single';
  items: RetrievalItem[];
  total: number;
}

/** Buckets for `tiered` mode. The exact slicing is documented inline. */
export interface TieredBuckets {
  /** Top 3 — strongest matches. */
  high: RetrievalItem[];
  /** Next 7 — confident but secondary. */
  medium: RetrievalItem[];
  /** Next 15 — weak / contextual. */
  low: RetrievalItem[];
}

export interface TieredModeResult {
  mode: 'tiered';
  buckets: TieredBuckets;
  total: number;
}

/** Result for `drill` mode — only items within the requested subtree. */
export interface DrillModeResult {
  mode: 'drill';
  parent: string;
  items: RetrievalItem[];
  total: number;
}

/** Result for `flat` mode — raw FTS hits, unranked beyond BM25. */
export interface FlatModeResult {
  mode: 'flat';
  items: RetrievalItem[];
  total: number;
}

/** Result for `get` mode — exact lookup, 0 or 1 item. */
export interface GetModeResult {
  mode: 'get';
  item: RetrievalItem | null;
}

/** Discriminated union: all per-mode results. */
export type RetrievalResult =
  | SingleModeResult
  | TieredModeResult
  | DrillModeResult
  | FlatModeResult
  | GetModeResult;

/**
 * Default bucket sizes for `tiered` mode. Exposed so callers (CLI, MCP tool
 * description) can describe the contract without hard-coding magic numbers.
 */
export const TIERED_BUCKET_SIZES = {
  high: 3,
  medium: 7,
  low: 15,
} as const;

/**
 * Slice a flat ranked list into tiered buckets using `TIERED_BUCKET_SIZES`.
 * The list is consumed in order: the top items become `high`, the next slice
 * becomes `medium`, and the remaining (up to the low cap) becomes `low`.
 */
export function bucketize(items: RetrievalItem[]): TieredBuckets {
  const high = items.slice(0, TIERED_BUCKET_SIZES.high);
  const medium = items.slice(
    TIERED_BUCKET_SIZES.high,
    TIERED_BUCKET_SIZES.high + TIERED_BUCKET_SIZES.medium,
  );
  const low = items.slice(
    TIERED_BUCKET_SIZES.high + TIERED_BUCKET_SIZES.medium,
    TIERED_BUCKET_SIZES.high + TIERED_BUCKET_SIZES.medium + TIERED_BUCKET_SIZES.low,
  );
  return { high, medium, low };
}

/**
 * Limit needed to fully populate all tiered buckets. Callers performing a
 * `tiered` retrieval should request at least this many results from the
 * underlying ranker so each bucket has a chance to fill.
 */
export const TIERED_TOTAL_LIMIT =
  TIERED_BUCKET_SIZES.high + TIERED_BUCKET_SIZES.medium + TIERED_BUCKET_SIZES.low;
