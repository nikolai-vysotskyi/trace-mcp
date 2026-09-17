/**
 * Stale MCP session reap (TRA-1627).
 *
 * Root cause, proven against the live daemon (v3.26.3, ~25h uptime):
 * `/debug/memory` showed `sessionTransports: 85` against `clients: 15` —
 * 70 sessions whose client was long gone. Chain of custody:
 *
 * - `createSessionTransport` (cli.ts) calls `resourcePool.acquire(root)`.
 * - The matching `release()` runs ONLY in the chained `transport.onclose`.
 * - The MCP SDK fires `onclose` solely from `transport.close()`, i.e. an
 *   explicit client `DELETE /mcp` (or a server-initiated close).
 * - A client that dies without DELETE (kill -9, OOM, `runtime went offline`,
 *   Stuck Run Recovery restart) never triggers it — `ProxyBackend.stop()`
 *   is the only place that sends DELETE, and a killed process never runs it.
 * - The existing stale-client sweep reaps `clients` entries only, leaving
 *   `sessionTransports`/`sessionHandles`/`sessionClients`/`projectSessions`
 *   and the pool refcount pinned. The idle-unload sweep then skips the
 *   project forever (`getRefCount > 0`).
 *
 * Fix under test: per-session last-traffic timestamps + a sweep that closes
 * idle sessions (close() → onclose → full cleanup incl. release), with a
 * direct bookkeeping drop for orphans whose transport is already gone.
 */

import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { describe, expect, it, vi } from 'vitest';

import {
  collectIdleSessions,
  dropSessionBookkeeping,
  teardownProjectBookkeeping,
  type ClosableTransport,
  type DisposableHandle,
  type SessionBookkeepingDeps,
} from '../../src/daemon/project-bookkeeping.js';

const ROOT_A = '/Users/dev/projects/alpha';
const ROOT_B = '/Users/dev/projects/beta';
const HOUR = 60 * 60 * 1000;

function makeSessionDeps(): SessionBookkeepingDeps & {
  transports: Map<string, ClosableTransport & { close: ReturnType<typeof vi.fn> }>;
} {
  const projectSessions = new Map<string, Set<string>>();
  const transports = new Map<string, ClosableTransport & { close: ReturnType<typeof vi.fn> }>();
  return {
    projectSessions,
    sessionTransports: transports as unknown as Map<string, ClosableTransport>,
    sessionHandles: new Map<string, DisposableHandle>(),
    sessionClients: new Map<string, string>(),
    clients: new Map<string, { project: string }>(),
    sessionLastSeen: new Map<string, number>(),
    transports,
  };
}

function seedSession(
  deps: SessionBookkeepingDeps,
  root: string,
  sid: string,
  opts?: { handle?: DisposableHandle; clientId?: string },
): void {
  if (!deps.projectSessions.has(root)) deps.projectSessions.set(root, new Set());
  deps.projectSessions.get(root)!.add(sid);
  if (opts?.handle) deps.sessionHandles.set(sid, opts.handle);
  if (opts?.clientId) {
    deps.sessionClients.set(sid, opts.clientId);
    deps.clients.set(opts.clientId, { project: root });
  }
}

describe('collectIdleSessions', () => {
  it('returns only sessions idle at least idleMs', () => {
    const now = 1_000_000;
    const lastSeen = new Map([
      ['sid-old', now - HOUR - 1],
      ['sid-edge', now - HOUR],
      ['sid-fresh', now - HOUR + 1],
      ['sid-now', now],
    ]);
    expect(collectIdleSessions(lastSeen, now, HOUR).sort()).toEqual(['sid-edge', 'sid-old']);
  });

  it('returns nothing when disabled or empty', () => {
    expect(collectIdleSessions(new Map([['s', 0]]), Date.now(), 0)).toEqual([]);
    expect(collectIdleSessions(new Map([['s', 0]]), Date.now(), -1)).toEqual([]);
    expect(collectIdleSessions(new Map(), Date.now(), HOUR)).toEqual([]);
  });
});

describe('dropSessionBookkeeping', () => {
  it('drops every map entry for an orphaned session', () => {
    const deps = makeSessionDeps();
    const dispose = vi.fn();
    seedSession(deps, ROOT_A, 'sid-orphan', { handle: { dispose }, clientId: 'client-1' });
    deps.sessionLastSeen.set('sid-orphan', 123);

    dropSessionBookkeeping('sid-orphan', deps);

    expect(dispose).toHaveBeenCalledOnce();
    expect(deps.projectSessions.get(ROOT_A)?.has('sid-orphan')).toBe(false);
    expect(deps.sessionHandles.has('sid-orphan')).toBe(false);
    expect(deps.sessionClients.has('sid-orphan')).toBe(false);
    expect(deps.clients.has('client-1')).toBe(false);
    expect(deps.sessionLastSeen.has('sid-orphan')).toBe(false);
  });

  it('removes the sid from every project set and leaves siblings alone', () => {
    const deps = makeSessionDeps();
    seedSession(deps, ROOT_A, 'sid-x', { clientId: 'c-x' });
    seedSession(deps, ROOT_B, 'sid-x');
    seedSession(deps, ROOT_A, 'sid-sibling', { clientId: 'c-sib' });
    deps.sessionLastSeen.set('sid-x', 1);
    deps.sessionLastSeen.set('sid-sibling', 2);

    dropSessionBookkeeping('sid-x', deps);

    expect(deps.projectSessions.get(ROOT_A)?.has('sid-x')).toBe(false);
    expect(deps.projectSessions.get(ROOT_B)?.has('sid-x')).toBe(false);
    expect(deps.projectSessions.get(ROOT_A)?.has('sid-sibling')).toBe(true);
    expect(deps.sessionClients.get('sid-sibling')).toBe('c-sib');
    expect(deps.clients.has('c-sib')).toBe(true);
    expect(deps.sessionLastSeen.get('sid-sibling')).toBe(2);
  });

  it('is a no-op for unknown sids (idempotent — safe after onclose already ran)', () => {
    const deps = makeSessionDeps();
    seedSession(deps, ROOT_A, 'sid-live', { clientId: 'c-live' });
    expect(() => dropSessionBookkeeping('sid-nope', deps)).not.toThrow();
    expect(deps.projectSessions.get(ROOT_A)?.has('sid-live')).toBe(true);
    expect(deps.clients.has('c-live')).toBe(true);
  });
});

describe('teardownProjectBookkeeping with sessionLastSeen (TRA-1627)', () => {
  it('drops last-traffic entries for the removed root only', () => {
    const deps = {
      ...makeSessionDeps(),
      progressUnsubscribers: new Map<string, () => void>(),
      lastProgressEmittedAt: new Map<string, number>(),
    };
    seedSession(deps, ROOT_A, 'sid-a1');
    seedSession(deps, ROOT_A, 'sid-a2');
    seedSession(deps, ROOT_B, 'sid-b1');
    deps.sessionLastSeen.set('sid-a1', 1);
    deps.sessionLastSeen.set('sid-a2', 2);
    deps.sessionLastSeen.set('sid-b1', 3);

    teardownProjectBookkeeping(ROOT_A, deps);

    expect(deps.sessionLastSeen.has('sid-a1')).toBe(false);
    expect(deps.sessionLastSeen.has('sid-a2')).toBe(false);
    expect(deps.sessionLastSeen.get('sid-b1')).toBe(3);
  });
});

describe('dead-client session pins the pool until the sweep closes it (TRA-1627)', () => {
  /**
   * Minimal replica of the cli.ts session wiring: acquire on create, release
   * only via the chained transport.onclose. Uses the real SDK transport so
   * the test proves onclose is unreachable without close()/DELETE.
   */
  async function wireSession(root: string, pool: Map<string, number>) {
    const sessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
    });
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    await server.connect(transport);

    pool.set(root, (pool.get(root) ?? 0) + 1);

    let cleanedUp = false;
    const released: string[] = [];
    const protocolOnClose = transport.onclose;
    transport.onclose = () => {
      protocolOnClose?.();
      if (cleanedUp) return;
      cleanedUp = true;
      pool.set(root, Math.max(0, (pool.get(root) ?? 0) - 1));
      released.push(root);
    };
    return { transport, released };
  }

  it('a session with no DELETE stays pinned; sweep close() releases it', async () => {
    const pool = new Map<string, number>();
    const { transport, released } = await wireSession(ROOT_A, pool);
    expect(pool.get(ROOT_A)).toBe(1);

    // The dead client sends nothing — no onclose, no release. This is the
    // leak: before the reap sweep, nothing in the daemon reclaimed this.
    expect(released).toEqual([]);
    expect(pool.get(ROOT_A)).toBe(1);

    // The stale-session sweep closes the idle transport; onclose fires and
    // the refcount is released exactly once.
    await transport.close();
    expect(pool.get(ROOT_A)).toBe(0);
    expect(released).toEqual([ROOT_A]);

    // Defensive second drop (what the sweep runs after close) is a no-op —
    // release is not double-counted thanks to the cleanedUp guard.
    await transport.close();
    expect(pool.get(ROOT_A)).toBe(0);
    expect(released).toEqual([ROOT_A]);
  });
});
