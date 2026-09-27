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

/**
 * A proxied send failed but /health still answered, so the session stayed on
 * the proxy and no local backend was built (TRA-1997). Recorded for QA
 * attribution, but excluded from the storm gauge — see
 * `summarizeSessionFallbacks`.
 */
export const PROXY_SEND_TRANSIENT_REASON = 'proxy-send-transient';

export interface SessionFallbackEvent {
  ts: number;
  /**
   * Why this session went local (or stayed proxy after a failed send):
   * proxy-initialize-timeout, proxy-initialize-error, proxy-startup-stalled,
   * proxy-send-failed, proxy-send-transient, daemon-disappeared.
   *
   * `proxy-send-transient` (TRA-1997) is the slow-daemon counterpart of
   * `proxy-send-failed`: the proxied send threw after retries but /health
   * still answered, so the session stayed on the proxy and only that one
   * request failed — no local backend was built.
   */
  reason: string;
  pid: number;
  /**
   * Attribution for send-failure fallbacks (TRA-1997). Absent on older lines
   * and on reasons that carry no request context — readers must tolerate that.
   */
  /** Tool or method the failed frame targeted (`get_symbol`, `tools/list`, …). */
  tool?: string;
  /** JSON-RPC id of the failed frame, when it had one. */
  reqId?: string | number;
  /** `ClassName: first line of message`, truncated — never a stack. */
  err?: string;
}

/** Attribution attached to a fallback line. All fields optional. */
export interface SessionFallbackDetails {
  tool?: string;
  reqId?: string | number;
  err?: unknown;
}

export interface SessionFallbackSummary {
  /**
   * Sessions that actually went local-mode inside the window. Excludes
   * `proxy-send-transient` (stayed on proxy — no local backend was built),
   * which is still counted in `byReason` for attribution.
   */
  total: number;
  byReason: Record<string, number>;
  /** Local-mode fallbacks per minute over the summarized window — the storm gauge. */
  perMin: number;
  /** Window length in ms the summary covers. */
  windowMs: number;
}

/**
 * Record one fallback. Best-effort and synchronous: the caller is already on
 * a failure path, so recording must never throw, block, or reorder work.
 *
 * `details` carries the TRA-1997 attribution (which frame failed with what
 * error) so the next night-QA pass can tell a dead daemon from a starved one
 * without guessing. It only ever widens the line — old readers ignore the
 * extra keys, and `readSessionFallbacks` below tolerates lines without them.
 */
export function recordSessionFallback(
  reason: string,
  filePath: string = SESSION_FALLBACK_STATS_PATH,
  details: SessionFallbackDetails = {},
): void {
  try {
    const dir = path.dirname(filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* not ours — the append below will fail and be swallowed */
    }
    const line = `${JSON.stringify(stripUndefined({ ts: Date.now(), reason, pid: process.pid, tool: details.tool, reqId: details.reqId, err: describeFallbackError(details.err) }))}\n`;
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

/** Cap on the rendered `err` attribution so one chatty message can't bloat the file. */
const MAX_ERR_CHARS = 240;

/**
 * Render an unknown throw as `ClassName[(code)]: first line of message`.
 * Class-only when there is no message; undefined when there is no error —
 * so lines recorded without an error carry no `err` key at all.
 */
export function describeFallbackError(err: unknown): string | undefined {
  if (err === undefined || err === null) return undefined;
  const rec = err as { name?: unknown; message?: unknown; code?: unknown };
  const rawName = typeof rec.name === 'string' && rec.name ? rec.name : undefined;
  const ctor =
    typeof (err as object)?.constructor?.name === 'string'
      ? (err as object).constructor.name
      : undefined;
  const base = rawName ?? (ctor && ctor !== 'Object' ? ctor : 'Error');
  const code = rec.code;
  const head =
    typeof base === 'string' && (typeof code === 'number' || typeof code === 'string')
      ? `${base}(${code})`
      : base;
  const msg =
    err instanceof Error
      ? err.message
      : typeof rec.message === 'string'
        ? rec.message
        : String(err);
  const firstLine = msg.split('\n', 1)[0].trim();
  const rendered = firstLine ? `${head}: ${firstLine}` : `${head}`;
  return rendered.length > MAX_ERR_CHARS ? `${rendered.slice(0, MAX_ERR_CHARS)}…` : rendered;
}

/** Drop undefined values so unattributed lines keep their old shape exactly. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k as keyof T] = v as never;
  }
  return out;
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
      const event: SessionFallbackEvent = {
        ts: obj.ts,
        reason: obj.reason,
        pid: typeof obj.pid === 'number' ? obj.pid : -1,
      };
      // Attribution (TRA-1997): present only on lines recorded with details.
      if (typeof obj.tool === 'string') event.tool = obj.tool;
      if (typeof obj.reqId === 'string' || typeof obj.reqId === 'number') event.reqId = obj.reqId;
      if (typeof obj.err === 'string') event.err = obj.err;
      out.push(event);
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
 *
 * `proxy-send-transient` lines are attributed in `byReason` but excluded
 * from `total`/`perMin`: no local backend was built for them, and counting
 * them would turn the TRA-1605 storm gauge into a shelf gauge (TRA-1997).
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
    if (e.reason !== PROXY_SEND_TRANSIENT_REASON) total++;
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
