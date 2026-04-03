import type { Store } from '../db/store.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { notFound } from '../errors.js';

export interface PennantUsageSite {
  filePath: string;
  line: number;
  usageType: string;
}

export interface PennantImpactResult {
  featureName: string;
  definedIn: { filePath: string; line: number }[];
  checkedBy: PennantUsageSite[];
  gatedRoutes: { filePath: string; line: number }[];
}

export interface ChangeImpactResult {
  target: { path: string; symbolId?: string };
  dependents: {
    path: string;
    symbolId?: string;
    edgeType: string;
    depth: number;
  }[];
  totalAffected: number;
  truncated?: boolean;
  /** Populated when the target is a Pennant feature flag name */
  pennant?: PennantImpactResult;
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
  depth = 3,
  maxDependents = 200,
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

  // Check if this might be a Pennant feature flag name (if no node found via symbol/file)
  const pennant = getPennantImpact(store, opts.symbolId ?? opts.filePath ?? '');

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

  traverseIncoming(store, startNodeId, 1, depth, visited, dependents, maxDependents);

  const truncated = dependents.length >= maxDependents;

  return ok({
    target: { path: targetPath, symbolId: targetSymbolId },
    dependents,
    totalAffected: dependents.length,
    ...(truncated ? { truncated: true } : {}),
    ...(pennant ? { pennant } : {}),
  });
}

function traverseIncoming(
  store: Store,
  nodeId: number,
  currentDepth: number,
  maxDepth: number,
  visited: Set<number>,
  dependents: ChangeImpactResult['dependents'],
  maxDependents: number,
): void {
  if (currentDepth > maxDepth) return;
  if (dependents.length >= maxDependents) return;

  const incomingEdges = store.getIncomingEdges(nodeId);

  for (const edge of incomingEdges) {
    if (dependents.length >= maxDependents) break;

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
    traverseIncoming(store, sourceNodeId, currentDepth + 1, maxDepth, visited, dependents, maxDependents);
  }
}

/**
 * Search Pennant feature flag edges for a given feature name.
 * Returns null if no matches found.
 */
function getPennantImpact(store: Store, name: string): PennantImpactResult | null {
  if (!name) return null;

  const definedIn: { filePath: string; line: number }[] = [];
  const checkedBy: PennantUsageSite[] = [];
  const gatedRoutes: { filePath: string; line: number }[] = [];

  for (const edgeType of ['feature_defined_in', 'feature_checked_by', 'feature_gates_route']) {
    const edges = store.getEdgesByType(edgeType);
    for (const edge of edges) {
      if (!edge.metadata) continue;
      let meta: Record<string, unknown>;
      try { meta = JSON.parse(edge.metadata) as Record<string, unknown>; } catch { continue; }
      if (meta.featureName !== name) continue;

      const filePath = String(meta.filePath ?? '');
      const line = Number(meta.line ?? 0);

      if (edgeType === 'feature_defined_in') {
        definedIn.push({ filePath, line });
      } else if (edgeType === 'feature_checked_by') {
        checkedBy.push({ filePath, line, usageType: String(meta.usageType ?? '') });
      } else if (edgeType === 'feature_gates_route') {
        gatedRoutes.push({ filePath, line });
      }
    }
  }

  if (definedIn.length === 0 && checkedBy.length === 0 && gatedRoutes.length === 0) return null;
  return { featureName: name, definedIn, checkedBy, gatedRoutes };
}
