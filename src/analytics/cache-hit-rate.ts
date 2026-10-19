/**
 * Prompt-cache hit rate computation, provider family classification,
 * baselines, and regression scoping (TRA-1681).
 *
 * Blended prompt-cache hit rate is misleading when mixed local-model
 * sessions (e.g. Qwen via MLX/Antigravity) run alongside Claude sessions:
 * Claude sessions routinely hit ~98% cache reuse, while local providers
 * may hit ~30%. Reporting only the blend produces false regression alarms
 * or masks Claude-side regressions behind local-model volume.
 */

export type CacheProviderFamily = 'anthropic' | 'local' | 'other';

export interface CacheHitRateTokens {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
}

export interface CacheHitRateBreakdown {
  blended: number;
  by_model: Record<string, number>;
  by_provider: Record<string, number>;
}

/** 92.7% Opus baseline from 2026-08-27. */
export const CLAUDE_CACHE_HIT_BASELINE = 0.927;

/**
 * ~30% baseline on Qwen-MLX sample (n=3 sessions, TRA-1680).
 * Flagged as a small sample — re-measure as local dataset grows.
 */
export const LOCAL_CACHE_HIT_BASELINE = 0.3;

/**
 * Computes prompt-cache hit rate: cache_read / (input + cache_read + cache_create).
 * Returns 0 if total prompt tokens is 0.
 */
export function computeCacheHitRate(tokens: CacheHitRateTokens): number {
  const read = tokens.cacheReadTokens ?? 0;
  const input = tokens.inputTokens ?? 0;
  const create = tokens.cacheCreateTokens ?? 0;
  const total = input + read + create;
  if (total <= 0) return 0;
  return Math.round((read / total) * 10000) / 10000;
}

/**
 * Classifies model identifier into provider family:
 * - claude / opus / sonnet / haiku / anthropic -> 'anthropic'
 * - qwen / mlx / llama / ollama / antigravity / local -> 'local'
 * - other -> 'other'
 */
export function classifyCacheProviderFamily(model: string | null | undefined): CacheProviderFamily {
  if (!model) return 'other';
  const m = model.toLowerCase();
  if (/claude|opus|sonnet|haiku|anthropic/.test(m)) {
    return 'anthropic';
  }
  if (/qwen|mlx|llama|ollama|antigravity|local/.test(m)) {
    return 'local';
  }
  return 'other';
}

/**
 * Scoped cache hit-rate regression guard.
 * Compares rate against family-specific baseline with tolerance.
 * Accepts either a provider family ('anthropic' | 'local' | 'other')
 * or a model name string (which is automatically classified into its family).
 */
export function isCacheRegression(
  modelOrFamily: CacheProviderFamily | string,
  rate: number,
  tolerance = 0.05,
): boolean {
  const family =
    modelOrFamily === 'anthropic' || modelOrFamily === 'local' || modelOrFamily === 'other'
      ? (modelOrFamily as CacheProviderFamily)
      : classifyCacheProviderFamily(modelOrFamily);
  if (family === 'anthropic') {
    return rate < CLAUDE_CACHE_HIT_BASELINE - tolerance;
  }
  if (family === 'local') {
    return rate < LOCAL_CACHE_HIT_BASELINE - tolerance;
  }
  return false;
}
