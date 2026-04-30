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
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectHash } from '../global.js';

const FLUSH_INTERVAL_MS = 5_000;
const STATUS_SCHEMA_VERSION = 1;

interface StatusState {
  schema: number;
  pid: number;
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
export function startHeartbeat(projectRoot: string): HeartbeatHandle {
  const file = statusPath(projectRoot);
  const legacy = legacyHeartbeatPath(projectRoot);
  const startedAt = new Date().toISOString();

  const state: StatusState = {
    schema: STATUS_SCHEMA_VERSION,
    pid: process.pid,
    started_at: startedAt,
    last_heartbeat_at: startedAt,
    last_successful_tool_call_at: null,
    last_failed_tool_call_at: null,
    tool_calls_total: 0,
    tool_calls_failed: 0,
    mcp_sessions_active: 0,
  };

  const flush = () => {
    state.last_heartbeat_at = new Date().toISOString();
    try {
      fs.writeFileSync(file, JSON.stringify(state), { flag: 'w' });
      // Touch legacy sentinel for old hook installations.
      fs.writeFileSync(legacy, String(Date.now()), { flag: 'w' });
    } catch {
      /* best-effort */
    }
  };

  flush();
  const timer = setInterval(flush, FLUSH_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

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
