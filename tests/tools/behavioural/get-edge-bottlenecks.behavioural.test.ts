/**
 * Behavioural coverage for `getEdgeBottlenecks()` (the `get_edge_bottlenecks`
 * MCP tool). Seeds a file-level import graph and verifies:
 *   - star topology: edges into the central node have non-zero betweenness
 *     and the result envelope carries edges + articulationPoints + stats
 *   - bridge edge detection: an edge that disconnects two components when
 *     removed is flagged with isBridge: true
 *   - `top_n` caps the number of returned edges
 *   - empty graph returns empty edges + empty articulationPoints
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getEdgeBottlenecks } from '../../../src/tools/analysis/bottlenecks.js';
import { createTestStore } from '../../test-utils.js';

function insertFile(store: Store, path: string): number {
  return store.insertFile(path, 'typescript', `h-${path}`, 100);
}

function importEdge(store: Store, srcPath: string, tgtPath: string): void {
  const srcRow = store.db.prepare('SELECT id FROM files WHERE path = ?').get(srcPath) as
    | { id: number }
    | undefined;
  const tgtRow = store.db.prepare('SELECT id FROM files WHERE path = ?').get(tgtPath) as
    | { id: number }
    | undefined;
  if (!srcRow || !tgtRow) throw new Error(`Missing file rows for ${srcPath} or ${tgtPath}`);
  const srcNid = store.getNodeId('file', srcRow.id)!;
  const tgtNid = store.getNodeId('file', tgtRow.id)!;
  store.insertEdge(srcNid, tgtNid, 'esm_imports', true, undefined, false, 'ast_resolved');
}

/**
 * Star topology where src/hub.ts is the bottleneck:
 *
 *   src/spokeA.ts ──> src/hub.ts <── src/spokeB.ts
 *                          │
 *                          ▼
 *                     src/sink.ts
 *
 * All edges into/out of hub sit on every shortest path A↔sink and B↔sink, so
 * they should land with non-zero betweenness.
 */
function seedStar(): Store {
  const store = createTestStore();
  for (const p of ['src/spokeA.ts', 'src/spokeB.ts', 'src/hub.ts', 'src/sink.ts'])
    insertFile(store, p);
  importEdge(store, 'src/spokeA.ts', 'src/hub.ts');
  importEdge(store, 'src/spokeB.ts', 'src/hub.ts');
  importEdge(store, 'src/hub.ts', 'src/sink.ts');
  return store;
}

/**
 * Two clusters connected by a single bridge edge: src/bridgeFrom.ts → src/bridgeTo.ts.
 *
 *   src/left1.ts ──> src/bridgeFrom.ts ──> src/bridgeTo.ts ──> src/right1.ts
 *        │                                                          │
 *        └────────> src/left2.ts          src/right2.ts <───────────┘
 *
 * Removing the bridge disconnects {left1,left2,bridgeFrom} from
 * {bridgeTo,right1,right2} in the undirected projection.
 */
function seedBridge(): Store {
  const store = createTestStore();
  for (const p of [
    'src/left1.ts',
    'src/left2.ts',
    'src/bridgeFrom.ts',
    'src/bridgeTo.ts',
    'src/right1.ts',
    'src/right2.ts',
  ]) {
    insertFile(store, p);
  }
  importEdge(store, 'src/left1.ts', 'src/bridgeFrom.ts');
  importEdge(store, 'src/left1.ts', 'src/left2.ts');
  importEdge(store, 'src/bridgeFrom.ts', 'src/bridgeTo.ts'); // bridge
  importEdge(store, 'src/bridgeTo.ts', 'src/right1.ts');
  importEdge(store, 'src/right1.ts', 'src/right2.ts');
  return store;
}

describe('getEdgeBottlenecks() — behavioural contract', () => {
  it('returns { edges, articulationPoints, stats } envelope on a populated graph', () => {
    const store = seedStar();
    const result = getEdgeBottlenecks(store, { topN: 50 })._unsafeUnwrap();
    expect(Array.isArray(result.edges)).toBe(true);
    expect(Array.isArray(result.articulationPoints)).toBe(true);
    expect(result.stats.nodes).toBeGreaterThan(0);
    expect(result.stats.edges).toBeGreaterThan(0);

    // Edges should carry the shape the MCP tool advertises.
    for (const e of result.edges) {
      expect(typeof e.sourceFile).toBe('string');
      expect(typeof e.targetFile).toBe('string');
      expect(typeof e.betweenness).toBe('number');
      expect(typeof e.coChangeWeight).toBe('number');
      expect(typeof e.bottleneckScore).toBe('number');
      expect(typeof e.isBridge).toBe('boolean');
    }

    // At least one edge involving the hub should have positive betweenness.
    const hubEdges = result.edges.filter(
      (e) => e.sourceFile === 'src/hub.ts' || e.targetFile === 'src/hub.ts',
    );
    expect(hubEdges.length).toBeGreaterThan(0);
    expect(hubEdges.some((e) => e.betweenness > 0)).toBe(true);
  });

  it('flags bridge edges with isBridge: true', () => {
    const store = seedBridge();
    const result = getEdgeBottlenecks(store, { topN: 50 })._unsafeUnwrap();
    const bridge = result.edges.find(
      (e) => e.sourceFile === 'src/bridgeFrom.ts' && e.targetFile === 'src/bridgeTo.ts',
    );
    expect(bridge).toBeDefined();
    expect(bridge!.isBridge).toBe(true);
  });

  it('`top_n` caps the number of returned edges', () => {
    const store = seedStar();
    const capped = getEdgeBottlenecks(store, { topN: 1 })._unsafeUnwrap();
    expect(capped.edges.length).toBeLessThanOrEqual(1);
  });

  it('empty graph returns empty edges + empty articulationPoints + stats.{nodes,edges}=0', () => {
    const empty = createTestStore();
    const result = getEdgeBottlenecks(empty, {})._unsafeUnwrap();
    expect(result.edges).toEqual([]);
    expect(result.articulationPoints).toEqual([]);
    expect(result.stats.nodes).toBe(0);
    expect(result.stats.edges).toBe(0);
  });
});
