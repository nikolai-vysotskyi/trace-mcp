/**
 * Tests for get_call_graph tool.
 * Uses in-memory store with manually inserted symbols + edges.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../../src/db/store.js';
import { getCallGraph } from '../../src/tools/framework/call-graph.js';
import { createTestStore } from '../test-utils.js';

function insertSymbol(store: Store, fileId: number, name: string, fqn: string, kind = 'function'): number {
  return store.insertSymbol(fileId, {
    symbolId: `sym:${fqn}`,
    name,
    kind,
    fqn,
    byteStart: 0,
    byteEnd: 100,
  });
}

describe('get_call_graph', () => {
  let store: Store;
  let fileId: number;

  beforeEach(() => {
    store = createTestStore();
    fileId = store.insertFile('src/app.ts', 'typescript', 'h1', 500);
  });

  it('returns NOT_FOUND for unknown symbol', () => {
    const result = getCallGraph(store, { symbolId: 'nope' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('NOT_FOUND');
  });

  it('returns root node with empty calls/called_by when no edges', () => {
    insertSymbol(store, fileId, 'main', 'App::main');

    const result = getCallGraph(store, { symbolId: 'sym:App::main' });
    expect(result.isOk()).toBe(true);
    const graph = result._unsafeUnwrap();
    expect(graph.root.name).toBe('main');
    expect(graph.root.calls ?? []).toHaveLength(0);
    expect(graph.root.called_by ?? []).toHaveLength(0);
  });

  it('finds callees via "calls" edge type', () => {
    const mainId = insertSymbol(store, fileId, 'main', 'App::main');
    const helperId = insertSymbol(store, fileId, 'helper', 'App::helper');

    const mainNode = store.getNodeId('symbol', mainId)!;
    const helperNode = store.getNodeId('symbol', helperId)!;
    store.insertEdge(mainNode, helperNode, 'calls');

    const result = getCallGraph(store, { symbolId: 'sym:App::main' });
    expect(result.isOk()).toBe(true);
    const graph = result._unsafeUnwrap();
    expect(graph.root.calls).toHaveLength(1);
    expect(graph.root.calls![0].name).toBe('helper');
    expect(graph.edge_types_used).toContain('calls');
  });

  it('finds callers via "calls" edge type (reverse)', () => {
    const mainId = insertSymbol(store, fileId, 'main', 'App::main');
    const helperId = insertSymbol(store, fileId, 'helper', 'App::helper');

    const mainNode = store.getNodeId('symbol', mainId)!;
    const helperNode = store.getNodeId('symbol', helperId)!;
    store.insertEdge(mainNode, helperNode, 'calls');

    // Query from helper's perspective — main calls helper
    const result = getCallGraph(store, { symbolId: 'sym:App::helper' });
    expect(result.isOk()).toBe(true);
    const graph = result._unsafeUnwrap();
    expect(graph.root.called_by).toHaveLength(1);
    expect(graph.root.called_by![0].name).toBe('main');
  });

  it('follows framework edge types (dispatches, routes_to)', () => {
    const controllerId = insertSymbol(store, fileId, 'UserController', 'App::UserController', 'class');
    const eventId = insertSymbol(store, fileId, 'UserCreated', 'App::UserCreated', 'class');

    const controllerNode = store.getNodeId('symbol', controllerId)!;
    const eventNode = store.getNodeId('symbol', eventId)!;
    store.insertEdge(controllerNode, eventNode, 'dispatches');

    const result = getCallGraph(store, { symbolId: 'sym:App::UserController' });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().root.calls).toHaveLength(1);
    expect(result._unsafeUnwrap().root.calls![0].name).toBe('UserCreated');
  });

  it('respects depth limit', () => {
    const aId = insertSymbol(store, fileId, 'a', 'A');
    const bId = insertSymbol(store, fileId, 'b', 'B');
    const cId = insertSymbol(store, fileId, 'c', 'C');
    const dId = insertSymbol(store, fileId, 'd', 'D');

    const aNode = store.getNodeId('symbol', aId)!;
    const bNode = store.getNodeId('symbol', bId)!;
    const cNode = store.getNodeId('symbol', cId)!;
    const dNode = store.getNodeId('symbol', dId)!;

    store.insertEdge(aNode, bNode, 'calls');
    store.insertEdge(bNode, cNode, 'calls');
    store.insertEdge(cNode, dNode, 'calls');

    // Depth 1: a → b only
    const result = getCallGraph(store, { symbolId: 'sym:A' }, 1);
    expect(result.isOk()).toBe(true);
    const calls = result._unsafeUnwrap().root.calls!;
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('b');
    // b should have no deeper calls at depth 1
    expect(calls[0].calls ?? []).toHaveLength(0);
  });

  it('handles cycles without infinite recursion', () => {
    const aId = insertSymbol(store, fileId, 'a', 'A');
    const bId = insertSymbol(store, fileId, 'b', 'B');

    const aNode = store.getNodeId('symbol', aId)!;
    const bNode = store.getNodeId('symbol', bId)!;

    store.insertEdge(aNode, bNode, 'calls');
    store.insertEdge(bNode, aNode, 'calls');

    const result = getCallGraph(store, { symbolId: 'sym:A' }, 5);
    expect(result.isOk()).toBe(true);
    // Should not blow up — cycle detected via visited set
  });

  it('finds by FQN', () => {
    insertSymbol(store, fileId, 'main', 'App::main');

    const result = getCallGraph(store, { fqn: 'App::main' });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().root.name).toBe('main');
  });
});
