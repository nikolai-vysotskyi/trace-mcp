/**
 * Tests for the traverse_graph BFS walker.
 *
 * The contract surface that downstream callers rely on:
 *   - depth from root is correct
 *   - direction (outgoing / incoming / both) actually changes the visited set
 *   - max_depth, max_nodes, token_budget each independently truncate the walk
 *     and report which limit fired
 *   - edge_types[] filters out non-matching edges
 *   - cycles don't loop forever
 */
import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { traverseGraph } from '../../src/tools/analysis/traverse-graph.js';

function makeChain(): { store: Store; aId: string; bId: string; cId: string; dId: string } {
  const db = initializeDatabase(':memory:');
  const store = new Store(db);
  const fileId = store.insertFile('src/chain.ts', 'typescript', 'h-chain', 100);
  const aId = 'src/chain.ts::A#class';
  const bId = 'src/chain.ts::B#class';
  const cId = 'src/chain.ts::C#class';
  const dId = 'src/chain.ts::D#class';

  for (const sid of [aId, bId, cId, dId]) {
    store.insertSymbol(fileId, {
      symbolId: sid,
      name: sid.split('::')[1].split('#')[0],
      kind: 'class',
      fqn: sid,
      byteStart: 0,
      byteEnd: 1,
    });
  }
  store.ensureEdgeType('calls', 'core', 'Call edge');

  const aDb = store.getSymbolBySymbolId(aId)!;
  const bDb = store.getSymbolBySymbolId(bId)!;
  const cDb = store.getSymbolBySymbolId(cId)!;
  const dDb = store.getSymbolBySymbolId(dId)!;

  const aNode = store.getNodeId('symbol', aDb.id)!;
  const bNode = store.getNodeId('symbol', bDb.id)!;
  const cNode = store.getNodeId('symbol', cDb.id)!;
  const dNode = store.getNodeId('symbol', dDb.id)!;

  // A → B → C → D
  store.insertEdge(aNode, bNode, 'calls');
  store.insertEdge(bNode, cNode, 'calls');
  store.insertEdge(cNode, dNode, 'calls');

  return { store, aId, bId, cId, dId };
}

describe('traverseGraph — basic BFS', () => {
  it('walks outgoing edges in BFS order with correct depths', () => {
    const { store, aId } = makeChain();
    const r = traverseGraph(store, { start_symbol_id: aId, direction: 'outgoing', max_depth: 3 });
    expect(r).not.toBeNull();
    const names = r!.nodes.map((n) => n.name);
    expect(names).toEqual(['A', 'B', 'C', 'D']);
    expect(r!.nodes.find((n) => n.name === 'A')!.depth).toBe(0);
    expect(r!.nodes.find((n) => n.name === 'B')!.depth).toBe(1);
    expect(r!.nodes.find((n) => n.name === 'C')!.depth).toBe(2);
    expect(r!.nodes.find((n) => n.name === 'D')!.depth).toBe(3);
    expect(r!.truncated_by_depth).toBe(false);
    expect(r!.truncated_by_nodes).toBe(false);
  });

  it('respects max_depth and reports truncated_by_depth', () => {
    const { store, aId } = makeChain();
    const r = traverseGraph(store, { start_symbol_id: aId, direction: 'outgoing', max_depth: 1 });
    expect(r!.nodes.map((n) => n.name).sort()).toEqual(['A', 'B']);
    expect(r!.truncated_by_depth).toBe(true);
  });

  it('walks incoming edges from the leaf', () => {
    const { store, dId } = makeChain();
    const r = traverseGraph(store, { start_symbol_id: dId, direction: 'incoming', max_depth: 5 });
    const names = r!.nodes.map((n) => n.name);
    expect(names).toEqual(['D', 'C', 'B', 'A']);
  });

  it('"both" walks in either direction from a middle node', () => {
    const { store, bId } = makeChain();
    const r = traverseGraph(store, { start_symbol_id: bId, direction: 'both', max_depth: 5 });
    const names = r!.nodes.map((n) => n.name).sort();
    expect(names).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('traverseGraph — limits', () => {
  it('honours max_nodes and reports truncated_by_nodes', () => {
    const { store, aId } = makeChain();
    const r = traverseGraph(store, {
      start_symbol_id: aId,
      direction: 'outgoing',
      max_depth: 5,
      max_nodes: 2,
    });
    expect(r!.nodes.length).toBe(2);
    expect(r!.truncated_by_nodes).toBe(true);
  });

  it('honours token_budget and reports truncated_by_budget', () => {
    const { store, aId } = makeChain();
    // Choose a budget that fits ~1 node — every node costs ~50+ chars / 4 ≈ 13 tokens.
    const r = traverseGraph(store, {
      start_symbol_id: aId,
      direction: 'outgoing',
      max_depth: 5,
      token_budget: 20,
    });
    expect(r!.truncated_by_budget).toBe(true);
    expect(r!.nodes.length).toBeLessThan(4);
  });
});

describe('traverseGraph — filters', () => {
  it('respects edge_types filter', () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    const fileId = store.insertFile('src/x.ts', 'typescript', 'h', 100);
    const aId = 'src/x.ts::A#class';
    const bId = 'src/x.ts::B#class';
    store.insertSymbol(fileId, {
      symbolId: aId,
      name: 'A',
      kind: 'class',
      fqn: aId,
      byteStart: 0,
      byteEnd: 1,
    });
    store.insertSymbol(fileId, {
      symbolId: bId,
      name: 'B',
      kind: 'class',
      fqn: bId,
      byteStart: 0,
      byteEnd: 1,
    });
    store.ensureEdgeType('calls', 'core', 'x');
    store.ensureEdgeType('imports', 'core', 'x');

    const aNode = store.getNodeId('symbol', store.getSymbolBySymbolId(aId)!.id)!;
    const bNode = store.getNodeId('symbol', store.getSymbolBySymbolId(bId)!.id)!;
    store.insertEdge(aNode, bNode, 'imports');

    // No `calls` edge exists between A and B — filter to calls and B should
    // never be reached.
    const onlyCalls = traverseGraph(store, {
      start_symbol_id: aId,
      direction: 'outgoing',
      edge_types: ['calls'],
      max_depth: 5,
    });
    expect(onlyCalls!.nodes.map((n) => n.name)).toEqual(['A']);

    // With the imports filter, B is reachable.
    const onlyImports = traverseGraph(store, {
      start_symbol_id: aId,
      direction: 'outgoing',
      edge_types: ['imports'],
      max_depth: 5,
    });
    expect(onlyImports!.nodes.map((n) => n.name).sort()).toEqual(['A', 'B']);
  });
});

describe('traverseGraph — error paths', () => {
  it('returns null when the start symbol is not in the index', () => {
    const { store } = makeChain();
    const r = traverseGraph(store, { start_symbol_id: 'src/missing.ts::Nope#class' });
    expect(r).toBeNull();
  });

  it('does not loop on cycles', () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    const fileId = store.insertFile('src/cycle.ts', 'typescript', 'h', 100);
    const aId = 'src/cycle.ts::A#class';
    const bId = 'src/cycle.ts::B#class';
    store.insertSymbol(fileId, {
      symbolId: aId,
      name: 'A',
      kind: 'class',
      fqn: aId,
      byteStart: 0,
      byteEnd: 1,
    });
    store.insertSymbol(fileId, {
      symbolId: bId,
      name: 'B',
      kind: 'class',
      fqn: bId,
      byteStart: 0,
      byteEnd: 1,
    });
    store.ensureEdgeType('calls', 'core', 'x');
    const aNode = store.getNodeId('symbol', store.getSymbolBySymbolId(aId)!.id)!;
    const bNode = store.getNodeId('symbol', store.getSymbolBySymbolId(bId)!.id)!;
    store.insertEdge(aNode, bNode, 'calls');
    store.insertEdge(bNode, aNode, 'calls');

    const r = traverseGraph(store, { start_symbol_id: aId, direction: 'outgoing', max_depth: 10 });
    expect(r!.nodes.length).toBe(2);
  });
});
