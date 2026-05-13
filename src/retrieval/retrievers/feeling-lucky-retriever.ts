/**
 * Feeling-Lucky retriever — heuristic auto-router.
 *
 * Routes each query to the most appropriate backing retriever based on
 * cheap, deterministic surface-form heuristics. The point is "ask in
 * natural shape, get the right kind of search" — no LLM call, no
 * embedding lookup, just a regex check.
 *
 * ## Routing rules
 *
 * A query is treated as an EXACT SYMBOL LOOKUP (→ lexical) when ALL hold:
 *   - no whitespace (single token)
 *   - no operators / punctuation other than `_`, `$`, or `.` (allow
 *     dotted FQNs like `Foo.bar` and underscored names like
 *     `snake_case_func`)
 *   - matches one of:
 *       camelCase           → `^[a-z][a-zA-Z0-9]*$`     e.g. authService
 *       PascalCase          → `^[A-Z][a-zA-Z0-9]*$`     e.g. AuthService
 *       snake_case          → `^[a-z][a-z0-9_]*$`       e.g. auth_service
 *       SCREAMING_SNAKE     → `^[A-Z][A-Z0-9_]*$`       e.g. MAX_RETRIES
 *       dotted path         → `^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*)+$`
 *
 * Everything else (multi-word phrases, questions, sentences with spaces
 * or punctuation, anything with `?`, `!`, etc.) → hybrid.
 *
 * Examples:
 *   "AuthService"            → lexical
 *   "validate_input"         → lexical
 *   "Foo.bar.baz"            → lexical
 *   "where does auth fail"   → hybrid
 *   "how to validate input"  → hybrid
 *   ""                       → []
 *
 * Step mapping:
 *   - getContext   → classify the query, choose a delegate
 *   - getCompletion→ run the chosen delegate's full pipeline
 *   - getAnswer    → identity (delegate already trimmed)
 */
import { logger } from '../../logger.js';
import { getGlobalTelemetrySink } from '../../telemetry/index.js';
import type { TelemetrySink } from '../../telemetry/index.js';
import type { BaseRetriever, RetrievedItem, RetrieverContext } from '../types.js';
import { runRetriever } from '../types.js';
import type { HybridQuery, HybridResult } from './hybrid-retriever.js';
import type { LexicalQuery, LexicalResult } from './lexical-retriever.js';

export interface FeelingLuckyQuery {
  /** Raw user query. */
  text: string;
  /** Top-K cap. Default 20. Forwarded to the chosen delegate. */
  limit?: number;
}

export interface FeelingLuckyHit {
  /** Which retriever was chosen — `"lexical"` or `"hybrid"`. */
  routedTo: 'lexical' | 'hybrid';
  /** Raw delegate result item. */
  raw: LexicalResult | HybridResult;
}

export type FeelingLuckyResult = RetrievedItem<FeelingLuckyHit>;

interface FeelingLuckyCtx {
  text: string;
  limit: number;
  route: 'lexical' | 'hybrid';
}

const DEFAULT_LIMIT = 20;

/**
 * Match reasons emitted to telemetry. Pins down which regex picked the
 * route so we can tune the rules from real-world distributions.
 *
 *   - camelcase / pascalcase / snake_case / screaming / dotted_fqn:
 *     symbol-shape patterns → lexical
 *   - phrase_fallback: query contained whitespace → hybrid
 *   - unmatched_token: single token that matched no symbol pattern → hybrid
 *   - empty: blank query (no route taken)
 */
export type RouteMatchReason =
  | 'camelcase'
  | 'pascalcase'
  | 'snake_case'
  | 'screaming'
  | 'dotted_fqn'
  | 'phrase_fallback'
  | 'unmatched_token'
  | 'empty';

const SYMBOL_PATTERNS: Array<{ reason: RouteMatchReason; re: RegExp }> = [
  { reason: 'camelcase', re: /^[a-z][a-zA-Z0-9]*$/ },
  { reason: 'pascalcase', re: /^[A-Z][a-zA-Z0-9]*$/ },
  { reason: 'snake_case', re: /^[a-z][a-z0-9_]*$/ },
  { reason: 'screaming', re: /^[A-Z][A-Z0-9_]*$/ },
  { reason: 'dotted_fqn', re: /^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*)+$/ },
];

/**
 * Detailed classifier — returns the route plus the rule that fired. Used
 * internally to feed the telemetry event without re-running the regex
 * chain. Exported for testing.
 */
export function classifyQueryDetailed(
  text: string,
): { route: 'lexical' | 'hybrid'; reason: RouteMatchReason } | { route: 'empty'; reason: 'empty' } {
  const trimmed = text.trim();
  if (!trimmed) return { route: 'empty', reason: 'empty' };
  // Anything with whitespace is a phrase / question → hybrid.
  if (/\s/.test(trimmed)) return { route: 'hybrid', reason: 'phrase_fallback' };
  // Match against the symbol-shape allow-list.
  for (const { reason, re } of SYMBOL_PATTERNS) {
    if (re.test(trimmed)) return { route: 'lexical', reason };
  }
  return { route: 'hybrid', reason: 'unmatched_token' };
}

/**
 * Pure-function classifier. Exported so the unit test can pin the
 * routing rules without standing up a retriever pair.
 */
export function classifyQuery(text: string): 'lexical' | 'hybrid' | 'empty' {
  return classifyQueryDetailed(text).route;
}

export class FeelingLuckyRetriever implements BaseRetriever<FeelingLuckyQuery, FeelingLuckyResult> {
  readonly name = 'feeling_lucky';

  constructor(
    private readonly lexical: BaseRetriever<LexicalQuery, LexicalResult>,
    private readonly hybrid: BaseRetriever<HybridQuery, HybridResult>,
    /**
     * Optional sink override — primarily for tests. Production defers to
     * the process-wide singleton (`getGlobalTelemetrySink()`).
     */
    private readonly sink?: TelemetrySink,
  ) {}

  async getContext(query: FeelingLuckyQuery): Promise<RetrieverContext<FeelingLuckyCtx>> {
    const text = (query.text ?? '').trim();
    const detail = classifyQueryDetailed(text);
    const route = detail.route === 'lexical' ? 'lexical' : 'hybrid';

    // Emit a one-shot routing event so production traffic feeds back
    // which heuristic branch fires for each shape. We intentionally
    // skip the empty-query case — there is no route and no work.
    // Privacy: never emit the literal query text. Length + token count
    // are sufficient for distribution analysis.
    if (detail.route !== 'empty' && text.length > 0) {
      const tokenCount = text.split(/\s+/).filter(Boolean).length;
      try {
        const sink = this.sink ?? getGlobalTelemetrySink();
        sink.emit('retrieval.feeling_lucky.routed', {
          route,
          match_reason: detail.reason,
          query_length: text.length,
          query_token_count: tokenCount,
        });
      } catch (err) {
        // Telemetry must NEVER break retrieval. Log at debug and swallow.
        logger.debug({ err }, 'retrieval.feeling_lucky.telemetry_emit_failed');
      }
    }

    return {
      query,
      data: {
        text,
        limit: query.limit ?? DEFAULT_LIMIT,
        route,
      },
    };
  }

  async getCompletion(context: RetrieverContext<unknown>): Promise<FeelingLuckyResult[]> {
    const ctx = context.data as FeelingLuckyCtx;
    if (!ctx.text) return [];

    if (ctx.route === 'lexical') {
      const out = await runRetriever(this.lexical, { text: ctx.text, limit: ctx.limit });
      return out.map((r) => ({
        id: r.id,
        score: r.score,
        source: 'feeling_lucky:lexical',
        payload: { routedTo: 'lexical', raw: r },
      }));
    }

    const out = await runRetriever(this.hybrid, { text: ctx.text, limit: ctx.limit });
    return out.map((r) => ({
      id: r.id,
      score: r.score,
      source: 'feeling_lucky:hybrid',
      payload: { routedTo: 'hybrid', raw: r },
    }));
  }

  async getAnswer(results: FeelingLuckyResult[]): Promise<FeelingLuckyResult[]> {
    // Delegate already capped; this is a pass-through.
    return results.slice(0, DEFAULT_LIMIT);
  }
}

/** Factory — keeps `register()` call sites short. */
export function createFeelingLuckyRetriever(
  lexical: BaseRetriever<LexicalQuery, LexicalResult>,
  hybrid: BaseRetriever<HybridQuery, HybridResult>,
  sink?: TelemetrySink,
): FeelingLuckyRetriever {
  return new FeelingLuckyRetriever(lexical, hybrid, sink);
}
