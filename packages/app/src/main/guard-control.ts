/**
 * Guard control — read trace-mcp guard status / mode for a project,
 * and toggle the per-project mode file.
 *
 * Status reader: parses $TMPDIR/trace-mcp-status-{projectHash}.json written
 * by the trace-mcp server (see src/server/heartbeat.ts).
 *
 * Mode toggle: writes <projectRoot>/.trace-mcp/guard-mode (one of
 * "strict" | "coach" | "off"). The hook reads this file before each call.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type GuardMode = 'strict' | 'coach' | 'off';

export interface GuardStatus {
  /** "ok" | "stalled" | "down" | "unknown" — derived from status JSON. */
  health: 'ok' | 'stalled' | 'down' | 'unknown';
  /** Current mode for this project. */
  mode: GuardMode;
  /** Server PID, when known. */
  pid?: number;
  /** ISO 8601 timestamp of last successful tool call, when known. */
  lastSuccessAt?: string | null;
  /** Total tool calls observed by the server. */
  toolCallsTotal?: number;
  /** Total tool-call failures observed by the server. */
  toolCallsFailed?: number;
  /** Seconds since the last successful tool call (when present). */
  quietSeconds?: number;
  /** Manual bypass active until (epoch seconds). 0 = no bypass. */
  bypassUntil?: number;
  /** Free-form reason, useful when health != "ok". */
  reason?: string;
}

const STALL_THRESHOLD_SEC = 300;
const HEARTBEAT_STALE_SEC = 30;

function projectHash(projectRoot: string): string {
  return crypto
    .createHash('sha256')
    .update(path.resolve(projectRoot))
    .digest('hex')
    .slice(0, 12);
}

function statusPath(projectRoot: string): string {
  return path.join(os.tmpdir(), `trace-mcp-status-${projectHash(projectRoot)}.json`);
}

function legacyHeartbeatPath(projectRoot: string): string {
  return path.join(os.tmpdir(), `trace-mcp-alive-${projectHash(projectRoot)}`);
}

function bypassPath(projectRoot: string): string {
  return path.join(os.tmpdir(), `trace-mcp-bypass-${projectHash(projectRoot)}`);
}

function modeFile(projectRoot: string): string {
  return path.join(projectRoot, '.trace-mcp', 'guard-mode');
}

/** Read the per-project guard mode file. Falls back to "strict". */
export function getGuardMode(projectRoot: string): GuardMode {
  try {
    const raw = fs.readFileSync(modeFile(projectRoot), 'utf-8').trim();
    if (raw === 'strict' || raw === 'coach' || raw === 'off') return raw;
  } catch {
    /* missing file = default */
  }
  return 'strict';
}

/** Write the per-project guard mode file (creates parent dir). */
export function setGuardMode(projectRoot: string, mode: GuardMode): void {
  const dir = path.dirname(modeFile(projectRoot));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(modeFile(projectRoot), `${mode}\n`);
}

/** Best-effort read of a project's current guard status + mode. */
export function getGuardStatus(projectRoot: string): GuardStatus {
  const mode = getGuardMode(projectRoot);

  // Manual bypass takes visual precedence — it means the user explicitly
  // disabled enforcement.
  let bypassUntil = 0;
  try {
    const bp = bypassPath(projectRoot);
    if (fs.existsSync(bp)) {
      const m = fs.statSync(bp).mtimeMs;
      if (m > Date.now()) bypassUntil = Math.floor(m / 1000);
    }
  } catch {
    /* ignore */
  }

  // Try the rich status JSON first.
  try {
    const raw = fs.readFileSync(statusPath(projectRoot), 'utf-8');
    const parsed = JSON.parse(raw) as {
      pid?: number;
      last_successful_tool_call_at?: string | null;
      last_heartbeat_at?: string;
      tool_calls_total?: number;
      tool_calls_failed?: number;
    };

    const now = Date.now();
    const heartbeatAge = parsed.last_heartbeat_at
      ? Math.floor((now - new Date(parsed.last_heartbeat_at).getTime()) / 1000)
      : Number.POSITIVE_INFINITY;

    let health: GuardStatus['health'] = 'ok';
    let reason: string | undefined;

    if (heartbeatAge > HEARTBEAT_STALE_SEC) {
      health = 'down';
      reason = `Heartbeat stale (${heartbeatAge}s)`;
    } else if (
      typeof parsed.tool_calls_total === 'number' &&
      parsed.tool_calls_total > 0 &&
      parsed.last_successful_tool_call_at
    ) {
      const quiet = Math.floor(
        (now - new Date(parsed.last_successful_tool_call_at).getTime()) / 1000,
      );
      if (quiet > STALL_THRESHOLD_SEC) {
        health = 'stalled';
        reason = `MCP channel quiet for ${quiet}s`;
      }
    }

    const quietSeconds = parsed.last_successful_tool_call_at
      ? Math.floor((now - new Date(parsed.last_successful_tool_call_at).getTime()) / 1000)
      : undefined;

    return {
      health,
      mode,
      pid: parsed.pid,
      lastSuccessAt: parsed.last_successful_tool_call_at ?? null,
      toolCallsTotal: parsed.tool_calls_total,
      toolCallsFailed: parsed.tool_calls_failed,
      quietSeconds,
      bypassUntil,
      reason,
    };
  } catch {
    /* fall through to legacy / unknown */
  }

  // Fallback: legacy heartbeat sentinel only — limited info.
  try {
    const legacy = legacyHeartbeatPath(projectRoot);
    if (fs.existsSync(legacy)) {
      const age = Math.floor((Date.now() - fs.statSync(legacy).mtimeMs) / 1000);
      if (age <= HEARTBEAT_STALE_SEC) {
        return {
          health: 'ok',
          mode,
          bypassUntil,
          reason: 'Legacy heartbeat only — server pre-v0.8',
        };
      }
      return {
        health: 'down',
        mode,
        bypassUntil,
        reason: `Legacy heartbeat stale (${age}s)`,
      };
    }
  } catch {
    /* ignore */
  }

  return {
    health: 'down',
    mode,
    bypassUntil,
    reason: 'trace-mcp server not running',
  };
}

/** Toggle bypass on/off (writes the same sentinel as scripts/trace-mcp-disable-guard.sh). */
export function setBypass(projectRoot: string, minutes: number): void {
  const file = bypassPath(projectRoot);
  if (minutes <= 0) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* not present */
    }
    return;
  }
  fs.writeFileSync(file, 'manual');
  const future = new Date(Date.now() + minutes * 60_000);
  fs.utimesSync(file, future, future);
}
