import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../../src/db/store.js';
import { initializeDatabase } from '../../src/db/schema.js';

function createStore(): Store {
  const db = initializeDatabase(':memory:');
  return new Store(db);
}

function insertFile(store: Store, path: string, lang = 'typescript'): number {
  return store.insertFile(path, lang, 'hash_' + path, 100);
}

function insertSymbol(
  store: Store,
  fileId: number,
  name: string,
  kind = 'function',
): number {
  return store.insertSymbol(fileId, {
    symbolId: `${name}#${kind}`,
    name,
    kind,
    byteStart: 0,
    byteEnd: 100,
  });
}

describe('deleteOutgoingEdgesForFileNodes', () => {
  let store: Store;

  beforeEach(() => {
    store = createStore();
  });

  it('deletes outgoing edges from file nodes but preserves incoming', () => {
    // Setup: A imports B (A→B edge)
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');

    const nodeA = store.getNodeId('file', fA)!;
    const nodeB = store.getNodeId('file', fB)!;

    store.insertEdge(nodeA, nodeB, 'imports');

    // Verify edge exists
    const edgesBefore = store.getOutgoingEdges(nodeA);
    expect(edgesBefore.length).toBe(1);

    // Delete only outgoing edges of B → should NOT remove A→B
    store.deleteOutgoingEdgesForFileNodes(fB);

    const edgesAfter = store.getOutgoingEdges(nodeA);
    expect(edgesAfter.length).toBe(1); // A→B preserved

    // Delete outgoing edges of A → should remove A→B
    store.deleteOutgoingEdgesForFileNodes(fA);

    const edgesFinal = store.getOutgoingEdges(nodeA);
    expect(edgesFinal.length).toBe(0); // A→B removed
  });

  it('deletes outgoing edges from symbol nodes', () => {
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');

    const symA = insertSymbol(store, fA, 'funcA');
    const symB = insertSymbol(store, fB, 'funcB');

    const nodeSymA = store.getNodeId('symbol', symA)!;
    const nodeSymB = store.getNodeId('symbol', symB)!;

    // A.funcA calls B.funcB
    store.insertEdge(nodeSymA, nodeSymB, 'calls');

    // Delete outgoing from A (file-scoped) → should remove funcA→funcB
    store.deleteOutgoingEdgesForFileNodes(fA);

    const edges = store.getOutgoingEdges(nodeSymA);
    expect(edges.length).toBe(0);
  });

  it('preserves incoming edges to symbol nodes from other files', () => {
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');

    const symA = insertSymbol(store, fA, 'funcA');
    const symB = insertSymbol(store, fB, 'funcB');

    const nodeSymA = store.getNodeId('symbol', symA)!;
    const nodeSymB = store.getNodeId('symbol', symB)!;

    // A.funcA calls B.funcB
    store.insertEdge(nodeSymA, nodeSymB, 'calls');

    // Delete outgoing from B → should NOT remove incoming edge A→B
    store.deleteOutgoingEdgesForFileNodes(fB);

    const incoming = store.getIncomingEdges(nodeSymB);
    expect(incoming.length).toBe(1);
  });

  it('vs deleteEdgesForFileNodes removes both directions', () => {
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');

    const nodeA = store.getNodeId('file', fA)!;
    const nodeB = store.getNodeId('file', fB)!;

    store.insertEdge(nodeA, nodeB, 'imports');

    // Full delete removes A→B even when scoped to B (target side)
    store.deleteEdgesForFileNodes(fB);

    const edges = store.getOutgoingEdges(nodeA);
    expect(edges.length).toBe(0);
  });
});

describe('Graph Snapshots', () => {
  let store: Store;

  beforeEach(() => {
    store = createStore();
  });

  it('inserts and retrieves graph snapshots', () => {
    store.insertGraphSnapshot('coupling', { ca: 3, ce: 5, instability: 0.625 }, 'abc1234', 'src/foo.ts');
    store.insertGraphSnapshot('coupling', { ca: 2, ce: 4, instability: 0.667 }, 'def5678', 'src/foo.ts');

    const snapshots = store.getGraphSnapshots('coupling', { filePath: 'src/foo.ts' });
    expect(snapshots.length).toBe(2);

    // Both inserted in same second, so order by id DESC (newest id first)
    const commits = snapshots.map((s) => s.commit_hash);
    expect(commits).toContain('abc1234');
    expect(commits).toContain('def5678');

    const caValues = snapshots.map((s) => JSON.parse(s.data).ca).sort();
    expect(caValues).toEqual([2, 3]);
  });

  it('filters by snapshot type', () => {
    store.insertGraphSnapshot('coupling', { ca: 1 }, 'abc');
    store.insertGraphSnapshot('coupling_summary', { total: 10 }, 'abc');

    const coupling = store.getGraphSnapshots('coupling');
    expect(coupling.length).toBe(1);

    const summary = store.getGraphSnapshots('coupling_summary');
    expect(summary.length).toBe(1);
  });

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) {
      store.insertGraphSnapshot('coupling', { i }, `hash${i}`, 'src/a.ts');
    }

    const limited = store.getGraphSnapshots('coupling', { limit: 3 });
    expect(limited.length).toBe(3);
  });

  it('prunes old snapshots', () => {
    // Insert a snapshot with a very old date
    store.db.prepare(
      `INSERT INTO graph_snapshots (commit_hash, snapshot_type, file_path, data, created_at)
       VALUES (?, ?, ?, ?, datetime('now', '-100 days'))`,
    ).run('old', 'coupling', 'src/a.ts', '{}');

    store.insertGraphSnapshot('coupling', {}, 'new', 'src/a.ts');

    const pruned = store.pruneGraphSnapshots(90);
    expect(pruned).toBe(1);

    const remaining = store.getGraphSnapshots('coupling');
    expect(remaining.length).toBe(1);
    expect(remaining[0].commit_hash).toBe('new');
  });
});

describe('Schema migration v13', () => {
  it('creates graph_snapshots table', () => {
    const db = initializeDatabase(':memory:');
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='graph_snapshots'",
    ).all() as { name: string }[];
    expect(tables.length).toBe(1);
    db.close();
  });
});
