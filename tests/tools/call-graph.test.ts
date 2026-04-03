/**
 * Tests for getCallGraph — call-graph traversal with depth limiting and cycle detection.
 * Uses in-memory store with manually inserted symbols and edges.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { getCallGraph } from '../../src/tools/call-graph.js';

function createStore(): Store {
  const db = initializeDatabase(':memory:');
  return new Store(db);
}

function addSymbol(
  store: Store,
  opts: {
    filePath: string;
    name: string;
    kind: string;
    fqn?: string;
    metadata?: Record<string, unknown>;
  },
): { fileId: number; symbolDbId: number; nodeId: number } {
  let file = store.getFile(opts.filePath);
  let fileId: number;
  if (!file) {
    fileId = store.insertFile(opts.filePath, 'typescript', null, null);
  } else {
    fileId = file.id;
  }
  const symbolDbId = store.insertSymbol(fileId, {
    symbolId: `${opts.filePath}::${opts.name}#${opts.kind}`,
    name: opts.name,
    kind: opts.kind as any,
    fqn: opts.fqn,
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 10,
    metadata: opts.metadata,
  });
  const nodeId = store.getNodeId('symbol', symbolDbId)!;
  return { fileId, symbolDbId, nodeId };
}

describe('getCallGraph', () => {
  let store: Store;

  beforeEach(() => {
    store = createStore();
    store.ensureEdgeType('calls', 'code', 'Function calls');
    store.ensureEdgeType('dispatches', 'code', 'Event dispatch');
  });

  it('returns NOT_FOUND for non-existent symbol', () => {
    const result = getCallGraph(store, { symbolId: 'does-not-exist' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('NOT_FOUND');
  });

  it('returns root only when symbol has no edges', () => {
    const sym = addSymbol(store, {
      filePath: 'src/app.ts',
      name: 'lonelyFn',
      kind: 'function',
    });

    const result = getCallGraph(store, {
      symbolId: `src/app.ts::lonelyFn#function`,
    });
    expect(result.isOk()).toBe(true);
    const graph = result._unsafeUnwrap();
    expect(graph.root.name).toBe('lonelyFn');
    // No calls or called_by arrays when empty (pruned)
    expect(graph.root.calls).toBeUndefined();
    expect(graph.root.called_by).toBeUndefined();
  });

  it('A calls B and C → root.calls has B, C', () => {
    const a = addSymbol(store, { filePath: 'src/a.ts', name: 'fnA', kind: 'function' });
    const b = addSymbol(store, { filePath: 'src/b.ts', name: 'fnB', kind: 'function' });
    const c = addSymbol(store, { filePath: 'src/c.ts', name: 'fnC', kind: 'function' });

    store.insertEdge(a.nodeId, b.nodeId, 'calls');
    store.insertEdge(a.nodeId, c.nodeId, 'calls');

    const result = getCallGraph(store, { symbolId: 'src/a.ts::fnA#function' });
    expect(result.isOk()).toBe(true);
    const graph = result._unsafeUnwrap();

    expect(graph.root.calls).toHaveLength(2);
    const calleeNames = graph.root.calls!.map((n) => n.name).sort();
    expect(calleeNames).toEqual(['fnB', 'fnC']);
    expect(graph.edge_types_used).toContain('calls');
  });

  it('D calls A → root.called_by has D', () => {
    const a = addSymbol(store, { filePath: 'src/a.ts', name: 'fnA', kind: 'function' });
    const d = addSymbol(store, { filePath: 'src/d.ts', name: 'fnD', kind: 'function' });

    store.insertEdge(d.nodeId, a.nodeId, 'calls');

    const result = getCallGraph(store, { symbolId: 'src/a.ts::fnA#function' });
    expect(result.isOk()).toBe(true);
    const graph = result._unsafeUnwrap();

    expect(graph.root.called_by).toHaveLength(1);
    expect(graph.root.called_by![0].name).toBe('fnD');
  });

  it('respects depth limiting: A→B→C with depth=1 → only A→B', () => {
    const a = addSymbol(store, { filePath: 'src/a.ts', name: 'fnA', kind: 'function' });
    const b = addSymbol(store, { filePath: 'src/b.ts', name: 'fnB', kind: 'function' });
    const c = addSymbol(store, { filePath: 'src/c.ts', name: 'fnC', kind: 'function' });

    store.insertEdge(a.nodeId, b.nodeId, 'calls');
    store.insertEdge(b.nodeId, c.nodeId, 'calls');

    const result = getCallGraph(store, { symbolId: 'src/a.ts::fnA#function' }, 1);
    expect(result.isOk()).toBe(true);
    const graph = result._unsafeUnwrap();

    expect(graph.root.calls).toHaveLength(1);
    expect(graph.root.calls![0].name).toBe('fnB');
    // At depth=1, B should not have further calls resolved
    expect(graph.root.calls![0].calls).toBeUndefined();
    expect(graph.max_depth).toBe(1);
  });

  it('handles cycles without infinite loop: A→B→A', () => {
    const a = addSymbol(store, { filePath: 'src/a.ts', name: 'fnA', kind: 'function' });
    const b = addSymbol(store, { filePath: 'src/b.ts', name: 'fnB', kind: 'function' });

    store.insertEdge(a.nodeId, b.nodeId, 'calls');
    store.insertEdge(b.nodeId, a.nodeId, 'calls');

    // This must complete without hanging
    const result = getCallGraph(store, { symbolId: 'src/a.ts::fnA#function' }, 5);
    expect(result.isOk()).toBe(true);
    const graph = result._unsafeUnwrap();
    expect(graph.root.name).toBe('fnA');
    // A calls B, and B has A as a caller (cycle detection prevents re-expansion)
    expect(graph.root.calls).toBeDefined();
    expect(graph.root.calls!.length).toBe(1);
  });

  it('finds symbol by fqn', () => {
    addSymbol(store, {
      filePath: 'src/app.ts',
      name: 'main',
      kind: 'function',
      fqn: 'App::main',
    });

    const result = getCallGraph(store, { fqn: 'App::main' });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().root.name).toBe('main');
  });

  it('follows framework edge types like dispatches', () => {
    const ctrl = addSymbol(store, { filePath: 'src/ctrl.ts', name: 'Controller', kind: 'class' });
    const evt = addSymbol(store, { filePath: 'src/events.ts', name: 'UserCreated', kind: 'class' });

    store.insertEdge(ctrl.nodeId, evt.nodeId, 'dispatches');

    const result = getCallGraph(store, { symbolId: 'src/ctrl.ts::Controller#class' });
    expect(result.isOk()).toBe(true);
    const graph = result._unsafeUnwrap();
    expect(graph.root.calls).toHaveLength(1);
    expect(graph.root.calls![0].name).toBe('UserCreated');
    expect(graph.edge_types_used).toContain('dispatches');
  });
});
