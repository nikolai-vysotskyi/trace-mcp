/**
 * Embedding-drift canary.
 *
 * The hosted embedding providers we depend on (OpenAI, Voyage, etc.) sometimes
 * silently swap underlying model weights without bumping the model name. This
 * causes hybrid retrieval to subtly degrade: vectors no longer compare against
 * each other consistently, and rankings drift.
 *
 * The detector pins a 16-string canary set on first capture, stores its
 * embeddings in `~/.trace-mcp/embedding-canary.json`, and on every subsequent
 * `check_embedding_drift` re-embeds the same strings and reports the maximum
 * cosine distance from the stored baseline. A distance above the configured
 * threshold (default 0.05) flags a likely silent provider change.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { EmbeddingService } from '../ai/interfaces.js';
import { ensureGlobalDirs, TRACE_MCP_HOME } from '../global.js';
import { logger } from '../logger.js';

export const CANARY_PATH = path.join(TRACE_MCP_HOME, 'embedding-canary.json');

/** Default 16-string canary. Mix of code-y, prose, and edge cases. Stable forever. */
export const CANARY_STRINGS: readonly string[] = Object.freeze([
  'user authentication flow',
  'database connection pool',
  'rate limit middleware',
  'parse JSON request body',
  'background job scheduler',
  'cache invalidation strategy',
  'OAuth 2.0 token refresh',
  'pagination with cursor',
  'feature flag rollout',
  'circuit breaker pattern',
  'graceful shutdown handler',
  'log structured events',
  'health check endpoint',
  'retry with exponential backoff',
  'dead letter queue',
  'distributed tracing',
]);

interface CanaryFile {
  version: 1;
  /** Provider id at capture time (e.g. "openai", "ollama"). Defensive — drift can be due to provider switch. */
  provider: string | null;
  /** Model id at capture time. */
  model: string | null;
  /** Canary strings, frozen at capture. */
  strings: string[];
  /** Per-string embedding vectors. */
  embeddings: number[][];
  captured_at: string;
}

export interface DriftReport {
  status: 'baseline_captured' | 'ok' | 'drift' | 'no_provider' | 'no_baseline';
  message: string;
  threshold?: number;
  /** Max cosine distance observed. */
  max_distance?: number;
  /** Mean cosine distance across all canary strings. */
  mean_distance?: number;
  /** Per-string distances (only when present). */
  per_string?: Array<{ text: string; distance: number }>;
  /** Provider/model identifiers at the time of the comparison. */
  current_provider?: string | null;
  current_model?: string | null;
  baseline_provider?: string | null;
  baseline_model?: string | null;
}

export interface CheckDriftOptions {
  /** Force a fresh baseline capture, overwriting any existing canary file. */
  capture?: boolean;
  /** Threshold (cosine distance, 0..2) above which we flag drift. Default 0.05. */
  threshold?: number;
  /** Override paths/IDs (used by tests). */
  filePath?: string;
  provider?: string | null;
  model?: string | null;
}

/**
 * Run the drift check. With `capture=true` (or no existing baseline) the
 * provider's current embeddings are written to disk as the new baseline.
 */
export async function checkEmbeddingDrift(
  embedding: EmbeddingService | null,
  opts: CheckDriftOptions = {},
): Promise<DriftReport> {
  if (!embedding) {
    return {
      status: 'no_provider',
      message:
        'No embedding service available. Configure ai.enabled = true and a provider with embedding support.',
    };
  }

  const file = opts.filePath ?? CANARY_PATH;
  const threshold = opts.threshold ?? 0.05;
  const baseline = opts.capture ? null : loadCanary(file);

  const current = await embedAll(embedding, [...CANARY_STRINGS]);
  if (current.length !== CANARY_STRINGS.length) {
    return {
      status: 'no_provider',
      message: 'Embedding service returned an incomplete result; cannot check drift.',
    };
  }

  if (!baseline) {
    saveCanary(file, {
      version: 1,
      provider: opts.provider ?? null,
      model: opts.model ?? null,
      strings: [...CANARY_STRINGS],
      embeddings: current,
      captured_at: new Date().toISOString(),
    });
    return {
      status: 'baseline_captured',
      message: `Captured baseline for ${CANARY_STRINGS.length} canary strings.`,
      current_provider: opts.provider ?? null,
      current_model: opts.model ?? null,
    };
  }

  const perString: Array<{ text: string; distance: number }> = [];
  for (let i = 0; i < CANARY_STRINGS.length; i += 1) {
    const a = baseline.embeddings[i] ?? [];
    const b = current[i] ?? [];
    perString.push({ text: CANARY_STRINGS[i] ?? '', distance: cosineDistance(a, b) });
  }
  const distances = perString.map((p) => p.distance);
  const max = Math.max(...distances);
  const mean = distances.reduce((acc, d) => acc + d, 0) / (distances.length || 1);
  const drifted = max >= threshold;

  return {
    status: drifted ? 'drift' : 'ok',
    message: drifted
      ? `Embedding drift detected: max cosine distance ${max.toFixed(4)} ≥ threshold ${threshold}. Provider may have changed model weights silently — re-run with capture=true to refresh the baseline once you've verified.`
      : `No drift: max distance ${max.toFixed(4)} below threshold ${threshold}.`,
    threshold,
    max_distance: round4(max),
    mean_distance: round4(mean),
    per_string: perString.map((p) => ({ text: p.text, distance: round4(p.distance) })),
    current_provider: opts.provider ?? null,
    current_model: opts.model ?? null,
    baseline_provider: baseline.provider,
    baseline_model: baseline.model,
  };
}

function loadCanary(filePath: string): CanaryFile | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (parsed?.version !== 1) return null;
    return parsed as CanaryFile;
  } catch (e) {
    logger.warn({ error: e, filePath }, 'embedding-canary read failed');
    return null;
  }
}

function saveCanary(filePath: string, data: CanaryFile): void {
  ensureGlobalDirs();
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

async function embedAll(svc: EmbeddingService, strings: string[]): Promise<number[][]> {
  // Most providers support batch embed; fall back to one-by-one when unavailable.
  const out: number[][] = [];
  for (const s of strings) {
    const v = await svc.embed(s);
    if (Array.isArray(v) && v.every((n) => typeof n === 'number')) out.push(v);
  }
  return out;
}

function cosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 1;
  const cos = dot / denom;
  return Math.max(0, 1 - cos);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
