/**
 * Confidence-weight learning (P2.5).
 *
 * Persists learned weights for the decision-confidence scorer at
 * `~/.trace-mcp/confidence_weights.json`. Fits via plain logistic regression
 * over accumulated review events (approve = label 1, reject = label 0). No ML
 * library deps — this dataset is O(100s) for the foreseeable future and a
 * hand-rolled gradient descent loop converges in milliseconds.
 *
 * The feature vector mirrors the fixed-weight scorer in
 * `src/memory/decision-confidence.ts` so a fitted weight set is a drop-in
 * replacement for the hand-tuned constants:
 *
 *   x = [1, has_code_ref?1:0, length>=200?1:0, tag_count>0?1:0,
 *        type_in_high_signal?1:0, has_service?1:0]
 *
 * Refuses to fit when there's too little signal (events < minEvents or all
 * labels are the same class) — degenerate fits would either drift weights to
 * extreme values or push every decision through one branch of the review
 * queue, which is worse than keeping the conservative defaults.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureGlobalDirs, TRACE_MCP_HOME } from '../global.js';
import { logger } from '../logger.js';
import { atomicWriteString } from '../utils/atomic-write.js';
import type { DecisionType } from './decision-store.js';

export const WEIGHTS_PATH = path.join(TRACE_MCP_HOME, 'confidence_weights.json');

/** High-signal types — must mirror HIGH_SIGNAL_TYPES in decision-confidence.ts. */
export const HIGH_SIGNAL_TYPES = new Set<string>(['architecture_decision', 'bug_root_cause']);

/** Per-feature clamp range — guards against runaway gradients on tiny datasets. */
const WEIGHT_MIN = -1;
const WEIGHT_MAX = 1.5;

export interface ConfidenceSignals {
  has_code_ref: boolean;
  /** Content length in characters. Binary-thresholded at >= 200 inside the scorer. */
  content_length: number;
  /** Tag count. Binary-thresholded at > 0 inside the scorer. */
  tag_count: number;
  type: string;
  has_service: boolean;
}

export interface LearnedWeights {
  /** Intercept; default 0.4 — matches BASE in the fixed-weight scorer. */
  base: number;
  /** symbol_id or file_path present; default 0.2. */
  codeRef: number;
  /** content length >= 200 chars; default 0.15. */
  length: number;
  /** tags array non-empty; default 0.1. */
  tags: number;
  /** high-signal type (architecture_decision | bug_root_cause); default 0.1. */
  typeHighSignal: number;
  /** service_name populated; default 0.05. */
  service: number;
  /** Per-type sparse bonus map. Reserved for future fits — unused by v1 fitter. */
  perType?: Partial<Record<DecisionType, number>>;
  /** Set by the tuner. */
  fitted_at?: string;
  /** Set by the tuner. */
  events_used?: number;
  /** Schema version — bump when fields change. */
  version: 1;
}

export const DEFAULT_WEIGHTS: LearnedWeights = {
  base: 0.4,
  codeRef: 0.2,
  length: 0.15,
  tags: 0.1,
  typeHighSignal: 0.1,
  service: 0.05,
  version: 1,
};

export interface TuneOptions {
  /** Minimum review events before tuning will run. Default 25. */
  minEvents?: number;
  /** Gradient descent iterations. Default 200. */
  iterations?: number;
  /** Learning rate. Default 0.1. */
  learningRate?: number;
  /** L2 regularisation strength. Default 0.01. */
  regularization?: number;
}

export interface TuneEvent {
  signals: ConfidenceSignals;
  /** 1 = approved, 0 = rejected. */
  label: 0 | 1;
  confidence_at_decision: number;
}

export interface TuneResult {
  ok: boolean;
  reason?: 'insufficient_events' | 'all_same_label' | 'fitted';
  events_used: number;
  weights?: LearnedWeights;
  before?: LearnedWeights;
  loss_before?: number;
  loss_after?: number;
}

/**
 * Build the binary feature vector that mirrors the fixed-weight scorer.
 * Index 0 is the bias term (always 1), the remaining slots are the
 * scorer's six boolean signals.
 */
function featureVector(signals: ConfidenceSignals): number[] {
  return [
    1,
    signals.has_code_ref ? 1 : 0,
    signals.content_length >= 200 ? 1 : 0,
    signals.tag_count > 0 ? 1 : 0,
    HIGH_SIGNAL_TYPES.has(signals.type) ? 1 : 0,
    signals.has_service ? 1 : 0,
  ];
}

function weightsToVector(w: LearnedWeights): number[] {
  return [w.base, w.codeRef, w.length, w.tags, w.typeHighSignal, w.service];
}

function vectorToWeights(v: number[], events_used: number): LearnedWeights {
  return {
    base: v[0],
    codeRef: v[1],
    length: v[2],
    tags: v[3],
    typeHighSignal: v[4],
    service: v[5],
    fitted_at: new Date().toISOString(),
    events_used,
    version: 1,
  };
}

function sigmoid(z: number): number {
  // Clamp extreme inputs so exp() can't overflow on very confident dot products.
  if (z >= 40) return 1;
  if (z <= -40) return 0;
  return 1 / (1 + Math.exp(-z));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Average per-event logistic loss. Used to surface a before/after delta in
 * TuneResult so callers can sanity-check that the fit actually moved.
 */
function logisticLoss(events: TuneEvent[], w: number[]): number {
  if (events.length === 0) return 0;
  let total = 0;
  for (const ev of events) {
    const x = featureVector(ev.signals);
    let z = 0;
    for (let i = 0; i < w.length; i++) z += w[i] * x[i];
    const p = sigmoid(z);
    // Standard binary cross-entropy with a tiny epsilon so log(0) is safe.
    const eps = 1e-12;
    total += -(ev.label * Math.log(p + eps) + (1 - ev.label) * Math.log(1 - p + eps));
  }
  return total / events.length;
}

/**
 * Fit logistic regression over the review events. Returns the new weight set
 * or `ok: false` with a structured reason when the input is too noisy to fit.
 */
export function tuneConfidenceWeights(
  events: TuneEvent[],
  current: LearnedWeights,
  opts: TuneOptions = {},
): TuneResult {
  const minEvents = opts.minEvents ?? 25;
  const iterations = opts.iterations ?? 200;
  const lr = opts.learningRate ?? 0.1;
  const lambda = opts.regularization ?? 0.01;

  if (events.length < minEvents) {
    return { ok: false, reason: 'insufficient_events', events_used: events.length };
  }

  // Guard against all-same-label inputs — the gradient still moves but the
  // resulting weights would push every future decision into the dominant
  // branch, which is exactly the failure mode we're trying to avoid.
  const anyApprove = events.some((e) => e.label === 1);
  const anyReject = events.some((e) => e.label === 0);
  if (!anyApprove || !anyReject) {
    return { ok: false, reason: 'all_same_label', events_used: events.length };
  }

  const startVec = weightsToVector(current);
  const w = [...startVec];
  const n = events.length;
  const dim = w.length;

  for (let iter = 0; iter < iterations; iter++) {
    const grad = new Array<number>(dim).fill(0);
    for (const ev of events) {
      const x = featureVector(ev.signals);
      let z = 0;
      for (let i = 0; i < dim; i++) z += w[i] * x[i];
      const err = sigmoid(z) - ev.label;
      for (let i = 0; i < dim; i++) grad[i] += err * x[i];
    }
    // Average over batch + L2 (skip bias from regularization, index 0).
    for (let i = 0; i < dim; i++) {
      grad[i] = grad[i] / n + (i === 0 ? 0 : lambda * w[i]);
      w[i] -= lr * grad[i];
    }
  }

  // Clamp to sane bounds — protects against runaway gradients on tiny / noisy
  // datasets and keeps the resulting confidence inside [0, 1] for typical inputs.
  for (let i = 0; i < dim; i++) w[i] = clamp(w[i], WEIGHT_MIN, WEIGHT_MAX);

  const loss_before = logisticLoss(events, startVec);
  const loss_after = logisticLoss(events, w);
  const fitted = vectorToWeights(w, events.length);

  return {
    ok: true,
    reason: 'fitted',
    events_used: events.length,
    weights: fitted,
    before: current,
    loss_before,
    loss_after,
  };
}

/**
 * Compute a confidence score using a learned weight set. Mirrors
 * `computeConfidence` but parameterises every weight. Clamps the output
 * to [0, 1] so downstream `classifyConfidence` always sees a valid score.
 */
export function scoreWithWeights(signals: ConfidenceSignals, weights: LearnedWeights): number {
  let c = weights.base;
  if (signals.has_code_ref) c += weights.codeRef;
  if (signals.content_length >= 200) c += weights.length;
  if (signals.tag_count > 0) c += weights.tags;
  if (HIGH_SIGNAL_TYPES.has(signals.type)) c += weights.typeHighSignal;
  if (signals.has_service) c += weights.service;
  if (weights.perType) {
    const bonus = weights.perType[signals.type as DecisionType];
    if (typeof bonus === 'number') c += bonus;
  }
  return clamp(c, 0, 1);
}

/**
 * Read learned weights from disk. Returns DEFAULT_WEIGHTS when the file is
 * missing, malformed, or pinned at an unknown schema version. Never throws —
 * callers always get a usable weight set.
 */
export function loadWeights(filePath: string = WEIGHTS_PATH): LearnedWeights {
  try {
    if (!fs.existsSync(filePath)) return DEFAULT_WEIGHTS;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1) return DEFAULT_WEIGHTS;
    // Shallow shape check — every numeric slot must be present and finite.
    const required: Array<keyof LearnedWeights> = [
      'base',
      'codeRef',
      'length',
      'tags',
      'typeHighSignal',
      'service',
    ];
    for (const k of required) {
      if (typeof parsed[k] !== 'number' || !Number.isFinite(parsed[k])) return DEFAULT_WEIGHTS;
    }
    return parsed as LearnedWeights;
  } catch (e) {
    logger.warn({ error: e, filePath }, 'confidence_weights.json read failed');
    return DEFAULT_WEIGHTS;
  }
}

/** Atomic write of the learned weights to disk. */
export function saveWeights(w: LearnedWeights, filePath: string = WEIGHTS_PATH): void {
  ensureGlobalDirs();
  atomicWriteString(filePath, JSON.stringify(w, null, 2));
}
