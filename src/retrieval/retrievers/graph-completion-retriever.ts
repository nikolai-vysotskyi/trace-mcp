/**
 * Graph-completion retriever — cognee's signature retrieval pattern.
 *
 * ## What this is
 *
 * Vertical slice of plan-cognee-P12: given a natural-language query, find
 * top-K seed symbols via the existing lexical (BM25/FTS) path, then expand
 * each seed by 1 hop through the dependency graph to surface high-value
 * neighbours (callees / callers / imports / implementors / etc.).
 *
 * This retriever is a **pure adapter** — it composes two existing pieces:
 *   - `LexicalRetriever` (P01) for seed discovery
 *   - `traverseGraph` (`src/tools/analysis/traverse-graph.ts:167`) for the
 *     1-hop neighbourhood walk
 *
 * No new graph algorithm, no new SQL beyond what the helper already exposes.
 *
 * ## Output shape
 *
 * Each `GraphCompletionResult.payload` carries:
 *   - `symbol_id`     — stable graph id (mirrors `RetrievedItem.id`)
 *   - `name`          — display name
 *   - `file`          — repo-relative path (best-effort; '' for file nodes)
 *   - `line`          — first line of the symbol (null when unavailable)
 *   - `provenance`    — 'seed' (came from lexical hit) | 'expanded' (1-hop)
 *   - `seed_id`       — for expanded items, which seed they were reached from
 *
 * ## Score-blend math
 *
 * For each seed we keep `score_seed = lexical.score` (BM25 sign-flipped to
 * "higher is better", as set up by P01's LexicalRetriever).
 *
 * For each 1-hop neighbour we compute:
 *
 *     score_expanded = score_seed * EXPANSION_PENALTY
 *
 * with `EXPANSION_PENALTY = 0.5`. This is the simplest defensible blend:
 *   - neighbours always rank below their seed,
 *   - hub neighbours reached from multiple seeds get the **highest** seed's
 *     blended score (see dedup below),
 *   - the constant 0.5 is borrowed from cognee's `triplet_distance_penalty`
 *     family (see plan P12 §Design) collapsed for 1-hop; richer
 *     `exp(-distance / penalty)` is deferred until we measure utility past
 *     1 hop (see "Out of scope" in the IMPL report).
 *
 * ## Dedup strategy
 *
 * The output may contain the same symbol once as a seed and again as an
 * expanded neighbour, or as expanded from two different seeds. We dedupe
 * by `symbol_id`, **keeping the best score**:
 *   1. Seed-with-seed: collapse (shouldn't happen — LexicalRetriever
 *      already returns unique symbol_ids — but defensive).
 *   2. Seed-then-expanded: keep the seed (provenance wins over score
 *      since `score_seed > score_seed * 0.5`).
 *   3. Expanded-then-expanded: keep the highest blended score; record
 *      which seed produced it.
 *
 * ## Out of scope for this slice
 *
 * - Registering as an MCP tool (P03 owns the mode registry wire-in).
 * - `hop_limit > 1` — we stop at 1 hop until we measure value past that.
 * - LLM completion step from cognee — that's a follow-up; for now the
 *   retriever surfaces a ranked symbol list, not a prose answer.
 * - Cross-language graph walks — we use whatever the existing helper
 *   already supports (it's edge-type agnostic).
 */
import type { Store } from '../../db/store.js';
import type { TraverseNode } from '../../tools/analysis/traverse-graph.js';
import { traverseGraph } from '../../tools/analysis/traverse-graph.js';
import { LexicalRetriever } from './lexical-retriever.js';
import type { BaseRetriever, RetrievedItem, RetrieverContext } from '../types.js';
import { runRetriever } from '../types.js';

/** Knobs accepted at the query boundary. */
export interface GraphCompletionQuery {
  /** Raw user query — forwarded to the lexical seed retriever. */
  query: string;
  /** How many seed symbols to fetch via lexical search. Default 5. */
  seed_k?: number;
  /**
   * Graph traversal depth. Default 1.
   *
   * `hop_limit === 0` is a degenerate mode that skips expansion entirely
   * and behaves as a thin proxy for `LexicalRetriever`. Useful for
   * eval/CI to A/B the expansion contribution.
   *
   * Values greater than 1 are accepted by the underlying walker but the
   * blend math only models a single hop (P12 follow-up territory).
   */
  hop_limit?: number;
  /**
   * Cap on neighbours kept per seed after walking. Default 5.
   *
   * The traversal helper itself has a `max_nodes` budget; this cap is
   * applied to the post-traversal neighbour list to keep the response
   * shape predictable when a single seed has many outgoing edges.
   */
  expand_per_seed?: number;
}

/** Payload describing a single graph-completion hit. */
export interface GraphCompletionPayload {
  symbol_id: string;
  name: string;
  file: string;
  line: number | null;
  provenance: 'seed' | 'expanded';
  /** Set on expanded items — which seed produced the hop. */
  seed_id?: string;
}

export type GraphCompletionResult = RetrievedItem<GraphCompletionPayload>;

/** Internal context: what `getCompletion` needs. */
interface GraphCompletionCtx {
  query: string;
  seed_k: number;
  hop_limit: number;
  expand_per_seed: number;
}

/** Per-hop score multiplier — see "Score-blend math" in the file header. */
const EXPANSION_PENALTY = 0.5;
/** Default seed count if the caller doesn't specify. */
const DEFAULT_SEED_K = 5;
/** Default expansion fan-out per seed. */
const DEFAULT_EXPAND_PER_SEED = 5;
/** Default hop limit — 1 hop in the dependency graph. */
const DEFAULT_HOP_LIMIT = 1;

export class GraphCompletionRetriever
  implements BaseRetriever<GraphCompletionQuery, GraphCompletionResult>
{
  readonly name = 'graph_completion';

  private readonly lexical: LexicalRetriever;

  constructor(private readonly store: Store) {
    this.lexical = new LexicalRetriever(store);
  }

  async getContext(query: GraphCompletionQuery): Promise<RetrieverContext<GraphCompletionCtx>> {
    const text = (query.query ?? '').trim();
    return {
      query,
      data: {
        query: text,
        seed_k: query.seed_k ?? DEFAULT_SEED_K,
        hop_limit: query.hop_limit ?? DEFAULT_HOP_LIMIT,
        expand_per_seed: query.expand_per_seed ?? DEFAULT_EXPAND_PER_SEED,
      },
    };
  }

  async getCompletion(context: RetrieverContext<unknown>): Promise<GraphCompletionResult[]> {
    const ctx = context.data as GraphCompletionCtx;
    if (!ctx.query) return [];

    // Step A — Seed discovery via the existing lexical adapter.
    const seedItems = await runRetriever(this.lexical, {
      text: ctx.query,
      limit: ctx.seed_k,
    });
    if (seedItems.length === 0) return [];

    // Build the seed payload up front so we can look up enrichment data
    // (file path, line number) without re-querying for each expansion.
    const seedResults: GraphCompletionResult[] = seedItems.map((item) => ({
      id: item.id,
      score: item.score,
      source: 'graph_completion:seed',
      payload: {
        symbol_id: item.id,
        name: item.payload.name,
        file: this.lookupFilePath(item.payload.fileId),
        line: this.lookupLineStart(item.id),
        provenance: 'seed',
      },
    }));

    // Hop-limit zero — degenerate to LexicalRetriever output.
    if (ctx.hop_limit <= 0) return seedResults;

    // Step B — For each seed, walk 1 hop outgoing in the dependency graph
    // and collect up to `expand_per_seed` neighbours.
    const expansions: GraphCompletionResult[] = [];
    for (const seed of seedResults) {
      const walk = traverseGraph(this.store, {
        start_symbol_id: seed.payload.symbol_id,
        direction: 'outgoing',
        max_depth: ctx.hop_limit,
        // Allow a little headroom over the cap so we have something to
        // trim by score; the +1 accounts for the seed itself which the
        // walker always emits at depth 0.
        max_nodes: ctx.expand_per_seed + 1,
      });
      if (!walk) continue;

      const neighbours = walk.nodes
        .filter((n: TraverseNode) => n.depth > 0 && n.kind === 'symbol')
        .slice(0, ctx.expand_per_seed);

      for (const n of neighbours) {
        expansions.push({
          id: n.id,
          score: seed.score * EXPANSION_PENALTY,
          source: 'graph_completion:expanded',
          payload: {
            symbol_id: n.id,
            name: n.name,
            file: this.lookupFilePathForSymbolId(n.id),
            line: this.lookupLineStart(n.id),
            provenance: 'expanded',
            seed_id: seed.payload.symbol_id,
          },
        });
      }
    }

    return [...seedResults, ...expansions];
  }

  async getAnswer(results: GraphCompletionResult[]): Promise<GraphCompletionResult[]> {
    // Dedupe by symbol_id, keeping the best score. Seeds win ties over
    // expansions because seeds always have the higher pre-blend score.
    const best = new Map<string, GraphCompletionResult>();
    for (const r of results) {
      const prev = best.get(r.id);
      if (!prev || r.score > prev.score) {
        best.set(r.id, r);
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score);
  }

  // ---- enrichment helpers --------------------------------------------------

  private lookupFilePath(fileId: number): string {
    const row = this.store.getFileById(fileId);
    return row?.path ?? '';
  }

  private lookupFilePathForSymbolId(symbolId: string): string {
    const sym = this.store.getSymbolBySymbolId(symbolId);
    if (!sym) return '';
    return this.lookupFilePath(sym.file_id);
  }

  private lookupLineStart(symbolId: string): number | null {
    const sym = this.store.getSymbolBySymbolId(symbolId);
    return sym?.line_start ?? null;
  }
}

/** Factory — keeps `register()` call sites short. */
export function createGraphCompletionRetriever(store: Store): GraphCompletionRetriever {
  return new GraphCompletionRetriever(store);
}
