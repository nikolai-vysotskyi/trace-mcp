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
}

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

  const prefix = `${root}::`;
  for (const key of deps.lastProgressEmittedAt.keys()) {
    if (key.startsWith(prefix)) deps.lastProgressEmittedAt.delete(key);
  }
}
