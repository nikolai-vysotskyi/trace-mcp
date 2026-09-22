/**
 * Daemon-global telemetry for unresolvable `/mcp` project resolutions (TRA-1791).
 *
 * When the daemon's HTTP `/mcp` endpoint cannot route a request to a project —
 * `ambiguous` (several registered, no usable hint) or `no-projects` — it
 * answers 400/404 and the session gets zero working tools. The per-project
 * status sentinels (`trace-mcp-status-<hash>.json`) cannot record this: there
 * is no project to attribute the failure to. Before this module, that left the
 * guard hook blind — a live heartbeat meant "strict", every trace call failed,
 * no consultation marker could ever appear, and each code Read stayed BLOCKED
 * until the 5-deny auto-degrade tripped, re-armed, and tripped again. The loop
 * users saw as "the guard randomly blocks Reads".
 *
 * This module keeps process-local counters and persists a small daemon-global
 * snapshot to `STATUS_DIR/trace-mcp-daemon.json` on every unresolvable
 * resolution. The guard hook (v0.19+) reads it: fresh unresolvable activity +
 * zero consultation markers + repeated denies in the same session means
 * "consultation is impossible, not skipped" and the hook allows the Read with
 * a warning instead of deadlocking.
 *
 * Best-effort throughout: telemetry must never break request handling or crash
 * the daemon. A missing/unwritable STATUS_DIR simply means no snapshot — the
 * hook then behaves exactly as before (strict until auto-degrade).
 */

import fs from 'node:fs';
import path from 'node:path';
import { STATUS_DIR } from '../global.js';
import { writeTmpFileSync } from '../utils/safe-fs.js';

export const RESOLUTION_TELEMETRY_SCHEMA = 1;
export const DAEMON_STATUS_NAME = 'trace-mcp-daemon.json';

export type UnresolvableKind = 'ambiguous' | 'no-projects';

export interface UnresolvableResolution {
  kind: UnresolvableKind;
  ignoredDangerousHint?: { projectRoot: string; reason: string };
}

export interface DaemonStatusSnapshot {
  schema: number;
  pid: number;
  started_at: string;
  updated_at: string;
  /** Total unresolvable /mcp resolutions since daemon start. */
  unresolvable_total: number;
  /** Subset where an explicit client hint was dropped as a dangerous root. */
  dangerous_hints_total: number;
  last_unresolvable_at: string | null;
  last_resolution: UnresolvableKind | null;
  last_hinted_root: string | null;
  last_hint_reason: string | null;
}

export function daemonStatusPath(): string {
  return path.join(STATUS_DIR, DAEMON_STATUS_NAME);
}

const daemonStartedAt = new Date().toISOString();

interface TelemetryState {
  unresolvableTotal: number;
  dangerousHintsTotal: number;
  lastUnresolvableAt: string | null;
  lastResolution: UnresolvableKind | null;
  lastHintedRoot: string | null;
  lastHintReason: string | null;
}

const state: TelemetryState = {
  unresolvableTotal: 0,
  dangerousHintsTotal: 0,
  lastUnresolvableAt: null,
  lastResolution: null,
  lastHintedRoot: null,
  lastHintReason: null,
};

/** Test-only: drop in-memory counters so cases start from zero. */
export function __resetResolutionTelemetryForTests(): void {
  state.unresolvableTotal = 0;
  state.dangerousHintsTotal = 0;
  state.lastUnresolvableAt = null;
  state.lastResolution = null;
  state.lastHintedRoot = null;
  state.lastHintReason = null;
}

/** Test-only: snapshot of the in-memory counters without touching disk. */
export function __getResolutionTelemetryStateForTests(): Readonly<{
  unresolvableTotal: number;
  dangerousHintsTotal: number;
}> {
  return {
    unresolvableTotal: state.unresolvableTotal,
    dangerousHintsTotal: state.dangerousHintsTotal,
  };
}

function toSnapshot(): DaemonStatusSnapshot {
  return {
    schema: RESOLUTION_TELEMETRY_SCHEMA,
    pid: process.pid,
    started_at: daemonStartedAt,
    updated_at: new Date().toISOString(),
    unresolvable_total: state.unresolvableTotal,
    dangerous_hints_total: state.dangerousHintsTotal,
    last_unresolvable_at: state.lastUnresolvableAt,
    last_resolution: state.lastResolution,
    last_hinted_root: state.lastHintedRoot,
    last_hint_reason: state.lastHintReason,
  };
}

/**
 * Record one unresolvable `/mcp` resolution and persist the daemon snapshot.
 * Never throws — callers must not wrap request handling in try/catch for this.
 */
export function recordUnresolvableResolution(
  resolution: UnresolvableResolution,
): DaemonStatusSnapshot {
  state.unresolvableTotal += 1;
  state.lastUnresolvableAt = new Date().toISOString();
  state.lastResolution = resolution.kind;
  const hint = resolution.ignoredDangerousHint;
  if (hint) {
    state.dangerousHintsTotal += 1;
    state.lastHintedRoot = hint.projectRoot;
    state.lastHintReason = hint.reason;
  }
  const snapshot = toSnapshot();
  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true, mode: 0o700 });
    writeTmpFileSync(daemonStatusPath(), JSON.stringify(snapshot));
  } catch {
    /* best-effort — the hook treats a missing file as "no signal" */
  }
  return snapshot;
}
