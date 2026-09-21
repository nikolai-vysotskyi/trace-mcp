/**
 * Unresolvable-session counter (TRA-1791).
 *
 * The daemon's `/mcp` router rejects requests it cannot route to a project:
 * zero registered projects (`no-projects`) or several with no usable hint
 * (`ambiguous`) — the latter including the `cwd=/` case where the client's
 * `?project=/` hint is dropped as a dangerous root (TRA-286) and the
 * fall-through finds 47 registered projects.
 *
 * Those rejections never reach a per-project `createServer()` session, so no
 * per-project heartbeat/tool-gate ever runs and no consultation marker can be
 * earned. The guard hook meanwhile sees a fresh per-project heartbeat and
 * stays strict — every code Read is denied forever (only auto-degrade after
 * 5 denies lets it through, and the next session restarts the cycle).
 *
 * This module exposes that daemon-wide signal to the guard: a single JSON
 * file under STATUS_DIR (`trace-mcp-unresolvable.json`) with totals the shell
 * hook reads without any new RPC. Best-effort throughout — a failure to
 * read/write the file must never break request handling.
 */

import fs from 'node:fs';
import path from 'node:path';
import { STATUS_DIR } from '../global.js';

export const UNRESOLVABLE_SENTINEL_NAME = 'trace-mcp-unresolvable.json';
export const UNRESOLVABLE_SCHEMA_VERSION = 1;

export interface UnresolvableState {
  schema: number;
  /** Every `no-projects` / `ambiguous` resolution since the file was created. */
  total: number;
  ambiguous: number;
  no_projects: number;
  /** Of those, how many carried a dropped dangerous hint (e.g. `?project=/`). */
  dangerous_hint_dropped: number;
  last_at: string | null;
  last_kind: 'ambiguous' | 'no-projects' | null;
  last_hint: string | null;
  last_reason: string | null;
  last_via: string | null;
}

export function unresolvableFilePath(): string {
  return path.join(STATUS_DIR, UNRESOLVABLE_SENTINEL_NAME);
}

function emptyState(): UnresolvableState {
  return {
    schema: UNRESOLVABLE_SCHEMA_VERSION,
    total: 0,
    ambiguous: 0,
    no_projects: 0,
    dangerous_hint_dropped: 0,
    last_at: null,
    last_kind: null,
    last_hint: null,
    last_reason: null,
    last_via: null,
  };
}

/** Best-effort read of the current counter (for tests / diagnostics). */
export function readUnresolvableState(): UnresolvableState {
  try {
    const raw = fs.readFileSync(unresolvableFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<UnresolvableState>;
    const base = emptyState();
    return {
      ...base,
      ...parsed,
      schema: UNRESOLVABLE_SCHEMA_VERSION,
      total: typeof parsed.total === 'number' ? parsed.total : 0,
      ambiguous: typeof parsed.ambiguous === 'number' ? parsed.ambiguous : 0,
      no_projects: typeof parsed.no_projects === 'number' ? parsed.no_projects : 0,
      dangerous_hint_dropped:
        typeof parsed.dangerous_hint_dropped === 'number' ? parsed.dangerous_hint_dropped : 0,
    };
  } catch {
    return emptyState();
  }
}

/**
 * Record one unroutable resolution. Only `no-projects` / `ambiguous` kinds
 * are counted — resolved requests are per-project sessions and need no
 * global fallback signal.
 */
export function recordUnresolvableResolution(resolution: {
  kind: string;
  ignoredDangerousHint?: { projectRoot: string; reason: string; via: string } | undefined;
}): void {
  if (resolution.kind !== 'no-projects' && resolution.kind !== 'ambiguous') return;
  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true, mode: 0o700 });
  } catch {
    /* best-effort */
  }
  const state = readUnresolvableState();
  state.total += 1;
  if (resolution.kind === 'ambiguous') state.ambiguous += 1;
  else state.no_projects += 1;
  const dropped = resolution.ignoredDangerousHint;
  if (dropped) {
    state.dangerous_hint_dropped += 1;
    state.last_hint = dropped.projectRoot;
    state.last_reason = dropped.reason;
    state.last_via = dropped.via;
  } else {
    state.last_hint = null;
    state.last_reason = null;
    state.last_via = null;
  }
  state.last_at = new Date().toISOString();
  state.last_kind = resolution.kind;
  try {
    fs.writeFileSync(unresolvableFilePath(), JSON.stringify(state));
  } catch {
    /* best-effort — never break request handling over a hint file */
  }
}

/** Test-only: remove the sentinel so cases start from zero. */
export function __resetUnresolvableCounterForTests(): void {
  try {
    fs.unlinkSync(unresolvableFilePath());
  } catch {
    /* missing — fine */
  }
}
