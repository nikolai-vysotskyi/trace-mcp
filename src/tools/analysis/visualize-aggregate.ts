/**
 * Community-level aggregation for the visualize_graph output.
 *
 * CRG v2.2.0 introduced this exact feature for the same reason: above
 * ~3000 nodes the force-directed layout becomes a hairball and the
 * browser starts dropping frames. CRG auto-switches at 3000; we mirror
 * the threshold but expose it so a caller can override.
 *
 * The aggregator collapses every node of a given community id into one
 * super-node (kind: "community"). Edges between communities are summed
 * into a single super-edge whose weight is the cross-community fan-in.
 * Self-edges (within a community) are dropped — they're noise at this
 * altitude. The result drops back into the same VizNode/VizEdge types
 * the renderer already consumes.
 */

export interface AggregatableNode {
  id: string;
  label?: string;
  kind: string;
  community?: number;
  /** Optional coupling-related metrics that the renderer carries forward. */
  in_degree?: number;
  out_degree?: number;
}

export interface AggregatableEdge {
  source: string;
  target: string;
  edge_type?: string;
}

export interface AggregateResult<N, E> {
  nodes: N[];
  edges: E[];
  /** Original counts pre-aggregation — useful for the UI to surface "collapsed from N nodes". */
  source_node_count: number;
  source_edge_count: number;
  /** Mode that actually ran — either the explicit choice or what auto-mode picked. */
  mode: 'off' | 'community';
}

export type AggregateMode = 'off' | 'community' | 'auto';

const AUTO_THRESHOLD = 3000;

/**
 * Decide whether community aggregation should fire for this graph.
 *
 *   - 'off' / unspecified  → never aggregate
 *   - 'community'           → always aggregate
 *   - 'auto'                → aggregate when nodeCount > threshold (default 3000)
 */
export function resolveAggregateMode(
  mode: AggregateMode | undefined,
  nodeCount: number,
  threshold: number = AUTO_THRESHOLD,
): 'off' | 'community' {
  if (mode === 'community') return 'community';
  if (mode === 'auto' && nodeCount > threshold) return 'community';
  return 'off';
}

/**
 * Collapse every node of the same community id into a single super-node.
 * Inputs that lack a community id fall into a synthetic "uncategorised"
 * community (id = -1) so they don't disappear.
 *
 * Edges are summed into super-edges keyed by (sourceCommunity, targetCommunity).
 * Self-edges are dropped — they live inside a community and aren't useful
 * at the bird's-eye view.
 */
export function aggregateByCommunity<
  N extends AggregatableNode,
  E extends AggregatableEdge & { weight?: number },
>(
  nodes: N[],
  edges: E[],
  buildCommunityNode: (communityId: number, members: N[]) => N,
  buildSuperEdge: (source: string, target: string, weight: number) => E,
): AggregateResult<N, E> {
  // Group source nodes by community id; bucket the unknowns together.
  const groups = new Map<number, N[]>();
  const idToCommunity = new Map<string, number>();
  for (const n of nodes) {
    const cid = n.community ?? -1;
    idToCommunity.set(n.id, cid);
    const arr = groups.get(cid) ?? [];
    arr.push(n);
    groups.set(cid, arr);
  }

  const superNodes: N[] = [];
  for (const [cid, members] of groups) {
    superNodes.push(buildCommunityNode(cid, members));
  }

  // Sum cross-community edge weights. Skip self-edges.
  const edgeWeights = new Map<string, number>();
  for (const e of edges) {
    const sCid = idToCommunity.get(e.source);
    const tCid = idToCommunity.get(e.target);
    if (sCid === undefined || tCid === undefined) continue;
    if (sCid === tCid) continue;
    const key = `${sCid}|${tCid}`;
    edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + (e.weight ?? 1));
  }

  const superEdges: E[] = [];
  for (const [key, weight] of edgeWeights) {
    const [sCidStr, tCidStr] = key.split('|');
    const sCid = Number(sCidStr);
    const tCid = Number(tCidStr);
    superEdges.push(buildSuperEdge(communityNodeId(sCid), communityNodeId(tCid), weight));
  }

  return {
    nodes: superNodes,
    edges: superEdges,
    source_node_count: nodes.length,
    source_edge_count: edges.length,
    mode: 'community',
  };
}

export function communityNodeId(cid: number): string {
  return cid === -1 ? '__community__:uncategorised' : `__community__:${cid}`;
}

export function defaultCommunityLabel(cid: number, memberCount: number): string {
  if (cid === -1) return `uncategorised (${memberCount})`;
  return `community ${cid} (${memberCount})`;
}
