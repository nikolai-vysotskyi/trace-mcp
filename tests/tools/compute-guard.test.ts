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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { BudgetGuard, forTool } from '../../src/compute-guard.js';
import type { Store } from '../../src/db/store.js';
import type { ServerContext } from '../../src/server/types.js';
import { getPageRank } from '../../src/tools/analysis/graph-analysis.js';
import { getCallGraph } from '../../src/tools/framework/call-graph.js';
import { findReferences } from '../../src/tools/framework/references.js';
import { registerAnalysisTools } from '../../src/tools/register/analysis.js';
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

// ── Review follow-ups (PR #894) ────────────────────────────────────────────
// Three properties an abort must hold beyond "it stopped": the response schema
// must not change shape under resource pressure, a truncated scan must not
// claim authoritative negative evidence, and PageRank must actually consume
// the iteration ceiling instead of only sampling between sweeps.

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; _meta?: unknown }>;
}

function makeCtx(store: Store): ServerContext {
  return {
    store,
    projectRoot: '/tmp',
    config: {},
    registry: { getAllFrameworkPlugins: () => [] },
    topoStore: null,
    j: (v: unknown) => JSON.stringify(v),
    jh: (_tool: string, v: unknown) => JSON.stringify(v),
    guardPath: () => null,
  } as unknown as ServerContext;
}

/** Run `fn` with the iteration ceiling pinned, restoring the previous value. */
async function withIterationCeiling<T>(limit: number, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.TRACE_MCP_COMPUTE_MAX_ITERATIONS;
  process.env.TRACE_MCP_COMPUTE_MAX_ITERATIONS = String(limit);
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.TRACE_MCP_COMPUTE_MAX_ITERATIONS;
    else process.env.TRACE_MCP_COMPUTE_MAX_ITERATIONS = prev;
  }
}

describe('abort does not change what a tool promises', () => {
  let store: Store;
  let tools: Record<string, RegisteredTool>;

  beforeEach(() => {
    store = createTestStore();
    store.ensureEdgeType('imports', 'code', 'Module import');
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerAnalysisTools(server, makeCtx(store));
    tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools;
  });

  /** Two files importing each other — a real, findable cycle. */
  function buildCycle(): void {
    const a = store.insertFile('src/a.ts', 'typescript', null, null);
    const b = store.insertFile('src/b.ts', 'typescript', null, null);
    const aNode = store.getNodeId('file', a)!;
    const bNode = store.getNodeId('file', b)!;
    store.insertEdge(aNode, bNode, 'imports');
    store.insertEdge(bNode, aNode, 'imports');
  }

  it('get_pagerank keeps its array payload when the guard trips', async () => {
    buildCycle();
    const result = await withIterationCeiling(1, () => tools.get_pagerank.handler({}, {}));

    // The advertised contract is a bare array — conditioning the schema on
    // resource pressure would break clients exactly when the partial answer
    // is supposed to stay usable.
    expect(Array.isArray(JSON.parse(result.content[0].text))).toBe(true);
    // The reason rides the MCP result's own metadata channel instead.
    expect(
      (result._meta as { _budget_exceeded?: { reason: string } })._budget_exceeded?.reason,
    ).toBe('iterations');
  });

  it('an aborted cycle scan does not claim the graph is acyclic', async () => {
    buildCycle();
    const result = await withIterationCeiling(1, () => tools.get_circular_imports.handler({}, {}));
    const payload = JSON.parse(result.content[0].text) as {
      total_cycles: number;
      evidence?: unknown;
      _budget_exceeded?: { reason: string };
    };

    expect(payload._budget_exceeded?.reason).toBe('iterations');
    // The cycle is real; a truncated scan that reports zero must not also
    // report "we looked and found nothing".
    expect(payload.evidence).toBeUndefined();
  });

  it('a completed cycle scan still emits negative evidence', async () => {
    store.insertFile('src/lonely.ts', 'typescript', null, null);
    const result = await tools.get_circular_imports.handler({}, {});
    const payload = JSON.parse(result.content[0].text) as {
      total_cycles: number;
      evidence?: unknown;
      _budget_exceeded?: unknown;
    };

    expect(payload.total_cycles).toBe(0);
    expect(payload._budget_exceeded).toBeUndefined();
    expect(payload.evidence).toBeDefined();
  });
});

describe('PageRank consumes the iteration ceiling', () => {
  it('ticks inside the sweep and returns the last converged vector', () => {
    const store = createTestStore();
    store.ensureEdgeType('imports', 'code', 'Module import');
    const ids = ['src/p0.ts', 'src/p1.ts', 'src/p2.ts'].map(
      (p) => store.getNodeId('file', store.insertFile(p, 'typescript', null, null))!,
    );
    store.insertEdge(ids[0], ids[1], 'imports');
    store.insertEdge(ids[1], ids[2], 'imports');
    store.insertEdge(ids[2], ids[0], 'imports');

    const guard = testGuard({ iterations: 1 });
    const results = getPageRank(store, { tolerance: 0 }, guard);

    expect(guard.aborted).toBe(true);
    expect(guard.consumed).toBeGreaterThan(0);
    // Scores come from the last fully completed sweep, so they are still a
    // valid (just less converged) ranking rather than a half-filled buffer.
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(Number.isFinite(r.score)).toBe(true);
  });
});

describe('find_usages under a ceiling', () => {
  it('marks a truncated scan so the caller cannot read zero as absence', () => {
    const store = createTestStore();
    store.ensureEdgeType('calls', 'code', 'Function calls');
    const fileId = store.insertFile('src/u.ts', 'typescript', null, null);
    const target = store.insertSymbol(fileId, {
      symbolId: 'src/u.ts::target#function',
      name: 'target',
      kind: 'function',
      byteStart: 0,
      byteEnd: 10,
      lineStart: 1,
      lineEnd: 1,
    });
    const targetNode = store.getNodeId('symbol', target)!;
    for (let i = 0; i < 5; i++) {
      const caller = store.insertSymbol(fileId, {
        symbolId: `src/u.ts::caller${i}#function`,
        name: `caller${i}`,
        kind: 'function',
        byteStart: 0,
        byteEnd: 10,
        lineStart: i + 2,
        lineEnd: i + 2,
      });
      store.insertEdge(store.getNodeId('symbol', caller)!, targetNode, 'calls');
    }

    const guard = testGuard({ iterations: 1 });
    const result = findReferences(store, { symbolId: 'src/u.ts::target#function' }, guard);

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value._budget_exceeded?.reason).toBe('iterations');
    // The register layer keys its `indexed_no_edges` verdict off the absence
    // of this field, so a truncated scan can never produce that claim.
    expect(value._budget_exceeded).toBeDefined();
  });
});
