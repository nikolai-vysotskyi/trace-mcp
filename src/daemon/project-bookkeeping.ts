/**
 * Daemon-side bookkeeping that lives next to the HTTP server (cli.ts) but
 * is too leak-prone to keep inline. Extracted so it can be unit-tested:
 * after addProject + removeProject of N projects, all in-memory state for
 * the removed roots is gone — no listeners, no throttle keys, no session
 * map stragglers.
 *
 * NOTE: this module owns NO global state. Callers pass in the maps/sets
 * to mutate. cli.ts holds the actual instances.
 */

import type { ServerResponse } from 'node:http';

/**
 * Subset of StreamableHTTPServerTransport that teardown actually touches.
 * Keeping this narrow avoids dragging the MCP SDK into a tests/ import.
 */
export interface ClosableTransport {
  close(): Promise<void>;
}

/**
 * Subset of ServerHandle that teardown touches. We don't call server.close()
 * here — onclose handlers chain into that via transport teardown.
 */
export interface DisposableHandle {
  dispose(): void;
}

export interface TeardownDeps {
  progressUnsubscribers: Map<string, () => void>;
  lastProgressEmittedAt: Map<string, number>;
  projectSessions: Map<string, Set<string>>;
  sessionTransports: Map<string, ClosableTransport>;
  sessionHandles: Map<string, DisposableHandle>;
  sessionClients: Map<string, string>;
  clients: Map<string, { project: string }>;
  sseConnections?: Set<ServerResponse>;
  /**
   * Per-session last-traffic timestamps (TRA-1627). When present, teardown
   * also drops them for the removed root's sessions.
   */
  sessionLastSeen?: Map<string, number>;
}

/**
 * The session-map subset teardown operates on, plus the last-traffic map —
 * the unit the stale-session sweep (TRA-1627) reasons about. Progress maps
 * are irrelevant there, so they stay out.
 */
export type SessionBookkeepingDeps = Pick<
  TeardownDeps,
  'projectSessions' | 'sessionTransports' | 'sessionHandles' | 'sessionClients' | 'clients'
> & {
  /** sessionId → last-traffic epoch ms. */
  sessionLastSeen: Map<string, number>;
};

/**
 * Tear down all daemon-side bookkeeping for a removed project root.
 *
 * - Unsubscribes the progress listener so the project's ProgressState
 *   stops pinning broadcastEvent + root via the listener closure.
 * - Closes every live MCP session bound to this project. Each transport's
 *   onclose handler removes itself from sessionTransports/Handles/Clients/
 *   clients/projectSessions, so we just trigger close here. If the
 *   transport is already gone but bookkeeping straggled, we clean those
 *   maps directly so leaks can't survive.
 * - Drops the projectSessions entry so the empty Set doesn't linger.
 * - Prunes lastProgressEmittedAt keys keyed by the removed root.
 */
export function teardownProjectBookkeeping(root: string, deps: TeardownDeps): void {
  const unsub = deps.progressUnsubscribers.get(root);
  if (unsub) {
    try {
      unsub();
    } catch {
      /* ignore */
    }
    deps.progressUnsubscribers.delete(root);
  }

  const sids = deps.projectSessions.get(root);
  if (sids && sids.size > 0) {
    for (const sid of [...sids]) {
      const transport = deps.sessionTransports.get(sid);
      if (transport) {
        transport.close().catch(() => {});
      } else {
        const h = deps.sessionHandles.get(sid);
        if (h) {
          try {
            h.dispose();
          } catch {
            /* ignore */
          }
          deps.sessionHandles.delete(sid);
        }
        const cid = deps.sessionClients.get(sid);
        if (cid) {
          deps.clients.delete(cid);
          deps.sessionClients.delete(sid);
        }
      }
    }
  }
  deps.projectSessions.delete(root);

  if (deps.sessionLastSeen && sids && sids.size > 0) {
    for (const sid of sids) deps.sessionLastSeen.delete(sid);
  }

  const prefix = `${root}::`;
  for (const key of deps.lastProgressEmittedAt.keys()) {
    if (key.startsWith(prefix)) deps.lastProgressEmittedAt.delete(key);
  }
}

/**
 * Select sessions idle longer than `idleMs` — the reap list for the
 * daemon's stale-session sweep (TRA-1627).
 *
 * Pure: takes the last-traffic map, `now`, and the threshold, returns the
 * session ids to reap. Sessions with recent traffic are never selected;
 * `idleMs <= 0` disables the sweep (returns nothing).
 */
export function collectIdleSessions(
  sessionLastSeen: Map<string, number>,
  now: number,
  idleMs: number,
): string[] {
  if (idleMs <= 0) return [];
  const out: string[] = [];
  for (const [sid, lastSeen] of sessionLastSeen) {
    if (now - lastSeen >= idleMs) out.push(sid);
  }
  return out;
}

/**
 * Drop all daemon-side bookkeeping for one session id whose transport is
 * already gone (or was never registered) — the sweep's orphan branch.
 * Idempotent: safe to run after onclose already cleaned the same sid.
 *
 * Never touches the resource pool: an orphan either went through onclose
 * (which released) or never acquired, so there is nothing to release —
 * and a blind release could steal another live session's refcount (the
 * pool clamps at zero instead of tracking per-session ownership).
 */
export function dropSessionBookkeeping(sid: string, deps: SessionBookkeepingDeps): void {
  for (const sids of deps.projectSessions.values()) {
    sids.delete(sid);
  }
  deps.sessionTransports.delete(sid);
  const h = deps.sessionHandles.get(sid);
  if (h) {
    try {
      h.dispose();
    } catch {
      /* ignore */
    }
    deps.sessionHandles.delete(sid);
  }
  const cid = deps.sessionClients.get(sid);
  if (cid) {
    deps.clients.delete(cid);
    deps.sessionClients.delete(sid);
  }
  deps.sessionLastSeen.delete(sid);
}
