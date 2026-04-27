/**
 * get_related_symbols — find symbols related via co-location, shared importers, and name overlap.
 */
import { ok, err } from 'neverthrow';
import type { Store, SymbolRow, FileRow } from '../../db/store.js';
import type { TraceMcpResult } from '../../errors.js';

interface RelatedSymbolItem {
  symbol_id: string;
  name: string;
  kind: string;
  file: string;
  line: number | null;
  score: number;
  signals: {
    co_location: number;
    shared_importers: number;
    name_overlap: number;
  };
}

interface RelatedSymbolsResult {
  target: { symbol_id: string; name: string; file: string };
  related: RelatedSymbolItem[];
}

/** Split camelCase / PascalCase / snake_case into tokens */
function tokenizeName(name: string): Set<string> {
  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_\-.]/)
    .filter((p) => p.length > 1);
  return new Set(parts);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const WEIGHT_COLOCATION = 0.3;
const WEIGHT_SHARED_IMPORTERS = 0.5;
const WEIGHT_NAME_OVERLAP = 0.2;

export function getRelatedSymbols(
  store: Store,
  opts: { symbolId: string; maxResults?: number },
): TraceMcpResult<RelatedSymbolsResult> {
  const maxResults = opts.maxResults ?? 20;

  // Resolve target symbol
  const target = store.getSymbolBySymbolId(opts.symbolId);
  if (!target) {
    return err({ code: 'NOT_FOUND' as const, id: opts.symbolId });
  }
  const targetFile = store.getFileById(target.file_id);
  if (!targetFile) {
    return err({ code: 'NOT_FOUND' as const, id: `file for ${opts.symbolId}` });
  }

  // Score map: symbol_id -> { co_location, shared_importers, name_overlap }
  const scores = new Map<
    number,
    { co_location: number; shared_importers: number; name_overlap: number }
  >();

  const ensureEntry = (id: number) => {
    if (!scores.has(id)) scores.set(id, { co_location: 0, shared_importers: 0, name_overlap: 0 });
    return scores.get(id)!;
  };

  // 1. Co-located symbols (same file)
  const colocated = store.getSymbolsByFile(target.file_id);
  for (const sym of colocated) {
    if (sym.id === target.id) continue;
    ensureEntry(sym.id).co_location = 1.0;
  }

  // 2. Shared importers via SQL
  const targetFileNodeId = store.getNodeId('file', target.file_id);
  if (targetFileNodeId !== undefined) {
    const sharedImporterRows = store.db
      .prepare(`
      WITH importers AS (
        SELECT DISTINCT e.source_node_id
        FROM edges e
        JOIN edge_types et ON e.edge_type_id = et.id
        WHERE e.target_node_id = ?
        AND et.name IN ('esm_imports', 'imports', 'py_imports', 'py_reexports')
        LIMIT 100
      ),
      total_importers AS (
        SELECT COUNT(*) as cnt FROM importers
      ),
      co_imported_files AS (
        SELECT e.target_node_id as node_id, COUNT(DISTINCT e.source_node_id) as shared_count
        FROM edges e
        JOIN edge_types et ON e.edge_type_id = et.id
        JOIN importers i ON e.source_node_id = i.source_node_id
        WHERE et.name IN ('esm_imports', 'imports', 'py_imports', 'py_reexports')
        AND e.target_node_id != ?
        GROUP BY e.target_node_id
      )
      SELECT cif.node_id, cif.shared_count, ti.cnt as total_importers
      FROM co_imported_files cif, total_importers ti
      ORDER BY cif.shared_count DESC
      LIMIT 50
    `)
      .all(targetFileNodeId, targetFileNodeId) as Array<{
      node_id: number;
      shared_count: number;
      total_importers: number;
    }>;

    if (sharedImporterRows.length > 0) {
      // Resolve node IDs to file IDs, then get symbols from those files
      const nodeIds = sharedImporterRows.map((r) => r.node_id);
      const nodeRefs = store.getNodeRefsBatch(nodeIds);

      const fileNodeMap = new Map<number, { shared: number; total: number }>();
      for (const row of sharedImporterRows) {
        const ref = nodeRefs.get(row.node_id);
        if (ref?.nodeType === 'file') {
          fileNodeMap.set(ref.refId, { shared: row.shared_count, total: row.total_importers });
        }
      }

      // Get symbols from co-imported files (batched instead of per-file N+1)
      const coFileIds = [...fileNodeMap.keys()];
      if (coFileIds.length > 0) {
        const placeholders = coFileIds.map(() => '?').join(',');
        const allCoSymbols = store.db
          .prepare(`SELECT * FROM symbols WHERE file_id IN (${placeholders})`)
          .all(...coFileIds) as Array<{
          id: number;
          file_id: number;
          name: string;
          kind: string;
          symbol_id: string;
          fqn: string | null;
          signature: string | null;
          line_start: number | null;
        }>;
        for (const sym of allCoSymbols) {
          if (sym.id === target.id) continue;
          const info = fileNodeMap.get(sym.file_id);
          if (!info) continue;
          const sharedScore = info.total > 0 ? info.shared / info.total : 0;
          ensureEntry(sym.id).shared_importers = Math.max(
            ensureEntry(sym.id).shared_importers,
            sharedScore,
          );
        }
      }
    }
  }

  // 3. Name-token overlap for all candidates
  const targetTokens = tokenizeName(target.name);
  const candidateIds = [...scores.keys()];
  const candidateSymbols = store.getSymbolsByIds(candidateIds);
  const candidateFileIds = [...new Set([...candidateSymbols.values()].map((s) => s.file_id))];
  const fileMap = store.getFilesByIds(candidateFileIds);

  for (const [symId, sym] of candidateSymbols) {
    const nameScore = jaccard(targetTokens, tokenizeName(sym.name));
    if (nameScore > 0) {
      ensureEntry(symId).name_overlap = nameScore;
    }
  }

  // Build scored results
  const results: RelatedSymbolItem[] = [];
  for (const [symId, signals] of scores) {
    const sym = candidateSymbols.get(symId);
    if (!sym) continue;
    const file = fileMap.get(sym.file_id);

    const compositeScore =
      signals.co_location * WEIGHT_COLOCATION +
      signals.shared_importers * WEIGHT_SHARED_IMPORTERS +
      signals.name_overlap * WEIGHT_NAME_OVERLAP;

    if (compositeScore <= 0) continue;

    results.push({
      symbol_id: sym.symbol_id,
      name: sym.name,
      kind: sym.kind,
      file: file?.path ?? '',
      line: sym.line_start,
      score: Math.round(compositeScore * 1000) / 1000,
      signals: {
        co_location: Math.round(signals.co_location * 1000) / 1000,
        shared_importers: Math.round(signals.shared_importers * 1000) / 1000,
        name_overlap: Math.round(signals.name_overlap * 1000) / 1000,
      },
    });
  }

  results.sort((a, b) => b.score - a.score);

  return ok({
    target: {
      symbol_id: target.symbol_id,
      name: target.name,
      file: targetFile.path,
    },
    related: results.slice(0, maxResults),
  });
}
