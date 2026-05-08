import { err, ok } from 'neverthrow';
import type { Store } from '../../db/store.js';
import { notFound, type TraceMcpResult } from '../../errors.js';
import { expandMethodViaCha } from '../shared/cha.js';
import {
  emptyResolutionTiers,
  inferResolution,
  type EdgeResolution,
  type ResolutionTiers,
} from '../shared/resolution.js';
import { resolveSymbolInput } from '../shared/resolve.js';

interface ReferenceItem {
  /** Edge type describing the relationship (e.g. 'imports', 'calls', 'renders_component') */
  edge_type: string;
  /** Resolution confidence — lsp_resolved (compiler-grade) > ast_resolved > ast_inferred > text_matched (fuzzy) */
  resolution_tier: EdgeResolution;
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
  /** When the reference was found via CHA (polymorphic dispatch), the resolved receiver type */
  via_cha?: string;
}

interface FindReferencesResult {
  target: {
    symbol_id?: string;
    file?: string;
    fqn?: string | null;
  };
  references: ReferenceItem[];
  total: number;
  /** Counts of references by resolution tier — agents can prefer high-tier results when filtering noise */
  resolution_tiers: ResolutionTiers;
  /** If CHA expanded the search, lists the equivalent methods found */
  cha_expansion?: { symbol_id: string; name: string; relation: string }[];
  /** Set when ambiguous text_matched edges were skipped because the target
   * name is shared with many other symbols (graphify #543 phantom-god-node
   * fix). Lets callers know the result was tightened. */
  ambiguous_filtered?: { dropped: number; nameCollisions: number };
}

/**
 * Find all incoming references to a symbol or file node.
 * Returns every edge pointing at the target, with the referencing symbol resolved.
 *
 * `includeAmbiguousTextMatched` (default false) controls whether weakly-grounded
 * `text_matched` edges aimed at common method names like `log`, `execute`, `run`
 * are kept. graphify v0.5.5 / v0.6.3 fixed the same phantom-god-node problem
 * by dropping cross-file edges whose callee resolved to 2+ candidates. We do
 * the analogous filter at query time: when the target's simple name collides
 * with many other symbols and the edge is text_matched, drop it.
 */
export function findReferences(
  store: Store,
  opts: {
    symbolId?: string;
    fqn?: string;
    filePath?: string;
    includeAmbiguousTextMatched?: boolean;
    ambiguityThreshold?: number;
  },
): TraceMcpResult<FindReferencesResult> {
  let nodeId: number | undefined;
  const targetMeta: FindReferencesResult['target'] = {};

  if (opts.symbolId || opts.fqn) {
    const resolved = resolveSymbolInput(store, opts);
    if (!resolved) return err(notFound(opts.symbolId ?? opts.fqn ?? 'unknown'));
    const symbol = resolved.symbol;
    targetMeta.symbol_id = symbol.symbol_id;
    targetMeta.fqn = symbol.fqn;
    if (resolved.file) targetMeta.file = resolved.file.path;
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
    return ok({
      target: targetMeta,
      references: [],
      total: 0,
      resolution_tiers: emptyResolutionTiers(),
    });
  }

  // CHA expansion: for method symbols, also collect references to polymorphically-equivalent methods
  let chaExpansion: FindReferencesResult['cha_expansion'];
  let allTargetNodeIds: number[] = [nodeId];

  if (opts.symbolId || opts.fqn) {
    const resolved = resolveSymbolInput(store, opts);
    if (resolved) {
      const chaMatches = expandMethodViaCha(store, resolved.symbol);
      if (chaMatches.length > 1) {
        allTargetNodeIds = chaMatches.map((m) => m.nodeId);
        chaExpansion = chaMatches
          .filter((m) => m.relation !== 'self')
          .map((m) => ({
            symbol_id: m.symbol.symbol_id,
            name: m.symbol.name,
            relation: m.relation,
          }));
      }
    }
  }

  // Collect incoming edges for all target nodes (self + CHA equivalents)
  const allIncomingEdges: Array<{
    edge: ReturnType<Store['getIncomingEdges']>[0];
    via_cha?: string;
  }> = [];
  const seenEdgeKeys = new Set<string>();

  for (const targetNid of allTargetNodeIds) {
    const edges = store.getIncomingEdges(targetNid);
    const isChaTarget = targetNid !== nodeId;
    for (const edge of edges) {
      // Dedup by (source, target, type) to avoid duplicates when CHA overlaps
      const key = `${edge.source_node_id}:${edge.target_node_id}:${edge.edge_type_id}`;
      if (seenEdgeKeys.has(key)) continue;
      seenEdgeKeys.add(key);
      allIncomingEdges.push({
        edge,
        via_cha: isChaTarget
          ? chaExpansion?.find((c) => {
              const ref = store.getNodeRef(targetNid);
              return ref && ref.nodeType === 'symbol'
                ? store.getSymbolById(ref.refId)?.symbol_id === c.symbol_id
                : false;
            })?.name
          : undefined,
      });
    }
  }

  // Batch resolve all source nodes, symbols, and files (replaces per-edge N+1)
  const sourceNodeIds = allIncomingEdges.map((e) => e.edge.source_node_id);
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

  for (const { edge, via_cha } of allIncomingEdges) {
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

    const ref: ReferenceItem = {
      edge_type: edge.edge_type_name,
      resolution_tier: inferResolution(edge),
      symbol,
      file: filePath,
    };
    if (via_cha) ref.via_cha = via_cha;
    references.push(ref);
  }

  // Phantom god-node filter — drop text_matched edges into a target whose
  // simple name collides with many other symbols. Without this, names like
  // `log`, `handle`, `execute`, `run` accumulate hundreds of spurious cross-
  // file incoming edges, since the indexer cannot tell which `log` is meant.
  let kept = references;
  let ambiguousFiltered: { dropped: number; nameCollisions: number } | undefined;
  const includeAmbiguous = opts.includeAmbiguousTextMatched ?? false;
  const ambiguityThreshold = opts.ambiguityThreshold ?? 3;
  if (!includeAmbiguous && (opts.symbolId || opts.fqn)) {
    const resolved = resolveSymbolInput(store, opts);
    if (resolved) {
      const targetName = resolved.symbol.name;
      const nameCollisions = store.countSymbolsByName(targetName);
      if (nameCollisions >= ambiguityThreshold) {
        const filtered = references.filter((r) => r.resolution_tier !== 'text_matched');
        const dropped = references.length - filtered.length;
        if (dropped > 0) {
          kept = filtered;
          ambiguousFiltered = { dropped, nameCollisions };
        }
      }
    }
  }

  const tiers = emptyResolutionTiers();
  for (const r of kept) tiers[r.resolution_tier]++;

  const result: FindReferencesResult = {
    target: targetMeta,
    references: kept,
    total: kept.length,
    resolution_tiers: tiers,
  };
  if (chaExpansion && chaExpansion.length > 0) result.cha_expansion = chaExpansion;
  if (ambiguousFiltered) result.ambiguous_filtered = ambiguousFiltered;
  return ok(result);
}
