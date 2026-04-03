/**
 * get_di_tree — NestJS dependency injection tree.
 *
 * Traces: service -> what it injects -> who injects it.
 */
import type { Store } from '../db/store.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { notFound } from '../errors.js';

export interface DINode {
  name: string;
  symbolId?: string;
  file?: string;
}

export interface DITreeResult {
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

  // What this service injects (outgoing nest_injects edges)
  const outEdges = store.getOutgoingEdges(nodeId);
  const injects: DINode[] = [];

  for (const edge of outEdges) {
    if (edge.edge_type_name !== 'nest_injects') continue;
    const targetRef = store.getNodeByNodeId(edge.target_node_id);
    if (!targetRef || targetRef.node_type !== 'symbol') continue;

    const targetSym = store.getSymbolById(targetRef.ref_id);
    if (!targetSym) continue;

    const targetFile = store.getFileById(targetSym.file_id);
    injects.push({
      name: targetSym.name,
      symbolId: targetSym.symbol_id,
      file: targetFile?.path,
    });
  }

  // Who injects this service (incoming nest_injects edges)
  const inEdges = store.getIncomingEdges(nodeId);
  const injectedBy: DINode[] = [];

  for (const edge of inEdges) {
    if (edge.edge_type_name !== 'nest_injects') continue;
    const sourceRef = store.getNodeByNodeId(edge.source_node_id);
    if (!sourceRef || sourceRef.node_type !== 'symbol') continue;

    const sourceSym = store.getSymbolById(sourceRef.ref_id);
    if (!sourceSym) continue;

    const sourceFile = store.getFileById(sourceSym.file_id);
    injectedBy.push({
      name: sourceSym.name,
      symbolId: sourceSym.symbol_id,
      file: sourceFile?.path,
    });
  }

  return ok({ service, injects, injectedBy });
}

function findSymbolByName(
  store: Store,
  name: string,
): ReturnType<Store['getSymbolByFqn']> {
  return store.getSymbolByName(name, 'class');
}
