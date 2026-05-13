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

const SYMBOL_PATTERNS = [
  /^[a-z][a-zA-Z0-9]*$/, // camelCase
  /^[A-Z][a-zA-Z0-9]*$/, // PascalCase
  /^[a-z][a-z0-9_]*$/, // snake_case
  /^[A-Z][A-Z0-9_]*$/, // SCREAMING_SNAKE
  /^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*)+$/, // dotted FQN
];

/**
 * Pure-function classifier. Exported so the unit test can pin the
 * routing rules without standing up a retriever pair.
 */
export function classifyQuery(text: string): 'lexical' | 'hybrid' | 'empty' {
  const trimmed = text.trim();
  if (!trimmed) return 'empty';
  // Anything with whitespace is a phrase / question → hybrid.
  if (/\s/.test(trimmed)) return 'hybrid';
  // Match against the symbol-shape allow-list.
  for (const re of SYMBOL_PATTERNS) {
    if (re.test(trimmed)) return 'lexical';
  }
  return 'hybrid';
}

export class FeelingLuckyRetriever implements BaseRetriever<FeelingLuckyQuery, FeelingLuckyResult> {
  readonly name = 'feeling_lucky';

  constructor(
    private readonly lexical: BaseRetriever<LexicalQuery, LexicalResult>,
    private readonly hybrid: BaseRetriever<HybridQuery, HybridResult>,
  ) {}

  async getContext(query: FeelingLuckyQuery): Promise<RetrieverContext<FeelingLuckyCtx>> {
    const text = (query.text ?? '').trim();
    const classification = classifyQuery(text);
    const route = classification === 'lexical' ? 'lexical' : 'hybrid';
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
): FeelingLuckyRetriever {
  return new FeelingLuckyRetriever(lexical, hybrid);
}
