/**
 * Retriever protocol — cognee-inspired 3-step contract.
 *
 * ## Why this exists
 *
 * trace-mcp's retrieval surface is currently spread across many bespoke
 * functions (the `search` tool's fusion/fuzzy/semantic branches,
 * `get_feature_context`, `get_task_context`, `query_corpus`, `pack_context`).
 * Each rolls its own context assembly and ranking. The plan is to migrate
 * them onto a uniform protocol so:
 *
 *   1. Future search modes (P03) plug in by implementing one interface.
 *   2. Graph-completion (P12) can compose any retriever's output.
 *   3. The eval harness (P04) can swap retrievers without rewiring tools.
 *
 * ## Contract — three composable steps
 *
 * - `getContext(query)`     → assemble inputs needed for retrieval
 *                             (parse the query, compute an embedding,
 *                             load filter state, etc.). Pure data — no
 *                             ranking yet.
 * - `getCompletion(context)`→ produce ranked results from the context
 *                             (the actual retrieval call: FTS query,
 *                             vector NN, fusion pipeline, …).
 * - `getAnswer(results)`    → post-process the ranked list (rerank,
 *                             dedupe, trim to top-K, apply a similarity
 *                             threshold). May be identity.
 *
 * `Q` is the input query shape, `R` is the output result shape. Both are
 * generic so adapters can stay typed; the registry stores them as
 * `BaseRetriever<unknown, unknown>` and consumers narrow at the use site.
 *
 * ## Composition, not inheritance
 *
 * This is intentionally an `interface`, not a base class. Concrete
 * retrievers are plain objects (or class instances) that provide the
 * three methods. We do not ship a default `getResult()` helper — the
 * pipeline glue lives in `pipeline.ts` and is one function, easy to
 * read and easy to mock. The adapter pattern is the point: every
 * retriever DELEGATES to existing trace-mcp search functions; nothing
 * in `src/retrieval/` reimplements search logic.
 *
 * ## Adapters and the existing codebase
 *
 * - `LexicalRetriever` wraps `searchFts` from `src/db/fts.ts`.
 * - `SemanticRetriever` wraps the vector path on `VectorStore.search`
 *   from `src/ai/interfaces.ts`.
 *
 * Existing tool entry points (`search`, `get_feature_context`, …) are
 * INTENTIONALLY left untouched in this slice. They will migrate in a
 * follow-up plan once we have eval coverage proving equivalence.
 */

/**
 * A scored retrieval candidate. Kept intentionally light: source-specific
 * payloads ride along under `payload`, the rest of the pipeline only
 * cares about `id` (stable key for dedup) and `score` (sorting).
 */
export interface RetrievedItem<P = unknown> {
  /** Stable identifier — symbol_id, file path, decision id, etc. */
  id: string;
  /** Retriever-defined score. Higher is better. */
  score: number;
  /** Where this hit came from — useful for telemetry and debugging. */
  source: string;
  /** Source-specific payload (raw FTS row, vector hit, etc.). */
  payload: P;
}

/**
 * Output of the first step. A retriever's `getContext` produces enough
 * data for `getCompletion` to run without re-parsing the query.
 */
export interface RetrieverContext<C = unknown> {
  /** The original query, preserved for downstream telemetry. */
  query: unknown;
  /** Retriever-specific assembled state (terms, embedding, filters, …). */
  data: C;
}

/**
 * The 3-step retriever protocol. Generic over query type `Q` and result
 * type `R` so adapters can stay strictly typed while the registry holds
 * them as `BaseRetriever<unknown, unknown>`.
 *
 * Implementations MUST:
 *  - be pure-ish: same input → same output, modulo the underlying index.
 *  - never throw on empty results; return `[]` instead.
 *  - keep `getAnswer` cheap — it runs on every retrieval call.
 */
export interface BaseRetriever<Q = unknown, R = unknown> {
  /**
   * Human-readable name. Used by the registry and by telemetry.
   * Example: `"lexical"`, `"semantic"`.
   */
  readonly name: string;

  /** Step 1 — assemble whatever the retriever needs to perform retrieval. */
  getContext(query: Q): Promise<RetrieverContext<unknown>>;

  /** Step 2 — run the actual retrieval. Returns a scored, ranked list. */
  getCompletion(context: RetrieverContext<unknown>): Promise<R[]>;

  /** Step 3 — post-process (rerank / dedupe / trim). Often identity. */
  getAnswer(results: R[]): Promise<R[]>;
}

/**
 * Registry of named retrievers. NOT a global singleton — callers
 * construct an instance and pass it around. This keeps tests trivial
 * (each test gets its own registry, no global cleanup needed) and
 * avoids the cognee-style register-on-import side effects we want to
 * avoid in trace-mcp.
 */
export interface RetrieverRegistry {
  /** Register a retriever under a unique name. Throws on duplicate. */
  register(retriever: BaseRetriever<unknown, unknown>): void;
  /** Look up a retriever by name. Returns `undefined` if not registered. */
  get(name: string): BaseRetriever<unknown, unknown> | undefined;
  /** List the names of all registered retrievers, sorted. */
  list(): string[];
}

/**
 * The standard 3-step pipeline. Lifted out of `BaseRetriever` so it
 * stays a plain interface and so the orchestration is testable in
 * isolation. Equivalent to cognee's `BaseRetriever.get_completion`.
 */
export async function runRetriever<Q, R>(retriever: BaseRetriever<Q, R>, query: Q): Promise<R[]> {
  const ctx = await retriever.getContext(query);
  const completion = await retriever.getCompletion(ctx);
  return retriever.getAnswer(completion);
}
