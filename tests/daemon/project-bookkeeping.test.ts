/**
 * Unit tests for daemon bookkeeping teardown.
 *
 * Bug history: pre-fix, removeProject() left progressUnsubscribers entries
 * dangling forever (closure pinned ProgressState + root + broadcastEvent),
 * lastProgressEmittedAt accreted keys, and projectSessions stragglers kept
 * sessionHandles / sessionClients / clients entries alive even when the
 * transport was already gone. These tests assert each leak channel is
 * closed after teardown.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  teardownProjectBookkeeping,
  type ClosableTransport,
  type DisposableHandle,
  type TeardownDeps,
} from '../../src/daemon/project-bookkeeping.js';

const ROOT_A = '/Users/dev/projects/alpha';
const ROOT_B = '/Users/dev/projects/beta';

function makeDeps(): TeardownDeps & {
  transports: Map<string, ClosableTransport & { close: ReturnType<typeof vi.fn> }>;
} {
  const progressUnsubscribers = new Map<string, () => void>();
  const lastProgressEmittedAt = new Map<string, number>();
  const projectSessions = new Map<string, Set<string>>();
  const transports = new Map<string, ClosableTransport & { close: ReturnType<typeof vi.fn> }>();
  const sessionHandles = new Map<string, DisposableHandle>();
  const sessionClients = new Map<string, string>();
  const clients = new Map<string, { project: string }>();
  return {
    progressUnsubscribers,
    lastProgressEmittedAt,
    projectSessions,
    sessionTransports: transports as unknown as Map<string, ClosableTransport>,
    sessionHandles,
    sessionClients,
    clients,
    transports,
  };
}

describe('teardownProjectBookkeeping', () => {
  it('unsubscribes the progress listener and drops the map entry', () => {
    const deps = makeDeps();
    const unsub = vi.fn();
    deps.progressUnsubscribers.set(ROOT_A, unsub);

    teardownProjectBookkeeping(ROOT_A, deps);

    expect(unsub).toHaveBeenCalledOnce();
    expect(deps.progressUnsubscribers.has(ROOT_A)).toBe(false);
  });

  it('swallows throwing unsubscribers and still deletes the entry', () => {
    const deps = makeDeps();
    deps.progressUnsubscribers.set(ROOT_A, () => {
      throw new Error('listener exploded');
    });

    expect(() => teardownProjectBookkeeping(ROOT_A, deps)).not.toThrow();
    expect(deps.progressUnsubscribers.has(ROOT_A)).toBe(false);
  });

  it('closes live transports for every session bound to the project', () => {
    const deps = makeDeps();
    const close1 = vi.fn().mockResolvedValue(undefined);
    const close2 = vi.fn().mockResolvedValue(undefined);
    deps.projectSessions.set(ROOT_A, new Set(['sid-1', 'sid-2']));
    deps.transports.set('sid-1', { close: close1 });
    deps.transports.set('sid-2', { close: close2 });

    teardownProjectBookkeeping(ROOT_A, deps);

    expect(close1).toHaveBeenCalledOnce();
    expect(close2).toHaveBeenCalledOnce();
    expect(deps.projectSessions.has(ROOT_A)).toBe(false);
  });

  it('cleans straggler maps when the transport is already gone', () => {
    const deps = makeDeps();
    const dispose = vi.fn();
    deps.projectSessions.set(ROOT_A, new Set(['sid-orphan']));
    // No transport for sid-orphan — simulate transport.onclose having
    // already removed it but bookkeeping still dangling.
    deps.sessionHandles.set('sid-orphan', { dispose });
    deps.sessionClients.set('sid-orphan', 'client-42');
    deps.clients.set('client-42', { project: ROOT_A });

    teardownProjectBookkeeping(ROOT_A, deps);

    expect(dispose).toHaveBeenCalledOnce();
    expect(deps.sessionHandles.has('sid-orphan')).toBe(false);
    expect(deps.sessionClients.has('sid-orphan')).toBe(false);
    expect(deps.clients.has('client-42')).toBe(false);
    expect(deps.projectSessions.has(ROOT_A)).toBe(false);
  });

  it('prunes lastProgressEmittedAt keys for the removed root by prefix', () => {
    const deps = makeDeps();
    deps.lastProgressEmittedAt.set(`${ROOT_A}::index`, 1);
    deps.lastProgressEmittedAt.set(`${ROOT_A}::embed`, 2);
    deps.lastProgressEmittedAt.set(`${ROOT_B}::index`, 3);

    teardownProjectBookkeeping(ROOT_A, deps);

    expect(deps.lastProgressEmittedAt.has(`${ROOT_A}::index`)).toBe(false);
    expect(deps.lastProgressEmittedAt.has(`${ROOT_A}::embed`)).toBe(false);
    expect(deps.lastProgressEmittedAt.get(`${ROOT_B}::index`)).toBe(3);
  });

  it('is a no-op for unknown roots (idempotent)', () => {
    const deps = makeDeps();
    // Populate sibling state so we can prove nothing else is touched.
    const unsub = vi.fn();
    deps.progressUnsubscribers.set(ROOT_A, unsub);
    deps.lastProgressEmittedAt.set(`${ROOT_A}::index`, 1);

    teardownProjectBookkeeping('/never/registered', deps);

    expect(unsub).not.toHaveBeenCalled();
    expect(deps.progressUnsubscribers.has(ROOT_A)).toBe(true);
    expect(deps.lastProgressEmittedAt.get(`${ROOT_A}::index`)).toBe(1);
  });

  it('does not touch other projects when tearing down one', () => {
    const deps = makeDeps();
    const unsubA = vi.fn();
    const unsubB = vi.fn();
    deps.progressUnsubscribers.set(ROOT_A, unsubA);
    deps.progressUnsubscribers.set(ROOT_B, unsubB);
    deps.projectSessions.set(ROOT_A, new Set(['sid-a']));
    deps.projectSessions.set(ROOT_B, new Set(['sid-b']));
    deps.transports.set('sid-a', { close: vi.fn().mockResolvedValue(undefined) });
    const closeB = vi.fn().mockResolvedValue(undefined);
    deps.transports.set('sid-b', { close: closeB });

    teardownProjectBookkeeping(ROOT_A, deps);

    expect(unsubA).toHaveBeenCalledOnce();
    expect(unsubB).not.toHaveBeenCalled();
    expect(closeB).not.toHaveBeenCalled();
    expect(deps.progressUnsubscribers.has(ROOT_B)).toBe(true);
    expect(deps.projectSessions.get(ROOT_B)?.has('sid-b')).toBe(true);
  });
});
