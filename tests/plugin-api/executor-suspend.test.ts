import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok } from '../../src/errors.js';
import { executeFrameworkResolveEdges } from '../../src/plugin-api/executor.js';
import type { FrameworkPlugin, RawEdge, ResolveContext } from '../../src/plugin-api/types.js';

const ctx = {} as ResolveContext;

function deferredPlugin() {
  let resolve!: (value: ReturnType<typeof ok<RawEdge[]>>) => void;
  const promise = new Promise<ReturnType<typeof ok<RawEdge[]>>>((done) => {
    resolve = done;
  });
  const plugin = {
    manifest: { name: 'suspend-test', version: '1.0.0', priority: 1 },
    resolveEdges: () => promise,
  } as FrameworkPlugin;
  return { plugin, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('framework timeout across suspend', () => {
  it('keeps a pending result after a wall-clock jump and early timer callback', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let wall = 0;
    let active = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    vi.spyOn(performance, 'now').mockImplementation(() => active);
    const { plugin, resolve } = deferredPlugin();
    const result = executeFrameworkResolveEdges(plugin, ctx, 30);

    wall = 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    active = 5;
    const edge = { source: 'a', target: 'b', type: 'test' } as RawEdge;
    resolve(ok([edge]));
    expect((await result)._unsafeUnwrap()).toEqual([edge]);
  });

  it('times out work after the active time budget expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let active = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => active);
    const { plugin } = deferredPlugin();
    const result = executeFrameworkResolveEdges(plugin, ctx, 30);
    active = 30;
    await vi.advanceTimersByTimeAsync(30);
    expect((await result)._unsafeUnwrap()).toEqual([]);
  });

  it('scales timeout for large repositories when using default timeout (TRA-2434)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let active = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => active);
    const { plugin, resolve } = deferredPlugin();
    // 5,000 files => Math.ceil(5000 / 100) * 1000 = 50,000ms
    const largeRepoCtx = {
      getAllFiles: () =>
        Array.from({ length: 5000 }, (_, i) => ({
          id: i,
          path: `f${i}.ts`,
          language: 'typescript',
        })),
    } as unknown as ResolveContext;

    const result = executeFrameworkResolveEdges(plugin, largeRepoCtx);
    // At 35,000ms, standard 30s timeout would have expired, but scaled timeout (50s) is still active
    active = 35_000;
    await vi.advanceTimersByTimeAsync(35_000);
    const edge = { source: 'a', target: 'b', type: 'test' } as RawEdge;
    resolve(ok([edge]));
    expect((await result)._unsafeUnwrap()).toEqual([edge]);
  });
});
