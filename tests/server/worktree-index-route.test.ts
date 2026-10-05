/**
 * The tool gate and `batch` dispatch to a worktree's branch index through
 * `ServerDeps.worktreeIndex` (GH #1481 step 2). A fake route stands in for the
 * daemon's copy, so this pins the session side only: what is delegated, what
 * stays on the session, the fallback, and which files are flagged.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { ProgressState } from '../../src/progress.js';
import { createServer } from '../../src/server/server.js';
import type { ToolResponse } from '../../src/server/types.js';
import type { WorktreeIndexTarget } from '../../src/server/worktree-index-route.js';
import type { WorktreeDelta } from '../../src/worktree-delta.js';

type Json = Record<string, unknown>;

const pendingDelta = (files: string[]): WorktreeDelta => ({
  worktreeRoot: '/wt',
  canonicalRoot: '/main',
  worktreeHead: 'a'.repeat(40),
  canonicalHead: 'b'.repeat(40),
  modified: files,
  deleted: [],
  untracked: [],
  computedAt: 0,
});

describe('worktree index route', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
  });

  async function connect(target: WorktreeIndexTarget | null) {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    const fid = store.insertFile('src/a.ts', 'typescript', 'h-a', 100);
    store.insertSymbol(fid, {
      symbolId: 'src/a.ts::alpha#function',
      name: 'alpha',
      kind: 'function',
      fqn: 'alpha',
      byteStart: 0,
      byteEnd: 26,
      lineStart: 1,
      lineEnd: 1,
    });
    const config = TraceMcpConfigSchema.parse({ tools: { preset: 'full' } });
    let resolves = 0;
    const handle = createServer(
      store,
      PluginRegistry.createWithDefaults(),
      config,
      '/main',
      new ProgressState(db),
      {
        worktreeIndex: {
          resolve: async () => {
            resolves++;
            return target;
          },
        },
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'route-probe', version: '1.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(async () => {
      await client.close().catch(() => {});
      handle.dispose();
      db.close();
    });
    const call = async (name: string, args: Json = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ type: string; text: string }>;
      };
      return { text: res.content[0].text, json: JSON.parse(res.content[0].text) as Json };
    };
    return { call, resolves: () => resolves };
  }

  function fakeTarget(pending: string[] = []) {
    const ran: string[] = [];
    const target: WorktreeIndexTarget = {
      run: async (tool): Promise<ToolResponse | undefined> => {
        ran.push(tool);
        if (tool === 'get_outline') {
          return {
            content: [
              { type: 'text', text: JSON.stringify({ path: 'src/a.ts', from: 'branch_index' }) },
            ],
          };
        }
        return undefined;
      },
      pending: () => (pending.length > 0 ? pendingDelta(pending) : null),
    };
    return { target, ran };
  }

  it('answers index tools from the branch index without stale flags', async () => {
    const { target, ran } = fakeTarget();
    const { call } = await connect(target);
    const res = await call('get_outline', { path: 'src/a.ts' });
    expect(res.json.from).toBe('branch_index');
    expect(res.json).not.toHaveProperty('stale_on_branch');
    expect(ran).toEqual(['get_outline']);
  });

  it('flags files the branch index has not re-indexed yet', async () => {
    const { target } = fakeTarget(['src/a.ts']);
    const { call } = await connect(target);
    const res = await call('get_outline', { path: 'src/a.ts' });
    expect(res.json.stale_on_branch).toBe(true);
    expect(JSON.stringify(res.json._warnings)).toContain('re-indexing is under way');
  });

  it("falls back to the session's own handler when the branch index cannot answer", async () => {
    const { target, ran } = fakeTarget();
    const { call } = await connect(target);
    const res = await call('search', { query: 'alpha' });
    expect(ran).toEqual(['search']);
    expect(res.text).toContain('src/a.ts::alpha#function');
  });

  it('keeps session-local tools on the session', async () => {
    const { target, ran } = fakeTarget();
    const { call, resolves } = await connect(target);
    await call('get_session_journal');
    await call('trace_state_list');
    await call('list_pins');
    expect(ran).toEqual([]);
    expect(resolves()).toBe(0);
  });

  it('routes batch sub-calls the same way', async () => {
    const { target, ran } = fakeTarget(['src/a.ts']);
    const { call } = await connect(target);
    const res = await call('batch', {
      calls: [
        { tool: 'get_outline', args: { path: 'src/a.ts' } },
        { tool: 'trace_state_list', args: {} },
      ],
    });
    const results = res.json.batch_results as Array<{ result: Json }>;
    expect(results[0].result.from).toBe('branch_index');
    expect(results[0].result.stale_on_branch).toBe(true);
    expect(ran).toEqual(['get_outline']);
  });

  it('changes nothing while the route has no index to offer', async () => {
    const { call } = await connect(null);
    const res = await call('search', { query: 'alpha' });
    expect(res.text).toContain('src/a.ts::alpha#function');
    expect(res.text).not.toContain('stale_on_branch');
  });
});
