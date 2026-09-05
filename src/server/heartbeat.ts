/**
 * Status sentinel — bridge between trace-mcp server and guard hook.
 *
 * Two files are written, each into two directories:
 *   1. trace-mcp-status-{projectHash}.json — rich JSON status with PID, last
 *      heartbeat, tool-call counters, last successful call timestamp, etc.
 *      Used by the v0.8+ hook for stall detection and by the desktop app for
 *      the project status badge.
 *   2. trace-mcp-alive-{projectHash} — legacy mtime-only sentinel, kept for
 *      backward compatibility with hook v0.7.x.
 *
 * The primary location is {@link STATUS_DIR} under the state home, which every
 * process resolves identically. The `$TMPDIR` copies are written only so a hook
 * installed before TRA-869 keeps working; see STATUS_DIR for why $TMPDIR alone
 * silently broke the channel.
 *
 * The hook treats a missing/stale status as "MCP unavailable" and falls
 * back to allowing Read with a warning instead of hard-blocking. This
 * closes the legitimate fallback case (crashed server, "session not found")
 * without re-introducing the retry-bypass loophole.
 *
 * `transport` records which command produced this sentinel ("stdio" for
 * `serve` / the daemon backing it, "http" for `serve-http`). The guard hook
 * compares it against the calling client's configured transport (from
 * .mcp.json) so a `serve-http` process can't be mistaken for a live `serve`
 * (stdio) session — see GH #297.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectHash, STATUS_DIR } from '../global.js';
import { writeTmpFileSync } from '../utils/safe-fs.js';

/** Flush cadence while at least one MCP session is active. */
const FLUSH_INTERVAL_ACTIVE_MS = 5_000;
/** Slower flush cadence while no sessions are active (back-off). */
const FLUSH_INTERVAL_IDLE_MS = 30_000;
const STATUS_SCHEMA_VERSION = 2;

export type ServerTransport = 'stdio' | 'http';

interface StatusState {
  schema: number;
  pid: number;
  transport: ServerTransport;
  started_at: string;
  last_heartbeat_at: string;
  last_successful_tool_call_at: string | null;
  last_failed_tool_call_at: string | null;
  tool_calls_total: number;
  tool_calls_failed: number;
  mcp_sessions_active: number;
}

export interface HeartbeatHandle {
  /** Stop the timer and remove sentinel files. */
  stop(): void;
  /** Record a tool-call result. Updates counters and last-call timestamp. */
  recordToolCall(success: boolean): void;
  /** Update the active-sessions gauge. */
  setSessionsActive(count: number): void;
  /** Force a synchronous flush of the in-memory state to disk. */
  flush(): void;
  /** Snapshot of the current in-memory state (for in-process readers / tests). */
  getState(): Readonly<{
    schema: number;
    pid: number;
    transport: ServerTransport;
    started_at: string;
    last_heartbeat_at: string;
    last_successful_tool_call_at: string | null;
    last_failed_tool_call_at: string | null;
    tool_calls_total: number;
    tool_calls_failed: number;
    mcp_sessions_active: number;
  }>;
  /** Path of the rich status JSON file (for tests). */
  readonly path: string;
  /** Path of the legacy mtime-only sentinel (for tests / v0.7 hook). */
  readonly legacyPath: string;
}

function statusName(projectRoot: string): string {
  return `trace-mcp-status-${projectHash(path.resolve(projectRoot))}.json`;
}

function heartbeatName(projectRoot: string): string {
  return `trace-mcp-alive-${projectHash(path.resolve(projectRoot))}`;
}

function statusPath(projectRoot: string): string {
  return path.join(STATUS_DIR, statusName(projectRoot));
}

function legacyHeartbeatPath(projectRoot: string): string {
  return path.join(STATUS_DIR, heartbeatName(projectRoot));
}

/**
 * `$TMPDIR` copies of the two sentinels, for hooks installed before TRA-869.
 * ponytail: drop this pair — and the dual write below — once no supported
 * release reads $TMPDIR.
 */
function tmpdirSentinelPaths(projectRoot: string): [string, string] {
  return [
    path.join(os.tmpdir(), statusName(projectRoot)),
    path.join(os.tmpdir(), heartbeatName(projectRoot)),
  ];
}

/** Age after which a sentinel left behind by a crashed server is collected. */
const STALE_SENTINEL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Drop sentinels from servers that died without running `stop()`.
 *
 * `stop()` unlinks its own files, but a killed process never gets there. In
 * $TMPDIR that never mattered — the OS reaps it — whereas STATUS_DIR lives
 * under the state home and is never cleaned by anyone else, so one file per
 * crashed server would accumulate there forever. Best-effort: a sweep that
 * cannot read the directory is not worth failing a server start over.
 */
function sweepStaleSentinels(): void {
  const cutoff = Date.now() - STALE_SENTINEL_MAX_AGE_MS;
  let names: string[];
  try {
    names = fs.readdirSync(STATUS_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith('trace-mcp-status-') && !name.startsWith('trace-mcp-alive-')) continue;
    const full = path.join(STATUS_DIR, name);
    try {
      const st = fs.lstatSync(full);
      if (!st.isFile() || st.mtimeMs > cutoff) continue;
      fs.unlinkSync(full);
    } catch {
      /* vanished under us, or not ours — skip */
    }
  }
}

/**
 * Start writing the status sentinel for the given project.
 * Best-effort: any I/O error is swallowed — status is a hint, never a
 * hard requirement for tool execution.
 */
export function startHeartbeat(
  projectRoot: string,
  transport: ServerTransport = 'stdio',
): HeartbeatHandle {
  const file = statusPath(projectRoot);
  const legacy = legacyHeartbeatPath(projectRoot);
  const [tmpFile, tmpLegacy] = tmpdirSentinelPaths(projectRoot);
  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true, mode: 0o700 });
  } catch {
    /* best-effort — flush() below is already failure-tolerant */
  }
  sweepStaleSentinels();
  const startedAt = new Date().toISOString();

  const state: StatusState = {
    schema: STATUS_SCHEMA_VERSION,
    pid: process.pid,
    transport,
    started_at: startedAt,
    last_heartbeat_at: startedAt,
    last_successful_tool_call_at: null,
    last_failed_tool_call_at: null,
    tool_calls_total: 0,
    tool_calls_failed: 0,
    // A stdio server exists only because a client spawned it and holds its
    // pipes — one attached session, by construction. Nothing ever called
    // setSessionsActive(), so this stayed 0 and the guard hook's
    // "mcp_sessions_active == 0 means nobody is attached" check (added in
    // #301) fired on every healthy stdio session, degrading the Read branch to
    // advisory. Measured in TRA-773.
    mcp_sessions_active: transport === 'stdio' ? 1 : 0,
  };

  const flush = () => {
    state.last_heartbeat_at = new Date().toISOString();
    const payload = JSON.stringify(state);
    const stamp = String(Date.now());
    try {
      writeTmpFileSync(file, payload);
      // Touch legacy sentinel for old hook installations.
      writeTmpFileSync(legacy, stamp);
    } catch {
      /* best-effort */
    }
    try {
      writeTmpFileSync(tmpFile, payload);
      writeTmpFileSync(tmpLegacy, stamp);
    } catch {
      /* best-effort — pre-TRA-869 readers only */
    }
  };

  const cadenceFor = (sessionsActive: number): number =>
    sessionsActive > 0 ? FLUSH_INTERVAL_ACTIVE_MS : FLUSH_INTERVAL_IDLE_MS;

  flush();
  let currentIntervalMs = cadenceFor(state.mcp_sessions_active);
  let timer = setInterval(flush, currentIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  /**
   * Re-aim the flush interval at the cadence implied by the current session
   * count. No-op when the cadence is unchanged, so it is cheap to call on every
   * session-count change. Reassigns `timer` in this closure so the existing
   * stop()/clearInterval continues to target the live timer.
   */
  const retarget = () => {
    const next = cadenceFor(state.mcp_sessions_active);
    if (next === currentIntervalMs) return;
    currentIntervalMs = next;
    clearInterval(timer);
    timer = setInterval(flush, currentIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  return {
    path: file,
    legacyPath: legacy,
    recordToolCall(success: boolean) {
      state.tool_calls_total += 1;
      const now = new Date().toISOString();
      if (success) {
        state.last_successful_tool_call_at = now;
      } else {
        state.tool_calls_failed += 1;
        state.last_failed_tool_call_at = now;
      }
    },
    setSessionsActive(count: number) {
      state.mcp_sessions_active = count;
      // Adjust flush cadence to match active/idle state (no-op if unchanged).
      retarget();
    },
    flush,
    getState() {
      return { ...state };
    },
    stop() {
      clearInterval(timer);
      for (const p of [file, legacy, tmpFile, tmpLegacy]) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* best-effort */
        }
      }
    },
  };
}
