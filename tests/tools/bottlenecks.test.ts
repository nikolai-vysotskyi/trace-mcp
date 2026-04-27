import { describe, it, expect, beforeEach } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { getEdgeBottlenecks } from '../../src/tools/analysis/bottlenecks.js';
import { createTestStore } from '../test-utils.js';

function insertFile(store: Store, path: string): number {
  return store.insertFile(path, 'typescript', `hash_${path}`, 100);
}

function insertEdge(store: Store, srcNode: number, tgtNode: number): void {
  store.insertEdge(srcNode, tgtNode, 'esm_imports');
}

function buildButterfly(store: Store): {
  left: string[];
  right: string[];
  bridgeEdge: [string, string];
} {
  // Two triangles connected by a single edge:
  //   a1 — a2 — a3 — a1    (left clique, directed cycle)
  //   b1 — b2 — b3 — b1    (right clique, directed cycle)
  //   a1 → b1              (bridge edge)
  const a = ['src/a/a1.ts', 'src/a/a2.ts', 'src/a/a3.ts'];
  const b = ['src/b/b1.ts', 'src/b/b2.ts', 'src/b/b3.ts'];
  const fileIds = [...a, ...b].map((p) => insertFile(store, p));
  const nodeIds = fileIds.map((id) => store.getNodeId('file', id)!);

  // Left cycle: a1 → a2 → a3 → a1
  insertEdge(store, nodeIds[0], nodeIds[1]);
  insertEdge(store, nodeIds[1], nodeIds[2]);
  insertEdge(store, nodeIds[2], nodeIds[0]);

  // Right cycle: b1 → b2 → b3 → b1
  insertEdge(store, nodeIds[3], nodeIds[4]);
  insertEdge(store, nodeIds[4], nodeIds[5]);
  insertEdge(store, nodeIds[5], nodeIds[3]);

  // Bridge: a1 → b1
  insertEdge(store, nodeIds[0], nodeIds[3]);

  return { left: a, right: b, bridgeEdge: [a[0], b[0]] };
}

describe('getEdgeBottlenecks', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('returns empty for empty graph', () => {
    const result = getEdgeBottlenecks(store);
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.edges).toEqual([]);
    expect(value.articulationPoints).toEqual([]);
    expect(value.stats.nodes).toBe(0);
    expect(value.stats.edges).toBe(0);
  });

  it('ranks the bridge edge as the top bottleneck in a butterfly graph', () => {
    const { bridgeEdge } = buildButterfly(store);
    const result = getEdgeBottlenecks(store);
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();

    expect(value.edges.length).toBeGreaterThan(0);
    const top = value.edges[0];
    expect(top.sourceFile).toBe(bridgeEdge[0]);
    expect(top.targetFile).toBe(bridgeEdge[1]);
    expect(top.betweenness).toBeCloseTo(1.0, 3);
    expect(top.bottleneckScore).toBeCloseTo(1.0, 3);
  });

  it('marks the bridge edge with isBridge=true', () => {
    const { bridgeEdge } = buildButterfly(store);
    const result = getEdgeBottlenecks(store)._unsafeUnwrap();

    const bridge = result.edges.find(
      (e) => e.sourceFile === bridgeEdge[0] && e.targetFile === bridgeEdge[1],
    );
    expect(bridge).toBeDefined();
    expect(bridge!.isBridge).toBe(true);

    // Cycle edges should not be bridges (they're in a triangle — removal leaves graph connected)
    const cycleEdges = result.edges.filter(
      (e) => !(e.sourceFile === bridgeEdge[0] && e.targetFile === bridgeEdge[1]),
    );
    for (const e of cycleEdges) {
      expect(e.isBridge).toBe(false);
    }
  });

  it('identifies articulation points at the endpoints of the bridge', () => {
    const { bridgeEdge } = buildButterfly(store);
    const result = getEdgeBottlenecks(store)._unsafeUnwrap();

    const artifactFiles = result.articulationPoints.map((p) => p.file);
    expect(artifactFiles).toContain(bridgeEdge[0]);
    expect(artifactFiles).toContain(bridgeEdge[1]);
  });

  it('respects topN limit', () => {
    buildButterfly(store);
    const result = getEdgeBottlenecks(store, { topN: 2 })._unsafeUnwrap();
    expect(result.edges.length).toBeLessThanOrEqual(2);
  });

  it('returns all edges when topN=0', () => {
    buildButterfly(store);
    const result = getEdgeBottlenecks(store, { topN: 0 })._unsafeUnwrap();
    // Butterfly has 7 directed edges total (3 + 3 + 1 bridge)
    expect(result.edges.length).toBe(7);
  });

  it('filters by minScore', () => {
    buildButterfly(store);
    const result = getEdgeBottlenecks(store, { topN: 0, minScore: 0.5 })._unsafeUnwrap();
    // Only the bridge edge has score ~1.0; cycle edges have much lower betweenness
    for (const e of result.edges) {
      expect(e.bottleneckScore).toBeGreaterThanOrEqual(0.5);
    }
    expect(result.edges.length).toBeGreaterThan(0);
    expect(result.edges[0].isBridge).toBe(true);
  });

  it('sampling=auto does not sample for small graphs', () => {
    buildButterfly(store);
    const result = getEdgeBottlenecks(store, { sampling: 'auto' })._unsafeUnwrap();
    expect(result.stats.sampled).toBe(false);
  });

  it('sampling=full matches unsampled result (smoke check)', () => {
    buildButterfly(store);
    const a = getEdgeBottlenecks(store, { sampling: 'full' })._unsafeUnwrap();
    const b = getEdgeBottlenecks(store, { sampling: 'auto' })._unsafeUnwrap();
    expect(a.edges[0].sourceFile).toBe(b.edges[0].sourceFile);
    expect(a.edges[0].targetFile).toBe(b.edges[0].targetFile);
  });

  it('handles a chain graph — every edge is a bridge', () => {
    // a → b → c → d (linear chain, no cycles)
    const paths = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
    const fileIds = paths.map((p) => insertFile(store, p));
    const nodes = fileIds.map((id) => store.getNodeId('file', id)!);
    for (let i = 0; i < nodes.length - 1; i++) {
      insertEdge(store, nodes[i], nodes[i + 1]);
    }

    const result = getEdgeBottlenecks(store, { topN: 0 })._unsafeUnwrap();
    expect(result.edges.length).toBe(3);
    for (const e of result.edges) {
      expect(e.isBridge).toBe(true);
    }
    // Middle edge b→c sits on most shortest paths, so should rank highest
    const middle = result.edges[0];
    expect(middle.sourceFile).toBe('src/b.ts');
    expect(middle.targetFile).toBe('src/c.ts');
  });

  it('does not flag any edge as bridge in a fully cyclic graph', () => {
    // a → b → c → a (single cycle — removing any edge still leaves the rest reachable)
    const paths = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    const fileIds = paths.map((p) => insertFile(store, p));
    const nodes = fileIds.map((id) => store.getNodeId('file', id)!);
    insertEdge(store, nodes[0], nodes[1]);
    insertEdge(store, nodes[1], nodes[2]);
    insertEdge(store, nodes[2], nodes[0]);

    const result = getEdgeBottlenecks(store, { topN: 0 })._unsafeUnwrap();
    for (const e of result.edges) {
      expect(e.isBridge).toBe(false);
    }
    expect(result.articulationPoints).toEqual([]);
  });
});
