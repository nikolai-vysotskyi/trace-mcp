import type { Store } from '../../db/store.js';
import type { EdgeResolution } from '../../plugin-api/types.js';
import { notFound, type TraceMcpResult } from '../../errors.js';
import { ok, err } from 'neverthrow';
import { resolveSymbolInput } from '../shared/resolve.js';
import { expandMethodViaCha } from '../shared/cha.js';

interface CallGraphEdgeInfo {
  /** How this edge was resolved */
  resolution: EdgeResolution;
  /** Edge type name */
  edge_type: string;
}

interface CallGraphNode {
  symbol_id: string;
  name: string;
  kind: string;
  file: string;
  line: number | null;
  /** Resolution info for the edge connecting to this node */
  edge?: CallGraphEdgeInfo;
  calls?: CallGraphNode[];
  called_by?: CallGraphNode[];
}

/** Summary of resolution tier distribution */
interface ResolutionTiers {
  lsp_resolved: number;
  ast_resolved: number;
  ast_inferred: number;
  text_matched: number;
}

interface CallGraphResult {
  root: CallGraphNode;
  /** Edge types that were treated as calls */
  edge_types_used: string[];
  max_depth: number;
  /** Distribution of resolution tiers across all edges */
  resolution_tiers: ResolutionTiers;
}

/** Read resolution tier from edge column, with fallback inference for legacy data */
function inferResolution(edge: { resolved: number; resolution_tier?: string; edge_type_name: string }): EdgeResolution {
  const tier = edge.resolution_tier;
  if (tier === 'lsp_resolved' || tier === 'ast_resolved' || tier === 'ast_inferred' || tier === 'text_matched') return tier;

  // Fallback for edges indexed before the resolution_tier column existed
  if (!edge.resolved) return 'text_matched';
  if (edge.edge_type_name === 'imports' || edge.edge_type_name === 'esm_imports') return 'ast_inferred';
  return 'ast_resolved';
}

const CALL_EDGE_TYPES = new Set([
  'calls', 'references',
  // Framework-specific "call" semantics
  'dispatches', 'routes_to', 'validates_with',
  'nest_injects', 'graphql_resolves',
  // Import-based edges (fallback when no call edges exist)
  'esm_imports', 'imports', 'uses',
  // Component/rendering edges
  'renders_component', 'uses_composable',
]);

/**
 * Build call graph centered on a symbol: who calls it (callers) and who it calls (callees).
 */
const MAX_DEPTH = 10;

export function getCallGraph(
  store: Store,
  opts: { symbolId?: string; fqn?: string },
  depth = 2,
): TraceMcpResult<CallGraphResult> {
  depth = Math.min(depth, MAX_DEPTH);
  const resolved = resolveSymbolInput(store, opts);
  if (!resolved) return err(notFound(opts.symbolId ?? opts.fqn ?? 'unknown'));
  const symbol = resolved.symbol;

  const file = store.getFileById(symbol.file_id);
  const nodeId = store.getNodeId('symbol', symbol.id);
  if (!nodeId) {
    return ok({
      root: makeNode(symbol, file?.path ?? '', null, [], []),
      edge_types_used: [],
      max_depth: depth,
      resolution_tiers: { lsp_resolved: 0, ast_resolved: 0, ast_inferred: 0, text_matched: 0 },
    });
  }

  // CHA expansion: collect polymorphically-equivalent methods to merge their edges
  const chaMatches = expandMethodViaCha(store, symbol);
  const chaAliasNodeIds = chaMatches
    .filter((m) => m.relation !== 'self')
    .map((m) => m.nodeId);

  const edgeTypesUsed = new Set<string>();
  const visited = new Set<number>();

  const { node: rootNode, tiers } = buildCallNode(
    store, symbol.id, nodeId, depth, visited, edgeTypesUsed, chaAliasNodeIds,
  );

  return ok({
    root: rootNode,
    edge_types_used: [...edgeTypesUsed],
    max_depth: depth,
    resolution_tiers: tiers,
  });
}

/**
 * BFS-based call graph builder. Pre-fetches edges, symbols, and files in batched waves
 * instead of per-node queries (replaces ~2000 N+1 queries with ~6 per depth level).
 */
function buildCallNode(
  store: Store,
  rootSymbolId: number,
  rootNodeId: number,
  maxDepth: number,
  _visited: Set<number>,
  edgeTypesUsed: Set<string>,
  chaAliasNodeIds: number[] = [],
): { node: CallGraphNode; tiers: ResolutionTiers } {
  // Phase 1: BFS to collect all reachable node IDs + edges
  interface EdgeRef {
    nodeId: number;
    edgeType: string;
    resolution: EdgeResolution;
  }
  interface NodeInfo {
    nodeId: number;
    symbolRefId: number;
    outgoing: Array<EdgeRef & { nodeId: number }>;
    incoming: Array<EdgeRef & { nodeId: number }>;
  }
  const tiers: ResolutionTiers = { lsp_resolved: 0, ast_resolved: 0, ast_inferred: 0, text_matched: 0 };

  const nodeInfoMap = new Map<number, NodeInfo>();
  const visited = new Set<number>();
  // CHA: treat alias node IDs as if they were the root — their edges merge into root
  const chaAliasSet = new Set(chaAliasNodeIds);
  let frontier = [rootNodeId, ...chaAliasNodeIds];
  visited.add(rootNodeId);
  for (const alias of chaAliasNodeIds) visited.add(alias);
  nodeInfoMap.set(rootNodeId, { nodeId: rootNodeId, symbolRefId: rootSymbolId, outgoing: [], incoming: [] });

  for (let d = 0; d < maxDepth; d++) {
    if (frontier.length === 0) break;

    // Batch fetch all edges for this frontier
    const batchEdges = store.getEdgesForNodesBatch(frontier);

    // Collect new neighbor node IDs
    const newNeighbors = new Set<number>();
    for (const edge of batchEdges) {
      if (!CALL_EDGE_TYPES.has(edge.edge_type_name)) continue;
      edgeTypesUsed.add(edge.edge_type_name);

      // CHA: edges from alias nodes merge into the root node's info
      const effectivePivot = chaAliasSet.has(edge.pivot_node_id) ? rootNodeId : edge.pivot_node_id;
      const pivotInfo = nodeInfoMap.get(effectivePivot);
      if (!pivotInfo) continue;

      const resolution = inferResolution(edge);
      tiers[resolution]++;

      // Outgoing: pivot is source, target is the callee
      if (edge.source_node_id === edge.pivot_node_id && !visited.has(edge.target_node_id)
        && !chaAliasSet.has(edge.target_node_id)) {
        pivotInfo.outgoing.push({ nodeId: edge.target_node_id, edgeType: edge.edge_type_name, resolution });
        newNeighbors.add(edge.target_node_id);
      }

      // Incoming: pivot is target, source is the caller
      if (edge.target_node_id === edge.pivot_node_id && !visited.has(edge.source_node_id)
        && !chaAliasSet.has(edge.source_node_id)) {
        pivotInfo.incoming.push({ nodeId: edge.source_node_id, edgeType: edge.edge_type_name, resolution });
        newNeighbors.add(edge.source_node_id);
      }
    }

    if (newNeighbors.size === 0) break;

    // Batch resolve node refs to get symbolRefIds
    const newIds = [...newNeighbors];
    const refs = store.getNodeRefsBatch(newIds);
    frontier = [];

    for (const nid of newIds) {
      const ref = refs.get(nid);
      if (!ref || ref.nodeType !== 'symbol') continue;
      visited.add(nid);
      nodeInfoMap.set(nid, { nodeId: nid, symbolRefId: ref.refId, outgoing: [], incoming: [] });
      frontier.push(nid);
    }
  }

  // Phase 2: Batch fetch all symbols and files
  const allSymbolIds = [...new Set([...nodeInfoMap.values()].map((n) => n.symbolRefId))];
  const symbolMap = allSymbolIds.length > 0 ? store.getSymbolsByIds(allSymbolIds) : new Map();
  const allFileIds = [...new Set([...symbolMap.values()].map((s) => s.file_id))];
  const fileMap = allFileIds.length > 0 ? store.getFilesByIds(allFileIds) : new Map();

  // Phase 3: Build tree from pre-fetched data
  const builtNodes = new Map<number, CallGraphNode>();

  function buildFromInfo(nodeId: number, depth: number, buildVisited: Set<number>): CallGraphNode {
    const info = nodeInfoMap.get(nodeId);
    if (!info) return { symbol_id: '', name: '?', kind: 'unknown', file: '', line: null };

    const sym = symbolMap.get(info.symbolRefId);
    if (!sym) return { symbol_id: '', name: '?', kind: 'unknown', file: '', line: null };

    const filePath = fileMap.get(sym.file_id)?.path ?? '';
    const node = makeNode(sym, filePath, sym.line_start, [], []);
    buildVisited.add(nodeId);

    if (depth <= 0) {
      delete node.calls;
      delete node.called_by;
      return node;
    }

    for (const { nodeId: targetNodeId, edgeType, resolution } of info.outgoing) {
      if (buildVisited.has(targetNodeId)) continue;
      if (!nodeInfoMap.has(targetNodeId)) continue;
      const child = buildFromInfo(targetNodeId, depth - 1, new Set(buildVisited));
      child.edge = { resolution, edge_type: edgeType };
      node.calls!.push(child);
    }

    for (const { nodeId: sourceNodeId, edgeType, resolution } of info.incoming) {
      if (buildVisited.has(sourceNodeId)) continue;
      if (!nodeInfoMap.has(sourceNodeId)) continue;
      const child = buildFromInfo(sourceNodeId, depth - 1, new Set(buildVisited));
      child.edge = { resolution, edge_type: edgeType };
      node.called_by!.push(child);
    }

    if (node.calls!.length === 0) delete node.calls;
    if (node.called_by!.length === 0) delete node.called_by;
    return node;
  }

  return { node: buildFromInfo(rootNodeId, maxDepth, new Set()), tiers };
}

function makeNode(
  symbol: { symbol_id: string; name: string; kind: string },
  filePath: string,
  line: number | null,
  calls: CallGraphNode[],
  called_by: CallGraphNode[],
): CallGraphNode {
  return { symbol_id: symbol.symbol_id, name: symbol.name, kind: symbol.kind, file: filePath, line, calls, called_by };
}
