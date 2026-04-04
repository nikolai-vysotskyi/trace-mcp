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

/**
 * BFS traversal with batched queries per wave (replaces recursive N+1).
 * Each depth level: 1 batch edge query + 1 batch node resolution.
 */
function traverseIncoming(
  store: Store,
  startNodeId: number,
  _currentDepth: number,
  maxDepth: number,
  visited: Set<number>,
  dependents: ChangeImpactResult['dependents'],
  maxDependents: number,
): void {
  let frontier = [startNodeId];

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (frontier.length === 0 || dependents.length >= maxDependents) break;

    // Batch: get all incoming edges for the entire frontier
    const allEdges = store.getEdgesForNodesBatch(frontier);

    // Filter to incoming edges: pivot_node_id is the target, source is what we want
    const frontierSet = new Set(frontier);
    const newFrontier: number[] = [];
    const sourceNodeIds: number[] = [];
    const edgeBySource = new Map<number, string>(); // source_node_id → edge_type_name

    for (const edge of allEdges) {
      if (dependents.length + sourceNodeIds.length >= maxDependents) break;
      // incoming = edge.target_node_id is in frontier (pivot matches target)
      if (!frontierSet.has(edge.target_node_id)) continue;
      if (edge.source_node_id === edge.target_node_id) continue;

      const srcId = edge.source_node_id;
      if (visited.has(srcId)) continue;
      visited.add(srcId);

      sourceNodeIds.push(srcId);
      edgeBySource.set(srcId, edge.edge_type_name);
      newFrontier.push(srcId);
    }

    if (sourceNodeIds.length === 0) break;

    // Batch resolve node refs
    const nodeRefs = store.getNodeRefsBatch(sourceNodeIds);

    // Collect symbol and file IDs to batch-fetch
    const symbolIds: number[] = [];
    const fileIds: number[] = [];
    for (const [, ref] of nodeRefs) {
      if (ref.nodeType === 'symbol') symbolIds.push(ref.refId);
      else if (ref.nodeType === 'file') fileIds.push(ref.refId);
    }

    const symbolMap = symbolIds.length > 0 ? store.getSymbolsByIds(symbolIds) : new Map();
    const fileMap = fileIds.length > 0 ? store.getFilesByIds(fileIds) : new Map();

    // Also fetch files for symbols
    const symFileIds = new Set<number>();
    for (const sym of symbolMap.values()) symFileIds.add(sym.file_id);
    const symFiles = symFileIds.size > 0 ? store.getFilesByIds([...symFileIds]) : new Map();

    // Build dependents
    for (const srcId of sourceNodeIds) {
      if (dependents.length >= maxDependents) break;

      const ref = nodeRefs.get(srcId);
      if (!ref) continue;

      let filePath: string | undefined;
      let symbolId: string | undefined;

      if (ref.nodeType === 'symbol') {
        const sym = symbolMap.get(ref.refId);
        if (sym) {
          symbolId = sym.symbol_id;
          filePath = symFiles.get(sym.file_id)?.path;
        }
      } else if (ref.nodeType === 'file') {
        filePath = fileMap.get(ref.refId)?.path;
      }

      if (filePath) {
        dependents.push({
          path: filePath,
          symbolId,
          edgeType: edgeBySource.get(srcId) ?? 'unknown',
          depth,
        });
      }
    }

    frontier = newFrontier;
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
