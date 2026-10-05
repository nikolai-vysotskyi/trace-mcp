/**
 * Retiring a branch index (GH #1481, step 2) under calls that are still
 * running. A fake tool-host handle with handlers the test releases by hand
 * keeps every interleaving deterministic.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BranchIndex,
  DEFAULT_WORKTREE_INDEX_SETTINGS,
  type SnapshotMeta,
  WorktreeIndexManager,
} from '../../src/daemon/worktree-index.js';
import type { ToolResponse } from '../../src/server/types.js';

interface Gate {
  promise: Promise<ToolResponse>;
  release: () => void;
}

function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<ToolResponse>((resolve) => {
    release = () => resolve({ content: [{ type: 'text', text: '{}' }] });
  });
  return { promise, release };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('branch index retirement', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-wt-retire-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A ready copy whose `slow` tool waits on the gates handed out in order. */
  function readyIndex(gates: Gate[]) {
    const owner = new WorktreeIndexManager({
      settings: DEFAULT_WORKTREE_INDEX_SETTINGS,
      getCanonical: () => undefined,
      dir: tmp,
    });
    const meta: SnapshotMeta = {
      schema: 1,
      worktree_root: path.join(tmp, 'wt'),
      canonical_root: path.join(tmp, 'main'),
      canonical_head: 'a'.repeat(40),
      version: 'test',
      created_at: 0,
      last_used_at: 0,
      applied: [],
    };
    const index = new BranchIndex(
      owner,
      { dbPath: path.join(tmp, 'x.db'), metaPath: path.join(tmp, 'x.json'), meta },
      0,
    );
    let disposed = false;
    let next = 0;
    // Stands in for the tool-host server `open()` would create.
    Object.assign(index as unknown as Record<string, unknown>, {
      handle: {
        toolHandlers: new Map([['slow', () => gates[next++].promise]]),
        dispose: () => {
          disposed = true;
        },
        server: { close: async () => {} },
      },
    });
    index.markReady(0);
    return { index, disposed: () => disposed };
  }

  it('refuses new calls once retiring and closes only after the running ones', async () => {
    const gates = [gate(), gate()];
    const { index, disposed } = readyIndex(gates);
    const first = index.run('slow', {});
    const second = index.run('slow', {});
    let closed = false;
    const closing = index.close({ drainMs: 10_000 }).then(() => {
      closed = true;
    });
    await tick();
    expect(index.state).toBe('retiring');

    // A batch's next sub-call arriving now goes back to the canonical index.
    expect(await index.run('slow', {})).toBeUndefined();

    gates[0].release();
    await first;
    await tick();
    expect(closed).toBe(false);
    expect(disposed()).toBe(false);

    gates[1].release();
    await second;
    await closing;
    expect(index.state).toBe('closed');
    expect(disposed()).toBe(true);
  });

  it('closes after the drain budget even with a call still running', async () => {
    const gates = [gate()];
    const { index } = readyIndex(gates);
    void index.run('slow', {});
    await index.close({ drainMs: 20 });
    expect(index.state).toBe('closed');
    gates[0].release();
  });
});
