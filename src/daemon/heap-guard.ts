/**
 * Heap-pressure guard for the long-lived daemon (TRA-2056).
 *
 * Why this exists: the 2026-09-28 day shift killed daemon 3.34.3 with a V8
 * JavaScript heap OOM (`FatalProcessOutOfMemory` → SIGABRT, pid 41711) after
 * heap_used ran 448MB → 3.9GB in ~12.5h and the respawned process kept the
 * same ~450MB/h pace. A V8 OOM runs no JS shutdown handler — the process
 * just aborts mid-request — so the mitigation has to happen BEFORE the
 * ceiling: warn early, then exit gracefully (drain via `shutdown()`, letting
 * launchd respawn) instead of aborting mid-index.
 *
 * Pure threshold math (`evaluateHeapPressure`) is unit-testable; `readHeapMb`
 * is the single measurement path; `startHeapGuard` wires the interval.
 */
import v8 from 'node:v8';
import { logger } from '../logger.js';

export interface HeapThresholds {
  /** Warn once per episode at/above this heap_used (MB). */
  warnMb: number;
  /** Request a graceful restart at/above this heap_used (MB). */
  restartMb: number;
}

export type HeapPressure = 'ok' | 'warn' | 'restart';

/**
 * Resolve warn/restart thresholds (MB). Defaults are fractions of V8's old-space
 * ceiling so a custom `--max-old-space-size` moves both automatically:
 * warn at 75%, restart at 87%. Absolute env overrides
 * (`TRACE_MCP_HEAP_WARN_MB` / `TRACE_MCP_HEAP_RESTART_MB`) win over the
 * fractions; `TRACE_MCP_HEAP_GUARD=0` disables the guard entirely.
 */
export function resolveHeapThresholds(env: NodeJS.ProcessEnv = process.env): {
  thresholds: HeapThresholds;
  enabled: boolean;
} {
  if (env.TRACE_MCP_HEAP_GUARD === '0') {
    return {
      thresholds: { warnMb: Number.POSITIVE_INFINITY, restartMb: Number.POSITIVE_INFINITY },
      enabled: false,
    };
  }
  let limitMb = 4096;
  try {
    const stats = v8.getHeapStatistics();
    if (Number.isFinite(stats.heap_size_limit) && stats.heap_size_limit > 0) {
      limitMb = Math.round(stats.heap_size_limit / 1024 / 1024);
    }
  } catch {
    /* v8 stats unavailable — fall back to the 4GB default ceiling */
  }
  const numEnv = (name: string): number | null => {
    const raw = env[name];
    if (raw == null || raw === '') return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const warnMb = numEnv('TRACE_MCP_HEAP_WARN_MB') ?? Math.round(limitMb * 0.75);
  const restartMb = numEnv('TRACE_MCP_HEAP_RESTART_MB') ?? Math.round(limitMb * 0.87);
  // Keep the ordering invariant even under odd overrides: restart above warn.
  return {
    thresholds: {
      warnMb,
      restartMb: Math.max(restartMb, warnMb + 1),
    },
    enabled: true,
  };
}

/** Pure threshold verdict — no I/O, unit-tested directly. */
export function evaluateHeapPressure(usedMb: number, thresholds: HeapThresholds): HeapPressure {
  if (usedMb >= thresholds.restartMb) return 'restart';
  if (usedMb >= thresholds.warnMb) return 'warn';
  return 'ok';
}

export interface HeapSample {
  usedMb: number;
  totalMb: number;
  limitMb: number;
}

/** Single measurement path for the guard (mirrors vitals-log's MB rounding). */
export function readHeapMb(): HeapSample {
  const mem = process.memoryUsage();
  let limitMb = 0;
  try {
    limitMb = Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024);
  } catch {
    /* best-effort */
  }
  return {
    usedMb: Math.round(mem.heapUsed / 1024 / 1024),
    totalMb: Math.round(mem.heapTotal / 1024 / 1024),
    limitMb,
  };
}

/**
 * Sample the heap every `intervalMs` (default 60s, aligned with vitals).
 * Warns once per warn-episode; calls `onRestart` once when the restart
 * threshold is reached (the caller owns the graceful shutdown — typically
 * `shutdown('heap-pressure')` so launchd respawns). The timer is unref'd.
 * Returns a stop function.
 */
export function startHeapGuard(opts: {
  thresholds?: HeapThresholds;
  intervalMs?: number;
  readHeap?: () => HeapSample;
  getContext?: () => Record<string, unknown>;
  onRestart?: (sample: HeapSample) => void;
}): () => void {
  const { thresholds } = opts.thresholds
    ? { thresholds: opts.thresholds }
    : resolveHeapThresholds();
  const readHeap = opts.readHeap ?? readHeapMb;
  let warned = false;
  let restarted = false;
  const tick = (): void => {
    let sample: HeapSample;
    try {
      sample = readHeap();
    } catch {
      return;
    }
    const pressure = evaluateHeapPressure(sample.usedMb, thresholds);
    if (pressure === 'ok') {
      warned = false;
      return;
    }
    let ctx: Record<string, unknown> = {};
    try {
      ctx = opts.getContext?.() ?? {};
    } catch {
      /* context must never break the guard */
    }
    if (pressure === 'restart') {
      if (restarted) return;
      restarted = true;
      logger.error(
        {
          ...ctx,
          heapUsedMb: sample.usedMb,
          heapTotalMb: sample.totalMb,
          heapLimitMb: sample.limitMb,
        },
        'Heap pressure over restart threshold — requesting graceful restart before V8 OOM (TRA-2056)',
      );
      try {
        opts.onRestart?.(sample);
      } catch (err) {
        logger.warn({ err }, 'Heap guard onRestart failed (non-fatal)');
      }
      return;
    }
    if (!warned) {
      warned = true;
      logger.warn(
        {
          ...ctx,
          heapUsedMb: sample.usedMb,
          heapTotalMb: sample.totalMb,
          heapLimitMb: sample.limitMb,
        },
        'Heap pressure over warn threshold — monitoring for V8 OOM trajectory (TRA-2056)',
      );
    }
  };
  // No immediate tick: vitals already logs the current heap at startup; the
  // guard's job starts on the first interval.
  const timer = setInterval(tick, opts.intervalMs ?? 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
