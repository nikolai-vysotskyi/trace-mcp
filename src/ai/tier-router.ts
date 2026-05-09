/**
 * Inference-tier router.
 *
 * Each `AIProvider` exposes two model tiers:
 *
 *   - `inference()`     "smart"  — synthesis, Q&A over long contexts,
 *                                  multi-step reasoning. Anthropic Sonnet,
 *                                  OpenAI gpt-4o, Gemini 2.5 Pro, …
 *   - `fastInference()` "fast"   — low-stakes work that runs many times
 *                                  per session (rerankers, file/symbol
 *                                  summarisation, classification).
 *                                  Anthropic Haiku, OpenAI gpt-4o-mini,
 *                                  Gemini 2.5 Flash, Llama 3.1 8B, …
 *
 * `pickInferenceTier(provider, hint)` makes the tier choice explicit so
 * callsites don't have to remember which is which. Heavy heuristics live
 * here, not at every callsite.
 *
 * Inspired by claude-mem v11.0 ("Tier Routing by Queue Complexity") which
 * inspected pending-queue complexity and routed simple tool-only work to
 * Haiku for ~52% cost reduction. We do the same with an explicit complexity
 * hint passed by the caller — there's no observation queue to inspect, but
 * the call sites know what they're spending on.
 */

import type { AIProvider, InferenceService } from './interfaces.js';

/**
 * Caller's hint about the work being dispatched. Use the most specific
 * label that fits — heuristics may demote `medium` to `fast` later when
 * we add token-budget signals, so over-specifying now never hurts.
 */
export type ComplexityHint =
  /** Single sentence in / single sentence out. Reranking, classification,
   *  yes/no questions, micro-summaries. */
  | 'trivial'
  /** Short paragraph in / short paragraph out. File summarisation,
   *  function purpose, simple rewrites. */
  | 'low'
  /** Multi-paragraph or short document. Code review, refactor proposals,
   *  decision extraction. */
  | 'medium'
  /** Long document or multi-step reasoning. Q&A over a corpus, plan
   *  synthesis, architectural narrative. */
  | 'high';

const FAST_TIER: ReadonlySet<ComplexityHint> = new Set(['trivial', 'low']);

/**
 * Returns the inference service the caller should use for the given
 * complexity. Default is `inference()` (smart tier) — we only downshift
 * when the caller explicitly says the work is low-stakes.
 *
 * Future: incorporate `quotaBreaker` state so we degrade smart→fast when
 * the smart tier is in cooldown rather than failing the call. Out of
 * scope for the initial cut.
 */
export function pickInferenceTier(
  provider: AIProvider,
  hint: ComplexityHint = 'medium',
): InferenceService {
  if (FAST_TIER.has(hint)) return provider.fastInference();
  return provider.inference();
}

/**
 * Pure variant for testing / explaining a routing decision without
 * touching the provider.
 */
export function pickInferenceTierName(hint: ComplexityHint = 'medium'): 'fast' | 'smart' {
  return FAST_TIER.has(hint) ? 'fast' : 'smart';
}
