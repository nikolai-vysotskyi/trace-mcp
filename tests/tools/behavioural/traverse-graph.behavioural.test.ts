/**
 * Behavioural coverage for `traverseGraph()`. Builds a small symbol-edge
 * graph and asserts BFS direction handling, depth/node caps, the
 * truncated_by_* flags, and the seed-only edge case.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { traverseGraph } from '../../../src/tools/analysis/traverse-graph.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
  rootSymbolId: string;
  downstreamSymbolId: string;
  upstreamSymbolId: string;
  loneSymbolId: string;
}

/**
 * Topology:
 *   upstream -> root -> downstream -> leaf
 *   downstream -> sibling
 * Plus an isolated "lone" symbol with no edges.
 *
 * From `root`:
 *   outgoing depth=1 → downstream
 *   outgoing depth=2 → downstream, leaf, sibling
 *   incoming depth=1 → upstream
 *   both       depth=1 → upstream, downstream
 */
function seed(): Fixture {
  const store = createTestStore();

  const mkSym = (file: string, name: string, hash: string) => {
    const fid = store.insertFile(file, 'typescript', hash, 80);
    const sid = `${file}::${name}#function`;
    const symRow = store.insertSymbol(fid, {
      symbolId: sid,
      name,
      kind: 'function',
      fqn: name,
      byteStart: 0,
      byteEnd: 50,
      lineStart: 1,
      lineEnd: 5,
    });
    return { sid, nid: store.getNodeId('symbol', symRow)! };
  };

  const root = mkSym('src/root.ts', 'rootFn', 'h-root');
  const downstream = mkSym('src/downstream.ts', 'downstreamFn', 'h-down');
  const leaf = mkSym('src/leaf.ts', 'leafFn', 'h-leaf');
  const sibling = mkSym('src/sibling.ts', 'siblingFn', 'h-sib');
  const upstream = mkSym('src/upstream.ts', 'upstreamFn', 'h-up');
  const lone = mkSym('src/lone.ts', 'loneFn', 'h-lone');

  store.insertEdge(upstream.nid, root.nid, 'calls', true, undefined, false, 'ast_resolved');
  store.insertEdge(root.nid, downstream.nid, 'calls', true, undefined, false, 'ast_resolved');
  store.insertEdge(downstream.nid, leaf.nid, 'calls', true, undefined, false, 'ast_resolved');
  store.insertEdge(downstream.nid, sibling.nid, 'calls', true, undefined, false, 'ast_resolved');

  return {
    store,
    rootSymbolId: root.sid,
    downstreamSymbolId: downstream.sid,
    upstreamSymbolId: upstream.sid,
    loneSymbolId: lone.sid,
  };
}

describe('traverseGraph() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('direction=outgoing walks the graph forward from the seed', () => {
    const result = traverseGraph(ctx.store, {
      start_symbol_id: ctx.rootSymbolId,
      direction: 'outgoing',
      max_depth: 5,
    });
    expect(result).not.toBeNull();
    expect(result!.start.id).toBe(ctx.rootSymbolId);
    expect(result!.direction).toBe('outgoing');
    const names = result!.nodes.map((n) => n.name);
    expect(names).toContain('rootFn');
    expect(names).toContain('downstreamFn');
    expect(names).toContain('leafFn');
    expect(names).toContain('siblingFn');
    // outgoing must NOT reach the upstream caller.
    expect(names).not.toContain('upstreamFn');
  });

  it('direction=incoming walks the graph backward from the seed', () => {
    const result = traverseGraph(ctx.store, {
      start_symbol_id: ctx.rootSymbolId,
      direction: 'incoming',
      max_depth: 5,
    });
    expect(result).not.toBeNull();
    const names = result!.nodes.map((n) => n.name);
    expect(names).toContain('rootFn');
    expect(names).toContain('upstreamFn');
    // incoming must NOT reach the downstream callees.
    expect(names).not.toContain('downstreamFn');
    expect(names).not.toContain('leafFn');
  });

  it('direction=both unions outgoing and incoming reachability', () => {
    const result = traverseGraph(ctx.store, {
      start_symbol_id: ctx.rootSymbolId,
      direction: 'both',
      max_depth: 5,
    });
    expect(result).not.toBeNull();
    const names = result!.nodes.map((n) => n.name);
    expect(names).toContain('upstreamFn');
    expect(names).toContain('downstreamFn');
    expect(names).toContain('leafFn');
  });

  it('max_depth=1 stops after the first hop and flags truncated_by_depth', () => {
    const shallow = traverseGraph(ctx.store, {
      start_symbol_id: ctx.rootSymbolId,
      direction: 'outgoing',
      max_depth: 1,
    });
    expect(shallow).not.toBeNull();
    const names = shallow!.nodes.map((n) => n.name);
    expect(names).toContain('downstreamFn');
    // depth 1 must not reach 2-hop callees.
    expect(names).not.toContain('leafFn');
    expect(names).not.toContain('siblingFn');
    expect(shallow!.truncated_by_depth).toBe(true);
  });

  it('token_budget too small forces truncated_by_budget', () => {
    const result = traverseGraph(ctx.store, {
      start_symbol_id: ctx.rootSymbolId,
      direction: 'outgoing',
      max_depth: 5,
      token_budget: 1, // smaller than a single node's approx cost
    });
    expect(result).not.toBeNull();
    expect(result!.truncated_by_budget).toBe(true);
    // The walk should still produce a well-formed envelope.
    expect(typeof result!.total_visited).toBe('number');
    expect(Array.isArray(result!.nodes)).toBe(true);
  });

  it('seed with no edges returns just the seed node', () => {
    const result = traverseGraph(ctx.store, {
      start_symbol_id: ctx.loneSymbolId,
      direction: 'both',
      max_depth: 5,
    });
    expect(result).not.toBeNull();
    expect(result!.total_visited).toBe(1);
    expect(result!.nodes.length).toBe(1);
    expect(result!.nodes[0].name).toBe('loneFn');
    expect(result!.nodes[0].depth).toBe(0);
    expect(result!.nodes[0].edge_type).toBeNull();
    expect(result!.truncated_by_depth).toBe(false);
    expect(result!.truncated_by_nodes).toBe(false);
    expect(result!.truncated_by_budget).toBe(false);
  });
});
