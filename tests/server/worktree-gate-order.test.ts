/**
 * The worktree delta is a git subprocess: the gate must start it before the
 * tool handler runs (so the two overlap) and must not wait for it when the
 * handler failed (GH #1481 review).
 */
import { describe, expect, it, vi } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { SessionJournal } from '../../src/session/journal.js';
import { SessionTracker } from '../../src/session/tracker.js';
import { installToolGate } from '../../src/server/tool-gate.js';
import type { WorktreeDelta } from '../../src/worktree-delta.js';

const delta: WorktreeDelta = {
  worktreeRoot: '/wt',
  canonicalRoot: '/main',
  worktreeHead: 'a'.repeat(40),
  canonicalHead: 'b'.repeat(40),
  modified: ['src/a.ts'],
  deleted: [],
  untracked: [],
  computedAt: 0,
};

function gated(
  getWorktreeDelta: () => Promise<WorktreeDelta | null>,
  handler: () => unknown,
): () => Promise<{ content: Array<{ text: string }> }> {
  const toolSpy = vi.fn(() => ({ enabled: true }));
  const server = { tool: toolSpy };
  installToolGate(
    server as never,
    TraceMcpConfigSchema.parse({ tools: { preset: 'full' } }),
    new Set(['demo']),
    new SessionTracker('/wt', null),
    new SessionJournal(),
    JSON.stringify,
    () => 0,
    () => undefined,
    () => undefined,
    '/wt',
    undefined,
    undefined,
    undefined,
    getWorktreeDelta,
  );
  (server.tool as unknown as (...a: unknown[]) => unknown)('demo', 'demo tool', {}, handler);
  const received = toolSpy.mock.calls.at(-1) as unknown[];
  return received.at(-1) as never;
}

describe('worktree delta in the tool gate', () => {
  it('starts the delta before the handler and still flags the result', async () => {
    const order: string[] = [];
    const cb = gated(
      async () => {
        order.push('delta');
        return delta;
      },
      () => {
        order.push('handler');
        return { content: [{ type: 'text', text: JSON.stringify({ file: 'src/a.ts' }) }] };
      },
    );
    const res = await cb();
    expect(order).toEqual(['delta', 'handler']);
    expect(JSON.parse(res.content[0].text).stale_on_branch).toBe(true);
  });

  it('does not wait for the delta when the handler returned an error', async () => {
    const never = new Promise<WorktreeDelta | null>(() => {});
    const cb = gated(
      () => never,
      () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }),
    );
    const res = await Promise.race([
      cb(),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 500)),
    ]);
    expect(res).not.toBe('hung');
    expect((res as { content: Array<{ text: string }> }).content[0].text).toBe('boom');
  });
});
