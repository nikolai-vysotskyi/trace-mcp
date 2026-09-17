/**
 * Cross-process counter of stdio sessions that fell back to local mode
 * (TRA-1605, PROC-1).
 *
 * A fallback storm is invisible from inside any one session: each process
 * only knows about itself, and the daemon — the thing `daemon stats` reads
 * from — is down by definition when fallbacks spike. So every session
 * appends one JSONL line to a shared file under TRACE_MCP_HOME (the same
 * pattern as hook-stats.jsonl), and `daemon stats` aggregates the file
 * locally — no daemon round-trip needed, which is exactly when the number
 * matters most. /api/stats also serves the summary for the desktop app.
 */
import fs from 'node:fs';
import path from 'node:path';
import { TRACE_MCP_HOME } from '../../global.js';

export const SESSION_FALLBACK_STATS_PATH = path.join(TRACE_MCP_HOME, 'session-fallbacks.jsonl');

/** Cap: prune oldest lines past this on write so the file can't grow forever. */
const MAX_LINES = 5_000;

export interface SessionFallbackEvent {
  ts: number;
  /** Why this session went local: proxy-initialize-timeout, proxy-initialize-error, proxy-send-failed, daemon-disappeared. */
  reason: string;
  pid: number;
}

export interface SessionFallbackSummary {
  total: number;
  byReason: Record<string, number>;
  /** Fallbacks per minute over the summarized window — the storm gauge. */
  perMin: number;
  /** Window length in ms the summary covers. */
  windowMs: number;
}

/**
 * Record one fallback. Best-effort and synchronous: the caller is already on
 * a failure path, so recording must never throw, block, or reorder work.
 */
export function recordSessionFallback(
  reason: string,
  filePath: string = SESSION_FALLBACK_STATS_PATH,
): void {
  try {
    const dir = path.dirname(filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* not ours — the append below will fail and be swallowed */
    }
    const line = `${JSON.stringify({ ts: Date.now(), reason, pid: process.pid })}\n`;
    try {
      fs.appendFileSync(filePath, line);
    } catch {
      return;
    }
    pruneFallbackFile(filePath);
  } catch {
    /* recording must never break the session it measures */
  }
}

function pruneFallbackFile(filePath: string): void {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    // Fast path: short files need no work. A trailing newline means
    // split() overcounts by one — account for it instead of splitting.
    let lines = 0;
    for (let i = 0; i < raw.length; i++) {
      if (raw.charCodeAt(i) === 10) lines++;
    }
    if (lines <= MAX_LINES) return;
    const kept = raw
      .split('\n')
      .filter((l) => l.length > 0)
      .slice(-MAX_LINES);
    fs.writeFileSync(filePath, `${kept.join('\n')}\n`);
  } catch {
    /* best-effort */
  }
}

/** Read every recorded fallback. Malformed lines are skipped (JSONL tolerates). */
export function readSessionFallbacks(
  filePath: string = SESSION_FALLBACK_STATS_PATH,
): SessionFallbackEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const out: SessionFallbackEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.ts !== 'number' || typeof obj.reason !== 'string') continue;
      out.push({
        ts: obj.ts,
        reason: obj.reason,
        pid: typeof obj.pid === 'number' ? obj.pid : -1,
      });
    } catch {
      /* skip malformed lines */
    }
  }
  return out;
}

/**
 * Summarize fallbacks inside the window. `sinceMs` is a window *length*
 * (matches `daemon stats --since` / reindex-stats semantics), not an
 * absolute timestamp; omitted/<=0 means all-time.
 */
export function summarizeSessionFallbacks(
  events: SessionFallbackEvent[],
  opts: { sinceMs?: number | null; nowMs?: number } = {},
): SessionFallbackSummary {
  const nowMs = opts.nowMs ?? Date.now();
  const sinceMs = opts.sinceMs ?? null;
  const windowMs = sinceMs !== null && sinceMs > 0 ? sinceMs : 0;
  const cutoff = windowMs > 0 ? nowMs - windowMs : null;
  const byReason: Record<string, number> = {};
  let total = 0;
  for (const e of events) {
    if (cutoff !== null && e.ts < cutoff) continue;
    total++;
    byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
  }
  const spanMs = windowMs > 0 ? windowMs : Math.max(1, nowMs - oldestTs(events, nowMs));
  return { total, byReason, perMin: total / (spanMs / 60_000), windowMs: spanMs };
}

function oldestTs(events: SessionFallbackEvent[], nowMs: number): number {
  let oldest = nowMs;
  for (const e of events) {
    if (e.ts < oldest) oldest = e.ts;
  }
  return oldest;
}
