/**
 * Confidence scoring for live agent-written decisions.
 *
 * Used by the `remember_decision` MCP tool to map a DecisionInput-shaped
 * payload to a `confidence` in [0,1]. The score routes the row through the
 * existing memoir review queue:
 *   confidence >= review_threshold  -> auto-approved (visible by default)
 *   reject_threshold <= confidence  -> pending (review queue)
 *   confidence <  reject_threshold  -> dropped (not persisted)
 *
 * Heuristic is intentionally conservative: BASE=0.40 plus modest signal
 * weights means a decision with no code reference sits at 0.40 and gets
 * dropped under the default reject_threshold (0.45). Adding a symbol_id
 * or file_path is the cheapest way to push above the floor.
 *
 * P2.5 — when learned weights have been persisted to
 * `~/.trace-mcp/confidence_weights.json`, those override the fixed defaults.
 * The legacy fixed-weight path is still exported as `computeConfidenceLegacy`
 * so tests and the bootstrap path can keep deterministic behaviour.
 */
import fs from 'node:fs';
import {
  HIGH_SIGNAL_TYPES,
  type LearnedWeights,
  loadWeights,
  scoreWithWeights,
  WEIGHTS_PATH,
} from './confidence-tuner.js';
import type { DecisionInput } from './decision-types.js';

const BASE = 0.4;
const W_CODE_REF = 0.2; // symbol_id or file_path present
const W_LENGTH = 0.15; // content length >= 200 chars
const W_TAGS = 0.1; // tags array non-empty
const W_TYPE = 0.1; // high-signal type (architecture_decision | bug_root_cause)
const W_SERVICE = 0.05; // service_name populated

// Re-export so callers can keep importing the high-signal set from here.
export { HIGH_SIGNAL_TYPES };

type DecisionInputForScoring = Pick<
  DecisionInput,
  'title' | 'content' | 'type' | 'symbol_id' | 'file_path' | 'tags' | 'service_name'
>;

/**
 * Legacy fixed-weight scorer. Retained as a stable reference so unit tests
 * and the bootstrap path (before any review events accumulate) can score
 * decisions without depending on filesystem state.
 */
export function computeConfidenceLegacy(input: DecisionInputForScoring): number {
  let c = BASE;
  if (input.symbol_id || input.file_path) c += W_CODE_REF;
  if ((input.content?.length ?? 0) >= 200) c += W_LENGTH;
  if ((input.tags?.length ?? 0) > 0) c += W_TAGS;
  if (HIGH_SIGNAL_TYPES.has(input.type)) c += W_TYPE;
  if (input.service_name) c += W_SERVICE;
  return Math.max(0, Math.min(1, c));
}

// ─── Cached learned-weights loader ─────────────────────────────────
//
// Weight loads are cheap (small JSON, mtime check) but `computeConfidence`
// runs on every `remember_decision` call. Cache the parsed weights with an
// mtime-based refresh so a `tune_decision_weights` write is picked up by
// the next call without paying for a JSON parse per scoring.

const REFRESH_INTERVAL_MS = 60_000;

interface WeightsCache {
  weights: LearnedWeights;
  /** mtime (in ms) of the source file at load time. 0 when no file exists. */
  mtimeMs: number;
  /** Last time we checked disk — gates the mtime stat to once per minute. */
  lastCheckedMs: number;
}

let cache: WeightsCache | null = null;

/**
 * Runtime toggle for the learned-weights path. When false, every
 * `computeConfidence` call uses the legacy fixed-weight scorer regardless of
 * any persisted file. Server startup mirrors `memory.weight_tuning.enabled`
 * here so the existing config layer stays the single source of truth.
 */
let weightTuningEnabled = true;

export function setWeightTuningEnabled(enabled: boolean): void {
  weightTuningEnabled = enabled;
}

function statMtime(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function refreshCache(filePath: string): WeightsCache {
  const mtime = statMtime(filePath);
  const weights = loadWeights(filePath);
  return { weights, mtimeMs: mtime, lastCheckedMs: Date.now() };
}

function getCachedWeights(filePath: string = WEIGHTS_PATH): LearnedWeights {
  const now = Date.now();
  if (cache === null) {
    cache = refreshCache(filePath);
    return cache.weights;
  }
  if (now - cache.lastCheckedMs < REFRESH_INTERVAL_MS) {
    return cache.weights;
  }
  const mtime = statMtime(filePath);
  if (mtime !== cache.mtimeMs) {
    cache = refreshCache(filePath);
    return cache.weights;
  }
  cache.lastCheckedMs = now;
  return cache.weights;
}

/** Drop the cached weight set. Used by `tune_decision_weights` after writing
 *  new weights and by tests for isolation. */
export function resetCachedWeights(): void {
  cache = null;
}

function inputToSignals(input: DecisionInputForScoring) {
  return {
    has_code_ref: !!(input.symbol_id || input.file_path),
    content_length: input.content?.length ?? 0,
    tag_count: input.tags?.length ?? 0,
    type: input.type,
    has_service: !!input.service_name,
  };
}

/**
 * Compute confidence using whichever weight set is currently active. Falls
 * back to {@link DEFAULT_WEIGHTS} (= the same values as the legacy fixed
 * scorer) when no tuned file exists on disk.
 */
export function computeConfidence(input: DecisionInputForScoring): number {
  if (!weightTuningEnabled) return computeConfidenceLegacy(input);
  const weights = getCachedWeights();
  return scoreWithWeights(inputToSignals(input), weights);
}
