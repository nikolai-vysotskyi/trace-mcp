/**
 * Status sentinel — bridge between trace-mcp server and guard hook.
 *
 * Two files are written:
 *   1. $TMPDIR/trace-mcp-status-{projectHash}.json — rich JSON status
 *      with PID, last heartbeat, tool-call counters, last successful call
 *      timestamp, etc. Used by the v0.8+ hook for stall detection and by
 *      the desktop app for the project status badge.
 *   2. $TMPDIR/trace-mcp-alive-{projectHash} — legacy mtime-only sentinel,
 *      kept for backward compatibility with hook v0.7.x. Removed once all
 *      installations are on v0.8+.
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
import { projectHash } from '../global.js';
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

function statusPath(projectRoot: string): string {
  return path.join(os.tmpdir(), `trace-mcp-status-${projectHash(path.resolve(projectRoot))}.json`);
}

function legacyHeartbeatPath(projectRoot: string): string {
  return path.join(os.tmpdir(), `trace-mcp-alive-${projectHash(path.resolve(projectRoot))}`);
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
    try {
      writeTmpFileSync(file, JSON.stringify(state));
      // Touch legacy sentinel for old hook installations.
      writeTmpFileSync(legacy, String(Date.now()));
    } catch {
      /* best-effort */
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
      try {
        fs.unlinkSync(file);
      } catch {
        /* best-effort */
      }
      try {
        fs.unlinkSync(legacy);
      } catch {
        /* best-effort */
      }
    },
  };
}
