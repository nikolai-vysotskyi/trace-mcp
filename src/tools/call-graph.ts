import type { Store } from '../db/store.js';
import { notFound, type TraceMcpResult } from '../errors.js';
import { ok, err } from 'neverthrow';

interface CallGraphNode {
  symbol_id: string;
  name: string;
  kind: string;
  file: string;
  line: number | null;
  calls?: CallGraphNode[];
  called_by?: CallGraphNode[];
}

interface CallGraphResult {
  root: CallGraphNode;
  /** Edge types that were treated as calls */
  edge_types_used: string[];
  max_depth: number;
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
  let symbol = opts.symbolId
    ? store.getSymbolBySymbolId(opts.symbolId)
    : opts.fqn ? store.getSymbolByFqn(opts.fqn) : undefined;

  if (!symbol) return err(notFound(opts.symbolId ?? opts.fqn ?? 'unknown'));

  const file = store.getFileById(symbol.file_id);
  const nodeId = store.getNodeId('symbol', symbol.id);
  if (!nodeId) {
    return ok({
      root: makeNode(symbol, file?.path ?? '', null, [], []),
      edge_types_used: [],
      max_depth: depth,
    });
  }

  const edgeTypesUsed = new Set<string>();
  const visited = new Set<number>();

  const rootNode = buildCallNode(store, symbol.id, nodeId, depth, visited, edgeTypesUsed);

  return ok({
    root: rootNode,
    edge_types_used: [...edgeTypesUsed],
    max_depth: depth,
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
): CallGraphNode {
  // Phase 1: BFS to collect all reachable node IDs + edges
  interface NodeInfo {
    nodeId: number;
    symbolRefId: number;
    outgoing: Array<{ targetNodeId: number; edgeType: string }>;
    incoming: Array<{ sourceNodeId: number; edgeType: string }>;
  }

  const nodeInfoMap = new Map<number, NodeInfo>();
  const visited = new Set<number>();
  let frontier = [rootNodeId];
  visited.add(rootNodeId);
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

      const pivotInfo = nodeInfoMap.get(edge.pivot_node_id);
      if (!pivotInfo) continue;

      // Outgoing: pivot is source, target is the callee
      if (edge.source_node_id === edge.pivot_node_id && !visited.has(edge.target_node_id)) {
        pivotInfo.outgoing.push({ targetNodeId: edge.target_node_id, edgeType: edge.edge_type_name });
        newNeighbors.add(edge.target_node_id);
      }

      // Incoming: pivot is target, source is the caller
      if (edge.target_node_id === edge.pivot_node_id && !visited.has(edge.source_node_id)) {
        pivotInfo.incoming.push({ sourceNodeId: edge.source_node_id, edgeType: edge.edge_type_name });
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

    for (const { targetNodeId } of info.outgoing) {
      if (buildVisited.has(targetNodeId)) continue;
      if (!nodeInfoMap.has(targetNodeId)) continue;
      node.calls!.push(buildFromInfo(targetNodeId, depth - 1, new Set(buildVisited)));
    }

    for (const { sourceNodeId } of info.incoming) {
      if (buildVisited.has(sourceNodeId)) continue;
      if (!nodeInfoMap.has(sourceNodeId)) continue;
      node.called_by!.push(buildFromInfo(sourceNodeId, depth - 1, new Set(buildVisited)));
    }

    if (node.calls!.length === 0) delete node.calls;
    if (node.called_by!.length === 0) delete node.called_by;
    return node;
  }

  return buildFromInfo(rootNodeId, maxDepth, new Set());
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
