/**
 * get_di_tree — NestJS dependency injection tree.
 *
 * Traces: service -> what it injects -> who injects it.
 */
import type { Store } from '../../db/store.js';
import { ok, err, type TraceMcpResult } from '../../errors.js';
import { notFound } from '../../errors.js';

interface DINode {
  name: string;
  symbolId?: string;
  file?: string;
}

interface DITreeResult {
  service: DINode;
  injects: DINode[];     // what this service depends on
  injectedBy: DINode[];  // what depends on this service
}

/**
 * Build a DI tree for a NestJS service.
 * Uses nest_injects edges from the graph.
 */
export function getDITree(
  store: Store,
  serviceName: string,
): TraceMcpResult<DITreeResult> {
  // Find the service symbol by name or FQN
  const symbol = store.getSymbolByFqn(serviceName)
    ?? findSymbolByName(store, serviceName);

  if (!symbol) {
    return err(notFound(serviceName, ['Service not found. Try using the full class name.']));
  }

  const file = store.getFileById(symbol.file_id);
  const service: DINode = {
    name: symbol.name,
    symbolId: symbol.symbol_id,
    file: file?.path,
  };

  const nodeId = store.getNodeId('symbol', symbol.id);
  if (nodeId == null) {
    return ok({ service, injects: [], injectedBy: [] });
  }

  // What this service injects + who injects it — batch resolved
  const outEdges = store.getOutgoingEdges(nodeId).filter((e) => e.edge_type_name === 'nest_injects');
  const inEdges = store.getIncomingEdges(nodeId).filter((e) => e.edge_type_name === 'nest_injects');

  // Batch resolve all referenced nodes
  const allNodeIds = [
    ...outEdges.map((e) => e.target_node_id),
    ...inEdges.map((e) => e.source_node_id),
  ];
  const nodeRefs = store.getNodeRefsBatch(allNodeIds);
  const symRefIds = [...nodeRefs.values()].filter((r) => r.nodeType === 'symbol').map((r) => r.refId);
  const symMap = symRefIds.length > 0 ? store.getSymbolsByIds(symRefIds) : new Map();
  const fileIds = [...new Set([...symMap.values()].map((s) => s.file_id))];
  const fileMap = fileIds.length > 0 ? store.getFilesByIds(fileIds) : new Map();

  const injects: DINode[] = [];
  for (const edge of outEdges) {
    const ref = nodeRefs.get(edge.target_node_id);
    if (!ref || ref.nodeType !== 'symbol') continue;
    const sym = symMap.get(ref.refId);
    if (!sym) continue;
    injects.push({ name: sym.name, symbolId: sym.symbol_id, file: fileMap.get(sym.file_id)?.path });
  }

  const injectedBy: DINode[] = [];
  for (const edge of inEdges) {
    const ref = nodeRefs.get(edge.source_node_id);
    if (!ref || ref.nodeType !== 'symbol') continue;
    const sym = symMap.get(ref.refId);
    if (!sym) continue;
    injectedBy.push({ name: sym.name, symbolId: sym.symbol_id, file: fileMap.get(sym.file_id)?.path });
  }

  return ok({ service, injects, injectedBy });
}

function findSymbolByName(
  store: Store,
  name: string,
): ReturnType<Store['getSymbolByFqn']> {
  return store.getSymbolByName(name, 'class');
}
