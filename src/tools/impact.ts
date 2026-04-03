import type { Store } from '../db/store.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { notFound } from '../errors.js';

export interface ChangeImpactResult {
  target: { path: string; symbolId?: string };
  dependents: {
    path: string;
    symbolId?: string;
    edgeType: string;
    depth: number;
  }[];
  totalAffected: number;
}

/**
 * Determine the impact of changing a file or symbol.
 *
 * Traverses INCOMING edges (who depends on this?) up to `depth` levels,
 * returning all affected files/symbols with their edge types.
 */
export function getChangeImpact(
  store: Store,
  opts: { filePath?: string; symbolId?: string },
  depth = 5,
): TraceMcpResult<ChangeImpactResult> {
  let startNodeId: number | undefined;
  let targetPath: string;
  let targetSymbolId: string | undefined;

  if (opts.symbolId) {
    const sym = store.getSymbolBySymbolId(opts.symbolId);
    if (!sym) {
      return err(notFound(opts.symbolId));
    }
    startNodeId = store.getNodeId('symbol', sym.id);
    const file = store.getFileById(sym.file_id);
    targetPath = file?.path ?? 'unknown';
    targetSymbolId = opts.symbolId;
  } else if (opts.filePath) {
    const file = store.getFile(opts.filePath);
    if (!file) {
      return err(notFound(opts.filePath));
    }
    targetPath = file.path;

    // Start from the file's primary symbol (class) or the file node itself
    const symbols = store.getSymbolsByFile(file.id);
    const primarySymbol = symbols.find((s) => s.kind === 'class') ?? symbols[0];
    if (primarySymbol) {
      startNodeId = store.getNodeId('symbol', primarySymbol.id);
      targetSymbolId = primarySymbol.symbol_id;
    } else {
      startNodeId = store.getNodeId('file', file.id);
    }
  } else {
    return err(notFound('', ['Provide either filePath or symbolId']));
  }

  if (startNodeId == null) {
    return ok({
      target: { path: targetPath, symbolId: targetSymbolId },
      dependents: [],
      totalAffected: 0,
    });
  }

  // Traverse incoming edges recursively
  const dependents: ChangeImpactResult['dependents'] = [];
  const visited = new Set<number>();
  visited.add(startNodeId);

  traverseIncoming(store, startNodeId, 1, depth, visited, dependents);

  return ok({
    target: { path: targetPath, symbolId: targetSymbolId },
    dependents,
    totalAffected: dependents.length,
  });
}

function traverseIncoming(
  store: Store,
  nodeId: number,
  currentDepth: number,
  maxDepth: number,
  visited: Set<number>,
  dependents: ChangeImpactResult['dependents'],
): void {
  if (currentDepth > maxDepth) return;

  const incomingEdges = store.getIncomingEdges(nodeId);

  for (const edge of incomingEdges) {
    const sourceNodeId = edge.source_node_id;
    if (visited.has(sourceNodeId)) continue;
    visited.add(sourceNodeId);

    const nodeRef = store.getNodeByNodeId(sourceNodeId);
    if (!nodeRef) continue;

    let filePath: string | undefined;
    let symbolId: string | undefined;

    if (nodeRef.node_type === 'symbol') {
      const sym = store.getSymbolById(nodeRef.ref_id);
      if (sym) {
        symbolId = sym.symbol_id;
        const file = store.getFileById(sym.file_id);
        filePath = file?.path;
      }
    } else if (nodeRef.node_type === 'file') {
      const file = store.getFileById(nodeRef.ref_id);
      filePath = file?.path;
    }

    if (filePath) {
      dependents.push({
        path: filePath,
        symbolId,
        edgeType: edge.edge_type_name,
        depth: currentDepth,
      });
    }

    // Continue traversal
    traverseIncoming(store, sourceNodeId, currentDepth + 1, maxDepth, visited, dependents);
  }
}
