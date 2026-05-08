/**
 * Tests for the community aggregation helper that backs the visualize_graph
 * "switch to super-nodes when the graph is too big" mode.
 *
 * Contracts:
 *   - resolveAggregateMode returns the right mode for off/community/auto
 *   - aggregateByCommunity collapses nodes by community id
 *   - cross-community edges are summed; self-edges dropped
 *   - nodes without a community id fall into a single bucket
 *   - source counts are preserved in the result
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateByCommunity,
  type AggregatableEdge,
  type AggregatableNode,
  defaultCommunityLabel,
  resolveAggregateMode,
} from '../../src/tools/analysis/visualize-aggregate.js';

interface VN extends AggregatableNode {
  weightAttr?: number;
}
interface VE extends AggregatableEdge {
  weight?: number;
}

function buildSuper(cid: number, members: VN[]): VN {
  return {
    id: cid === -1 ? '__community__:uncategorised' : `__community__:${cid}`,
    label: defaultCommunityLabel(cid, members.length),
    kind: 'community',
    community: cid,
    in_degree: 0,
    out_degree: 0,
  };
}

function buildSuperEdge(source: string, target: string, weight: number): VE {
  return { source, target, edge_type: 'aggregate', weight };
}

describe('resolveAggregateMode', () => {
  it('returns off for undefined / off mode', () => {
    expect(resolveAggregateMode(undefined, 100)).toBe('off');
    expect(resolveAggregateMode('off', 100)).toBe('off');
  });

  it('returns community for explicit community mode', () => {
    expect(resolveAggregateMode('community', 5)).toBe('community');
  });

  it('auto-mode flips at the default 3000-node threshold', () => {
    expect(resolveAggregateMode('auto', 2999)).toBe('off');
    expect(resolveAggregateMode('auto', 3001)).toBe('community');
  });

  it('auto-mode honours an explicit threshold', () => {
    expect(resolveAggregateMode('auto', 50, 100)).toBe('off');
    expect(resolveAggregateMode('auto', 150, 100)).toBe('community');
  });
});

describe('aggregateByCommunity', () => {
  it('collapses nodes by community id, one super-node per group', () => {
    const nodes: VN[] = [
      { id: 'a', kind: 'file', community: 0 },
      { id: 'b', kind: 'file', community: 0 },
      { id: 'c', kind: 'file', community: 1 },
    ];
    const edges: VE[] = [];

    const r = aggregateByCommunity(nodes, edges, buildSuper, buildSuperEdge);
    expect(r.nodes).toHaveLength(2);
    expect(r.nodes.map((n) => n.id).sort()).toEqual(['__community__:0', '__community__:1']);
    expect(r.source_node_count).toBe(3);
    expect(r.mode).toBe('community');
  });

  it('drops self-edges (within a single community)', () => {
    const nodes: VN[] = [
      { id: 'a', kind: 'file', community: 0 },
      { id: 'b', kind: 'file', community: 0 },
    ];
    const edges: VE[] = [{ source: 'a', target: 'b', edge_type: 'imports' }];

    const r = aggregateByCommunity(nodes, edges, buildSuper, buildSuperEdge);
    expect(r.edges).toHaveLength(0);
  });

  it('sums cross-community edge weights', () => {
    const nodes: VN[] = [
      { id: 'a', kind: 'file', community: 0 },
      { id: 'b', kind: 'file', community: 1 },
      { id: 'c', kind: 'file', community: 1 },
    ];
    const edges: VE[] = [
      { source: 'a', target: 'b', weight: 2 },
      { source: 'a', target: 'c', weight: 5 },
    ];

    const r = aggregateByCommunity(nodes, edges, buildSuper, buildSuperEdge);
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0].weight).toBe(7);
    expect(r.edges[0].source).toBe('__community__:0');
    expect(r.edges[0].target).toBe('__community__:1');
  });

  it('buckets nodes without a community into "uncategorised"', () => {
    const nodes: VN[] = [
      { id: 'a', kind: 'file' },
      { id: 'b', kind: 'file' },
    ];
    const r = aggregateByCommunity(nodes, [], buildSuper, buildSuperEdge);
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0].id).toBe('__community__:uncategorised');
  });

  it('reports the source counts so the UI can show "collapsed from N"', () => {
    const nodes: VN[] = [
      { id: 'a', kind: 'file', community: 0 },
      { id: 'b', kind: 'file', community: 0 },
      { id: 'c', kind: 'file', community: 1 },
    ];
    const edges: VE[] = [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
    ];
    const r = aggregateByCommunity(nodes, edges, buildSuper, buildSuperEdge);
    expect(r.source_node_count).toBe(3);
    expect(r.source_edge_count).toBe(2);
  });
});

describe('defaultCommunityLabel', () => {
  it('formats the per-community super-node label', () => {
    expect(defaultCommunityLabel(7, 12)).toBe('community 7 (12)');
    expect(defaultCommunityLabel(-1, 4)).toBe('uncategorised (4)');
  });
});
