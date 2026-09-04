/**
 * TRA-841 — per-call compute ceiling for heavy graph tools.
 *
 * Two layers are covered:
 *   1. The guard's own decision, per ceiling. The RSS ceiling is asserted
 *      against a *fed* reading, never against real process memory — allocating
 *      gigabytes to trip it is not something CI can do.
 *   2. One end-to-end pass through `getCallGraph` on a synthetic oversized
 *      graph, proving an abort returns a partial result with the marker rather
 *      than throwing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { BudgetGuard, forTool } from '../../src/compute-guard.js';
import type { Store } from '../../src/db/store.js';
import { getCallGraph } from '../../src/tools/framework/call-graph.js';
import { createTestStore } from '../test-utils.js';

const CEILINGS = { timeout_ms: 1000, rss_mb: 500, iterations: 100 };

/** Guard with a fake clock and a fed RSS reading — no real syscalls. */
function testGuard(
  overrides: Partial<typeof CEILINGS> = {},
  deps: { now?: () => number; rssMb?: () => number } = {},
): BudgetGuard {
  return new BudgetGuard(
    'test_tool',
    { ...CEILINGS, ...overrides },
    { now: deps.now ?? (() => 0), rssMb: deps.rssMb ?? (() => 1) },
  );
}

describe('BudgetGuard ceilings', () => {
  it('trips on the iteration ceiling and reports it', () => {
    const guard = testGuard({ iterations: 10 });
    let allowed = 0;
    for (let i = 0; i < 50; i++) {
      if (!guard.tick()) break;
      allowed++;
    }

    expect(allowed).toBe(10);
    expect(guard.aborted).toBe(true);
    const marker = guard.marker()._budget_exceeded!;
    expect(marker.reason).toBe('iterations');
    expect(marker.limit).toBe(10);
    expect(marker.tool).toBe('test_tool');
    // Every further tick stays false — the guard never un-trips.
    expect(guard.tick()).toBe(false);
  });

  it('trips on the wall-clock ceiling', () => {
    let clock = 0;
    const guard = testGuard({ timeout_ms: 500 }, { now: () => clock });

    expect(guard.check()).toBe(true);
    clock = 501;
    expect(guard.check()).toBe(false);

    const marker = guard.marker()._budget_exceeded!;
    expect(marker.reason).toBe('timeout');
    expect(marker.limit).toBe(500);
    expect(marker.elapsed_ms).toBe(501);
  });

  it('trips on the RSS ceiling given a fed reading', () => {
    let rss = 100;
    const guard = testGuard({ rss_mb: 400 }, { rssMb: () => rss });

    expect(guard.check()).toBe(true);
    rss = 401;
    expect(guard.check()).toBe(false);

    const marker = guard.marker()._budget_exceeded!;
    expect(marker.reason).toBe('rss');
    expect(marker.limit).toBe(400);
    expect(marker.rss_mb).toBe(401);
  });

  it('emits no marker while under every ceiling', () => {
    const guard = testGuard();
    for (let i = 0; i < 50; i++) expect(guard.tick()).toBe(true);
    expect(guard.aborted).toBe(false);
    expect(guard.marker()).toEqual({});
  });

  it('samples the clock only every 4096 ticks', () => {
    let now = 0;
    let calls = 0;
    const guard = new BudgetGuard(
      'test_tool',
      { timeout_ms: 1_000_000, rss_mb: 1_000_000, iterations: 1_000_000 },
      {
        now: () => {
          calls++;
          return now;
        },
        rssMb: () => 1,
      },
    );
    calls = 0; // discount the constructor's start-time read
    for (let i = 0; i < 4095; i++) guard.tick();
    expect(calls).toBe(0);
    guard.tick(); // tick 4096 samples
    expect(calls).toBe(1);
  });

  it('TRACE_MCP_NO_COMPUTE_GUARD disables the ceilings entirely', () => {
    const prev = process.env.TRACE_MCP_NO_COMPUTE_GUARD;
    const prevIters = process.env.TRACE_MCP_COMPUTE_MAX_ITERATIONS;
    try {
      process.env.TRACE_MCP_COMPUTE_MAX_ITERATIONS = '5';
      process.env.TRACE_MCP_NO_COMPUTE_GUARD = '1';
      const guard = forTool('get_call_graph');
      for (let i = 0; i < 1000; i++) expect(guard.tick()).toBe(true);
      expect(guard.aborted).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.TRACE_MCP_NO_COMPUTE_GUARD;
      else process.env.TRACE_MCP_NO_COMPUTE_GUARD = prev;
      if (prevIters === undefined) delete process.env.TRACE_MCP_COMPUTE_MAX_ITERATIONS;
      else process.env.TRACE_MCP_COMPUTE_MAX_ITERATIONS = prevIters;
    }
  });

  it('reads ceilings from env', () => {
    const prev = process.env.TRACE_MCP_COMPUTE_MAX_ITERATIONS;
    try {
      process.env.TRACE_MCP_COMPUTE_MAX_ITERATIONS = '3';
      const guard = forTool('get_call_graph');
      expect(guard.tick()).toBe(true);
      expect(guard.tick()).toBe(true);
      expect(guard.tick()).toBe(true);
      expect(guard.tick()).toBe(false);
      expect(guard.marker()._budget_exceeded?.limit).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.TRACE_MCP_COMPUTE_MAX_ITERATIONS;
      else process.env.TRACE_MCP_COMPUTE_MAX_ITERATIONS = prev;
    }
  });
});

describe('getCallGraph under a compute ceiling', () => {
  let store: Store;

  /**
   * A densely connected clique. Phase 3 of the call-graph builder materializes
   * a *tree* out of this, so the node count explodes with depth — exactly the
   * shape that reaches the OOM killer without a ceiling.
   */
  function buildDenseGraph(size: number): void {
    const nodeIds: number[] = [];
    const fileId = store.insertFile('src/dense.ts', 'typescript', null, null);
    for (let i = 0; i < size; i++) {
      const symbolDbId = store.insertSymbol(fileId, {
        symbolId: `src/dense.ts::fn${i}#function`,
        name: `fn${i}`,
        kind: 'function',
        byteStart: 0,
        byteEnd: 10,
        lineStart: i + 1,
        lineEnd: i + 1,
      });
      nodeIds.push(store.getNodeId('symbol', symbolDbId)!);
    }
    for (let i = 0; i < size; i++) {
      for (let k = 0; k < size; k++) {
        if (i !== k) store.insertEdge(nodeIds[i], nodeIds[k], 'calls');
      }
    }
  }

  beforeEach(() => {
    store = createTestStore();
    store.ensureEdgeType('calls', 'code', 'Function calls');
  });

  it('returns a partial result with _budget_exceeded instead of throwing (iterations)', () => {
    buildDenseGraph(12);
    const guard = testGuard({ iterations: 20 });

    const result = getCallGraph(store, { symbolId: 'src/dense.ts::fn0#function' }, 8, guard);

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value._budget_exceeded?.reason).toBe('iterations');
    expect(value._budget_exceeded?.limit).toBe(20);
    // Partial, not empty: the root is still there and still describes fn0.
    expect(value.root.name).toBe('fn0');
  });

  it('returns a partial result when the wall clock runs out', () => {
    buildDenseGraph(12);
    let clock = 0;
    // Every clock read advances time, so the first forced check per depth
    // level trips the ceiling deterministically.
    const guard = testGuard({ timeout_ms: 5 }, { now: () => (clock += 10) });

    const result = getCallGraph(store, { symbolId: 'src/dense.ts::fn0#function' }, 8, guard);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()._budget_exceeded?.reason).toBe('timeout');
  });

  it('leaves no marker on an ordinary call', () => {
    buildDenseGraph(4);
    const guard = testGuard({ iterations: 100_000 });

    const result = getCallGraph(store, { symbolId: 'src/dense.ts::fn0#function' }, 2, guard);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()._budget_exceeded).toBeUndefined();
    expect(guard.aborted).toBe(false);
  });
});
