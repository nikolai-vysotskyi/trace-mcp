import type { Store } from '../db/store.js';
import { notFound, type TraceMcpResult } from '../errors.js';
import { ok, err } from 'neverthrow';

export interface CallGraphNode {
  symbol_id: string;
  name: string;
  kind: string;
  file: string;
  line: number | null;
  calls?: CallGraphNode[];
  called_by?: CallGraphNode[];
}

export interface CallGraphResult {
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

function buildCallNode(
  store: Store,
  symbolId: number,
  nodeId: number,
  depth: number,
  visited: Set<number>,
  edgeTypesUsed: Set<string>,
): CallGraphNode {
  const symbol = store.getSymbolById(symbolId);
  const file = symbol ? store.getFileById(symbol.file_id) : undefined;

  if (!symbol) {
    return { symbol_id: '', name: '?', kind: 'unknown', file: '', line: null };
  }

  const node = makeNode(symbol, file?.path ?? '', symbol.line_start, [], []);
  visited.add(nodeId);

  if (depth <= 0) {
    delete node.calls;
    delete node.called_by;
    return node;
  }

  // Outgoing: what this symbol calls
  const outgoing = store.getOutgoingEdges(nodeId);
  for (const edge of outgoing) {
    if (!CALL_EDGE_TYPES.has(edge.edge_type_name)) continue;
    edgeTypesUsed.add(edge.edge_type_name);
    if (visited.has(edge.target_node_id)) continue;

    const ref = store.getNodeRef(edge.target_node_id);
    if (!ref || ref.nodeType !== 'symbol') continue;

    const child = buildCallNode(store, ref.refId, edge.target_node_id, depth - 1, new Set(visited), edgeTypesUsed);
    node.calls!.push(child);
  }

  // Incoming: who calls this symbol
  const incoming = store.getIncomingEdges(nodeId);
  for (const edge of incoming) {
    if (!CALL_EDGE_TYPES.has(edge.edge_type_name)) continue;
    edgeTypesUsed.add(edge.edge_type_name);
    if (visited.has(edge.source_node_id)) continue;

    const ref = store.getNodeRef(edge.source_node_id);
    if (!ref || ref.nodeType !== 'symbol') continue;

    const caller = buildCallNode(store, ref.refId, edge.source_node_id, depth - 1, new Set(visited), edgeTypesUsed);
    node.called_by!.push(caller);
  }

  // Prune empty arrays
  if (node.calls!.length === 0) delete node.calls;
  if (node.called_by!.length === 0) delete node.called_by;

  return node;
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
