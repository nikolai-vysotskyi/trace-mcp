/**
 * `traverse_graph` — BFS/DFS over the symbol/file graph from a starting node,
 * with a token budget that caps the response size.
 *
 * CRG v2.3.2 added `traverse_graph_tool` to give agents an explicit walk over
 * the graph instead of forcing them through call-graph or impact-radius
 * tools that bake in a specific traversal shape. We have neither — the
 * closest analogues are get_call_graph (only `calls`/`called_by`) and
 * graph_query (NL → subgraph). traverse_graph fills the gap with a small,
 * predictable API:
 *
 *   - start_symbol_id OR start_file_path   ← the single root node
 *   - direction: outgoing | incoming | both
 *   - max_depth, max_nodes
 *   - edge_types[]                          ← optional filter
 *   - token_budget                          ← hard cap on response size
 *
 * The response is a list of visited nodes with depth + path-from-root, plus
 * a small summary. Callers get the structured view they expected from a
 * "walk N hops from here" question without hand-rolling SQL.
 */
import type { Store } from '../../db/store.js';

export type TraverseDirection = 'outgoing' | 'incoming' | 'both';

export interface TraverseNode {
  /** Stable identifier — symbol_id for symbol nodes, file path for file nodes. */
  id: string;
  /** 'symbol' or 'file' — matches the underlying nodes.node_type. */
  kind: 'symbol' | 'file';
  /** Display name (symbol name or file basename). */
  name: string;
  /** BFS depth from root. 0 for root. */
  depth: number;
  /** Edge type that brought the walker to this node. null for root. */
  edge_type: string | null;
  /** Number of incoming edges into this node within the visited subgraph. */
  in_degree: number;
}

export interface TraverseResult {
  start: { id: string; kind: 'symbol' | 'file'; name: string };
  direction: TraverseDirection;
  nodes: TraverseNode[];
  total_visited: number;
  truncated_by_depth: boolean;
  truncated_by_nodes: boolean;
  truncated_by_budget: boolean;
}

interface InternalNode {
  rowId: number;
  type: 'symbol' | 'file';
}

function lookupStartNode(
  store: Store,
  startSymbolId: string | undefined,
  startFilePath: string | undefined,
): InternalNode | null {
  if (startSymbolId) {
    const sym = store.db.prepare('SELECT id FROM symbols WHERE symbol_id = ?').get(startSymbolId) as
      | { id: number }
      | undefined;
    if (!sym) return null;
    const node = store.db
      .prepare("SELECT id FROM nodes WHERE node_type = 'symbol' AND ref_id = ?")
      .get(sym.id) as { id: number } | undefined;
    return node ? { rowId: node.id, type: 'symbol' } : null;
  }
  if (startFilePath) {
    const file = store.db.prepare('SELECT id FROM files WHERE path = ?').get(startFilePath) as
      | { id: number }
      | undefined;
    if (!file) return null;
    const node = store.db
      .prepare("SELECT id FROM nodes WHERE node_type = 'file' AND ref_id = ?")
      .get(file.id) as { id: number } | undefined;
    return node ? { rowId: node.id, type: 'file' } : null;
  }
  return null;
}

function describeNode(
  store: Store,
  rowId: number,
): { id: string; kind: 'symbol' | 'file'; name: string } | null {
  const row = store.db.prepare('SELECT node_type, ref_id FROM nodes WHERE id = ?').get(rowId) as
    | { node_type: string; ref_id: number }
    | undefined;
  if (!row) return null;
  if (row.node_type === 'symbol') {
    const s = store.db
      .prepare('SELECT symbol_id, name FROM symbols WHERE id = ?')
      .get(row.ref_id) as { symbol_id: string; name: string } | undefined;
    return s ? { id: s.symbol_id, kind: 'symbol', name: s.name } : null;
  }
  if (row.node_type === 'file') {
    const f = store.db.prepare('SELECT path FROM files WHERE id = ?').get(row.ref_id) as
      | { path: string }
      | undefined;
    if (!f) return null;
    const base = f.path.split('/').pop() ?? f.path;
    return { id: f.path, kind: 'file', name: base };
  }
  return null;
}

interface NeighborRow {
  next_node_id: number;
  edge_type: string;
}

function fetchNeighbors(
  store: Store,
  nodeId: number,
  direction: TraverseDirection,
  edgeTypeFilter: Set<string> | null,
): NeighborRow[] {
  // `direction` tells us which side of the edge we're standing on. We surface
  // edge_type via the edge_types lookup so the caller can see what construct
  // brought the walker here.
  const baseSql = `
    SELECT e.${direction === 'outgoing' ? 'target_node_id' : 'source_node_id'} AS next_node_id,
           et.name AS edge_type
    FROM edges e
    JOIN edge_types et ON e.edge_type_id = et.id
    WHERE e.${direction === 'outgoing' ? 'source_node_id' : 'target_node_id'} = ?
  `;
  if (direction !== 'both') {
    const rows = store.db.prepare(baseSql).all(nodeId) as NeighborRow[];
    return edgeTypeFilter ? rows.filter((r) => edgeTypeFilter.has(r.edge_type)) : rows;
  }
  // both: query each direction, tag, and concat.
  const out = store.db
    .prepare(`
    SELECT e.target_node_id AS next_node_id, et.name AS edge_type
    FROM edges e JOIN edge_types et ON e.edge_type_id = et.id
    WHERE e.source_node_id = ?`)
    .all(nodeId) as NeighborRow[];
  const inc = store.db
    .prepare(`
    SELECT e.source_node_id AS next_node_id, et.name AS edge_type
    FROM edges e JOIN edge_types et ON e.edge_type_id = et.id
    WHERE e.target_node_id = ?`)
    .all(nodeId) as NeighborRow[];
  const merged = [...out, ...inc];
  return edgeTypeFilter ? merged.filter((r) => edgeTypeFilter.has(r.edge_type)) : merged;
}

// Rough heuristic: each visited node serialises to ~80 bytes of JSON; budget
// ourselves out at 4*chars to undershoot the model token count.
function approxNodeTokens(n: TraverseNode): number {
  return Math.ceil((n.id.length + n.name.length + 50) / 4);
}

export interface TraverseOptions {
  start_symbol_id?: string;
  start_file_path?: string;
  direction?: TraverseDirection;
  max_depth?: number;
  max_nodes?: number;
  edge_types?: string[];
  token_budget?: number;
}

export function traverseGraph(store: Store, options: TraverseOptions): TraverseResult | null {
  const direction = options.direction ?? 'outgoing';
  const maxDepth = options.max_depth ?? 3;
  const maxNodes = options.max_nodes ?? 100;
  const tokenBudget = options.token_budget ?? 4000;
  const edgeTypeFilter =
    options.edge_types && options.edge_types.length > 0 ? new Set(options.edge_types) : null;

  const root = lookupStartNode(store, options.start_symbol_id, options.start_file_path);
  if (!root) return null;
  const rootDesc = describeNode(store, root.rowId);
  if (!rootDesc) return null;

  // BFS with a queue. Track depth alongside node id; visited stops cycles.
  const visited = new Map<number, TraverseNode>();
  const queue: Array<{ id: number; depth: number; edgeType: string | null }> = [
    { id: root.rowId, depth: 0, edgeType: null },
  ];

  let truncatedByNodes = false;
  let truncatedByDepth = false;
  let truncatedByBudget = false;
  let tokenSum = 0;

  while (queue.length > 0) {
    const { id, depth, edgeType } = queue.shift()!;
    if (visited.has(id)) {
      // Already enqueued; bump in_degree.
      const existing = visited.get(id)!;
      existing.in_degree += 1;
      continue;
    }

    const desc = describeNode(store, id);
    if (!desc) continue;

    const node: TraverseNode = {
      id: desc.id,
      kind: desc.kind,
      name: desc.name,
      depth,
      edge_type: edgeType,
      in_degree: id === root.rowId ? 0 : 1,
    };
    const cost = approxNodeTokens(node);
    if (tokenSum + cost > tokenBudget) {
      truncatedByBudget = true;
      break;
    }
    tokenSum += cost;
    visited.set(id, node);

    if (visited.size >= maxNodes) {
      truncatedByNodes = true;
      break;
    }

    if (depth >= maxDepth) {
      // Only flag truncation when we actually had outgoing neighbors that
      // we'd otherwise have walked into. A leaf at the boundary is not a
      // truncation — it's the natural end of the walk.
      const neighbors = fetchNeighbors(store, id, direction, edgeTypeFilter);
      for (const n of neighbors) {
        if (!visited.has(n.next_node_id)) {
          truncatedByDepth = true;
          break;
        }
      }
      continue;
    }

    const neighbors = fetchNeighbors(store, id, direction, edgeTypeFilter);
    for (const n of neighbors) {
      if (!visited.has(n.next_node_id)) {
        queue.push({ id: n.next_node_id, depth: depth + 1, edgeType: n.edge_type });
      } else {
        // Tally indegree without re-pushing — `visited` is still authoritative.
        visited.get(n.next_node_id)!.in_degree += 1;
      }
    }
  }

  return {
    start: rootDesc,
    direction,
    nodes: [...visited.values()].sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name)),
    total_visited: visited.size,
    truncated_by_depth: truncatedByDepth,
    truncated_by_nodes: truncatedByNodes,
    truncated_by_budget: truncatedByBudget,
  };
}
