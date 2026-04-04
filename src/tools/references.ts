import type { Store, SymbolRow, FileRow } from '../db/store.js';
import { notFound, type TraceMcpResult } from '../errors.js';
import { ok, err } from 'neverthrow';

export interface ReferenceItem {
  /** Edge type describing the relationship (e.g. 'imports', 'calls', 'renders_component') */
  edge_type: string;
  /** Symbol that references the target (null if the referencing node is a file/route/component) */
  symbol: {
    symbol_id: string;
    name: string;
    kind: string;
    fqn: string | null;
    signature: string | null;
    line_start: number | null;
  } | null;
  file: string;
}

export interface FindReferencesResult {
  target: {
    symbol_id?: string;
    file?: string;
    fqn?: string | null;
  };
  references: ReferenceItem[];
  total: number;
}

/**
 * Find all incoming references to a symbol or file node.
 * Returns every edge pointing at the target, with the referencing symbol resolved.
 */
export function findReferences(
  store: Store,
  opts: { symbolId?: string; fqn?: string; filePath?: string },
): TraceMcpResult<FindReferencesResult> {
  let nodeId: number | undefined;
  let targetMeta: FindReferencesResult['target'] = {};

  if (opts.symbolId || opts.fqn) {
    let symbol: SymbolRow | undefined;
    if (opts.symbolId) {
      symbol = store.getSymbolBySymbolId(opts.symbolId);
      targetMeta.symbol_id = opts.symbolId;
    } else {
      symbol = store.getSymbolByFqn(opts.fqn!);
      targetMeta.fqn = opts.fqn;
    }
    if (!symbol) return err(notFound(opts.symbolId ?? opts.fqn ?? 'unknown'));
    const file = store.getFileById(symbol.file_id);
    if (file) targetMeta.file = file.path;
    nodeId = store.getNodeId('symbol', symbol.id);
  } else if (opts.filePath) {
    const file = store.getFile(opts.filePath);
    if (!file) return err(notFound(opts.filePath));
    targetMeta.file = file.path;
    nodeId = store.getNodeId('file', file.id);
  } else {
    return err(notFound('provide symbol_id, fqn, or file_path'));
  }

  if (nodeId === undefined) {
    // Node not in the graph (file indexed but no edges yet)
    return ok({ target: targetMeta, references: [], total: 0 });
  }

  const incomingEdges = store.getIncomingEdges(nodeId);

  // Batch resolve all source nodes, symbols, and files (replaces per-edge N+1)
  const sourceNodeIds = incomingEdges.map((e) => e.source_node_id);
  const nodeRefs = store.getNodeRefsBatch(sourceNodeIds);

  const symbolRefIds: number[] = [];
  const fileRefIds: number[] = [];
  for (const [, ref] of nodeRefs) {
    if (ref.nodeType === 'symbol') symbolRefIds.push(ref.refId);
    else if (ref.nodeType === 'file') fileRefIds.push(ref.refId);
  }

  const symbolMap = symbolRefIds.length > 0 ? store.getSymbolsByIds(symbolRefIds) : new Map();
  const symFileIds = new Set<number>();
  for (const sym of symbolMap.values()) symFileIds.add(sym.file_id);
  const allFileIds = [...new Set([...fileRefIds, ...symFileIds])];
  const fileMap = allFileIds.length > 0 ? store.getFilesByIds(allFileIds) : new Map();

  const references: ReferenceItem[] = [];

  for (const edge of incomingEdges) {
    const sourceRef = nodeRefs.get(edge.source_node_id);
    if (!sourceRef) continue;

    let symbol: ReferenceItem['symbol'] = null;
    let filePath = '';

    if (sourceRef.nodeType === 'symbol') {
      const sym = symbolMap.get(sourceRef.refId);
      if (!sym) continue;
      filePath = fileMap.get(sym.file_id)?.path ?? '';
      symbol = {
        symbol_id: sym.symbol_id,
        name: sym.name,
        kind: sym.kind,
        fqn: sym.fqn,
        signature: sym.signature,
        line_start: sym.line_start,
      };
    } else if (sourceRef.nodeType === 'file') {
      filePath = fileMap.get(sourceRef.refId)?.path ?? '';
    } else {
      filePath = `[${sourceRef.nodeType}:${sourceRef.refId}]`;
    }

    references.push({
      edge_type: edge.edge_type_name,
      symbol,
      file: filePath,
    });
  }

  return ok({ target: targetMeta, references, total: references.length });
}
