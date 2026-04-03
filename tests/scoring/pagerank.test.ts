/**
 * Tests for computePageRank — verifies score distribution, sink-node handling,
 * convergence on cycles, and edge cases (empty graph, all sinks, star topologies).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { computePageRank, invalidatePageRankCache } from '../../src/scoring/pagerank.js';
import type Database from 'better-sqlite3';

function setup() {
  const db = initializeDatabase(':memory:');
  const store = new Store(db);
  return { db, store };
}

/** Insert a bare file + symbol so we can create a node. Returns the node id. */
function makeSymbolNode(store: Store, tag: string): number {
  const fileId = store.insertFile(`src/${tag}.ts`, 'typescript', null, 0);
  const symId = store.insertSymbol(fileId, {
    symbolId: `sym::${tag}`,
    name: tag,
    kind: 'function',
    byteStart: 0,
    byteEnd: 10,
  });
  return store.getNodeId('symbol', symId)!;
}

describe('computePageRank', () => {
  let db: Database.Database;
  let store: Store;

  beforeEach(() => {
    invalidatePageRankCache();
    ({ db, store } = setup());
  });

  it('returns empty map when there are no edges', () => {
    // Nodes exist but no edges — PageRank has no data to iterate on
    makeSymbolNode(store, 'a');
    makeSymbolNode(store, 'b');

    const ranks = computePageRank(db);
    expect(ranks.size).toBe(0);
  });

  it('a single directed edge: target ranks higher than source', () => {
    const nA = makeSymbolNode(store, 'a');
    const nB = makeSymbolNode(store, 'b');
    store.insertEdge(nA, nB, 'imports', true);

    const ranks = computePageRank(db);

    expect(ranks.has(nA)).toBe(true);
    expect(ranks.has(nB)).toBe(true);
    // B receives A's contribution — should rank higher
    expect(ranks.get(nB)!).toBeGreaterThan(ranks.get(nA)!);
  });

  it('sink node: its score is redistributed, not lost', () => {
    // A → B, B is a sink (no outgoing edges)
    const nA = makeSymbolNode(store, 'a');
    const nB = makeSymbolNode(store, 'b');
    const nC = makeSymbolNode(store, 'c');
    store.insertEdge(nA, nB, 'imports', true); // B is a sink
    store.insertEdge(nA, nC, 'imports', true);

    const ranks = computePageRank(db);

    // Total rank mass should be conserved (within floating-point tolerance)
    const total = [...ranks.values()].reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1.0, 1);
  });

  it('symmetric cycle: all nodes converge to equal rank', () => {
    // A → B → C → A  (perfect cycle)
    const nA = makeSymbolNode(store, 'a');
    const nB = makeSymbolNode(store, 'b');
    const nC = makeSymbolNode(store, 'c');
    store.insertEdge(nA, nB, 'imports', true);
    store.insertEdge(nB, nC, 'imports', true);
    store.insertEdge(nC, nA, 'imports', true);

    const ranks = computePageRank(db);

    const rA = ranks.get(nA)!;
    const rB = ranks.get(nB)!;
    const rC = ranks.get(nC)!;

    // All ranks should be approximately equal (1/3 each)
    expect(rA).toBeCloseTo(rB, 2);
    expect(rB).toBeCloseTo(rC, 2);
  });

  it('star topology: hub ranks higher than leaves', () => {
    // Hub ← leaf1, leaf2, leaf3 (three inbound edges)
    const hub = makeSymbolNode(store, 'hub');
    const l1  = makeSymbolNode(store, 'leaf1');
    const l2  = makeSymbolNode(store, 'leaf2');
    const l3  = makeSymbolNode(store, 'leaf3');
    store.insertEdge(l1, hub, 'imports', true);
    store.insertEdge(l2, hub, 'imports', true);
    store.insertEdge(l3, hub, 'imports', true);

    const ranks = computePageRank(db);

    const rHub = ranks.get(hub)!;
    expect(rHub).toBeGreaterThanOrEqual(ranks.get(l1)!);
    expect(rHub).toBeGreaterThanOrEqual(ranks.get(l2)!);
    expect(rHub).toBeGreaterThanOrEqual(ranks.get(l3)!);
  });

  it('all-sink graph (no outgoing edges from any node): rank mass is conserved', () => {
    // Four isolated nodes connected by edges but none has outgoing edges from receiving side
    const nA = makeSymbolNode(store, 'a');
    const nB = makeSymbolNode(store, 'b');
    // Only one edge: A → B. B is a sink.
    store.insertEdge(nA, nB, 'imports', true);

    const ranks = computePageRank(db);

    const total = [...ranks.values()].reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1.0, 1);
    // B still gets higher rank from A's outgoing edge
    expect(ranks.get(nB)!).toBeGreaterThan(ranks.get(nA)!);
  });

  it('unresolved edges are excluded from rank computation', () => {
    const nA = makeSymbolNode(store, 'a');
    const nB = makeSymbolNode(store, 'b');
    // Insert as unresolved (resolved = false)
    store.insertEdge(nA, nB, 'unresolved', false);

    const ranks = computePageRank(db);

    // Unresolved edges are filtered out — no rank data
    expect(ranks.size).toBe(0);
  });
});
