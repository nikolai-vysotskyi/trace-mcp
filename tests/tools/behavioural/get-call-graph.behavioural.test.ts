/**
 * Behavioural coverage for `getCallGraph()`. Builds an in-memory graph with
 * symbol-level `calls` edges and asserts the bidirectional shape (calls +
 * called_by), depth honouring, empty contract, and cycle safety.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getCallGraph } from '../../../src/tools/framework/call-graph.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
  centerSymbolId: string;
  isolatedSymbolId: string;
  cycleASymbolId: string;
  cycleBSymbolId: string;
  leafCallerSymbolId: string;
  leafCalleeSymbolId: string;
}

/**
 * Build:
 *   - center (centerFn) with one caller (callerFn -> center) and one callee
 *     (center -> calleeFn), so calls/called_by both populated at depth >= 1.
 *   - A chain caller -> center -> callee -> deepCallee at depth 2.
 *   - An isolated symbol with no edges.
 *   - A two-node cycle A <-> B to verify the BFS doesn't loop.
 */
function seed(): Fixture {
  const store = createTestStore();

  const centerFid = store.insertFile('src/center.ts', 'typescript', 'h-c', 200);
  const centerSym = store.insertSymbol(centerFid, {
    symbolId: 'src/center.ts::centerFn#function',
    name: 'centerFn',
    kind: 'function',
    fqn: 'centerFn',
    byteStart: 0,
    byteEnd: 80,
    lineStart: 1,
    lineEnd: 10,
  });
  const centerNid = store.getNodeId('symbol', centerSym)!;

  const callerFid = store.insertFile('src/caller.ts', 'typescript', 'h-cl', 100);
  const callerSym = store.insertSymbol(callerFid, {
    symbolId: 'src/caller.ts::callerFn#function',
    name: 'callerFn',
    kind: 'function',
    fqn: 'callerFn',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 8,
  });
  const callerNid = store.getNodeId('symbol', callerSym)!;

  const calleeFid = store.insertFile('src/callee.ts', 'typescript', 'h-ce', 100);
  const calleeSym = store.insertSymbol(calleeFid, {
    symbolId: 'src/callee.ts::calleeFn#function',
    name: 'calleeFn',
    kind: 'function',
    fqn: 'calleeFn',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 8,
  });
  const calleeNid = store.getNodeId('symbol', calleeSym)!;

  // Deep callee — should appear at depth 2 but not depth 1.
  const deepFid = store.insertFile('src/deep.ts', 'typescript', 'h-de', 100);
  const deepSym = store.insertSymbol(deepFid, {
    symbolId: 'src/deep.ts::deepCalleeFn#function',
    name: 'deepCalleeFn',
    kind: 'function',
    fqn: 'deepCalleeFn',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 8,
  });
  const deepNid = store.getNodeId('symbol', deepSym)!;

  store.insertEdge(callerNid, centerNid, 'calls', true, undefined, false, 'ast_resolved');
  store.insertEdge(centerNid, calleeNid, 'calls', true, undefined, false, 'ast_resolved');
  store.insertEdge(calleeNid, deepNid, 'calls', true, undefined, false, 'ast_resolved');

  // Isolated symbol — no edges at all.
  const isoFid = store.insertFile('src/iso.ts', 'typescript', 'h-i', 50);
  store.insertSymbol(isoFid, {
    symbolId: 'src/iso.ts::loneFn#function',
    name: 'loneFn',
    kind: 'function',
    fqn: 'loneFn',
    byteStart: 0,
    byteEnd: 20,
    lineStart: 1,
    lineEnd: 3,
  });

  // 2-cycle: aFn -> bFn -> aFn. Must not infinite loop.
  const aFid = store.insertFile('src/a.ts', 'typescript', 'h-a', 50);
  const aSym = store.insertSymbol(aFid, {
    symbolId: 'src/a.ts::aFn#function',
    name: 'aFn',
    kind: 'function',
    fqn: 'aFn',
    byteStart: 0,
    byteEnd: 20,
    lineStart: 1,
    lineEnd: 3,
  });
  const aNid = store.getNodeId('symbol', aSym)!;
  const bFid = store.insertFile('src/b.ts', 'typescript', 'h-b', 50);
  const bSym = store.insertSymbol(bFid, {
    symbolId: 'src/b.ts::bFn#function',
    name: 'bFn',
    kind: 'function',
    fqn: 'bFn',
    byteStart: 0,
    byteEnd: 20,
    lineStart: 1,
    lineEnd: 3,
  });
  const bNid = store.getNodeId('symbol', bSym)!;
  store.insertEdge(aNid, bNid, 'calls', true, undefined, false, 'ast_resolved');
  store.insertEdge(bNid, aNid, 'calls', true, undefined, false, 'ast_resolved');

  return {
    store,
    centerSymbolId: 'src/center.ts::centerFn#function',
    isolatedSymbolId: 'src/iso.ts::loneFn#function',
    cycleASymbolId: 'src/a.ts::aFn#function',
    cycleBSymbolId: 'src/b.ts::bFn#function',
    leafCallerSymbolId: 'src/caller.ts::callerFn#function',
    leafCalleeSymbolId: 'src/callee.ts::calleeFn#function',
  };
}

function collectNames(node: { calls?: unknown; called_by?: unknown; name: string }): {
  calls: string[];
  called_by: string[];
} {
  const calls: string[] = [];
  const called_by: string[] = [];
  const c = node.calls as Array<{ name: string }> | undefined;
  const cb = node.called_by as Array<{ name: string }> | undefined;
  if (Array.isArray(c)) for (const x of c) calls.push(x.name);
  if (Array.isArray(cb)) for (const x of cb) called_by.push(x.name);
  return { calls, called_by };
}

describe('getCallGraph() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('returns root with bidirectional calls + called_by populated', () => {
    const result = getCallGraph(ctx.store, { symbolId: ctx.centerSymbolId }, 2);
    expect(result.isOk()).toBe(true);
    const graph = result._unsafeUnwrap();
    expect(graph.root).toBeDefined();
    expect(graph.root.symbol_id).toBe(ctx.centerSymbolId);
    expect(graph.root.name).toBe('centerFn');
    const { calls, called_by } = collectNames(graph.root);
    expect(calls).toContain('calleeFn');
    expect(called_by).toContain('callerFn');
  });

  it('output shape: root + edge_types_used + max_depth + resolution_tiers', () => {
    const result = getCallGraph(ctx.store, { symbolId: ctx.centerSymbolId });
    expect(result.isOk()).toBe(true);
    const graph = result._unsafeUnwrap();
    expect(graph.root.symbol_id).toBe(ctx.centerSymbolId);
    expect(Array.isArray(graph.edge_types_used)).toBe(true);
    expect(graph.edge_types_used).toContain('calls');
    expect(typeof graph.max_depth).toBe('number');
    expect(graph.resolution_tiers).toBeDefined();
    expect(typeof graph.resolution_tiers.ast_resolved).toBe('number');
    expect(graph.resolution_tiers.ast_resolved).toBeGreaterThan(0);
  });

  it('depth=1 does not reach a 2-hop callee', () => {
    const shallow = getCallGraph(ctx.store, { symbolId: ctx.centerSymbolId }, 1);
    const deep = getCallGraph(ctx.store, { symbolId: ctx.centerSymbolId }, 2);
    expect(shallow.isOk() && deep.isOk()).toBe(true);

    // depth 1: center.calls should contain calleeFn but calleeFn.calls (the
    // 2-hop reach to deepCalleeFn) should not exist.
    const shallowRoot = shallow._unsafeUnwrap().root;
    const deepRoot = deep._unsafeUnwrap().root;

    const shallowCalls = (shallowRoot.calls ?? []) as Array<{ name: string; calls?: unknown }>;
    const deepCalls = (deepRoot.calls ?? []) as Array<{
      name: string;
      calls?: Array<{ name: string }>;
    }>;
    const shallowCallee = shallowCalls.find((c) => c.name === 'calleeFn');
    const deepCallee = deepCalls.find((c) => c.name === 'calleeFn');
    expect(shallowCallee).toBeDefined();
    expect(deepCallee).toBeDefined();
    // Either undefined or empty — but the deep variant must populate deepCalleeFn.
    const shallowHasDeep = (shallowCallee?.calls as Array<{ name: string }> | undefined)?.some(
      (n) => n.name === 'deepCalleeFn',
    );
    const deepHasDeep = (deepCallee?.calls as Array<{ name: string }> | undefined)?.some(
      (n) => n.name === 'deepCalleeFn',
    );
    expect(shallowHasDeep).toBeFalsy();
    expect(deepHasDeep).toBe(true);
  });

  it('isolated symbol with no edges returns root with empty/undefined branches', () => {
    const result = getCallGraph(ctx.store, { symbolId: ctx.isolatedSymbolId });
    expect(result.isOk()).toBe(true);
    const graph = result._unsafeUnwrap();
    expect(graph.root.symbol_id).toBe(ctx.isolatedSymbolId);
    const calls = graph.root.calls as unknown[] | undefined;
    const called_by = graph.root.called_by as unknown[] | undefined;
    // Either undefined OR empty array — both express "no edges".
    expect(calls === undefined || calls.length === 0).toBe(true);
    expect(called_by === undefined || called_by.length === 0).toBe(true);
  });

  it('a 2-cycle (A<->B) does not infinite-loop and produces a finite tree', () => {
    const result = getCallGraph(ctx.store, { symbolId: ctx.cycleASymbolId }, 5);
    expect(result.isOk()).toBe(true);
    const graph = result._unsafeUnwrap();
    // We just need to terminate and produce a valid root for aFn.
    expect(graph.root.symbol_id).toBe(ctx.cycleASymbolId);
    expect(graph.root.name).toBe('aFn');
    // Cycle should still surface bFn as either a callee or caller at depth 1.
    const { calls, called_by } = collectNames(graph.root);
    expect([...calls, ...called_by]).toContain('bFn');
  });

  it('unknown symbol_id surfaces NOT_FOUND error', () => {
    const result = getCallGraph(ctx.store, { symbolId: 'src/nope.ts::ghost#function' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('NOT_FOUND');
  });
});
