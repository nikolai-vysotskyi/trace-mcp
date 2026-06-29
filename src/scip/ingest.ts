/**
 * SCIP ingestion — upgrade edge precision from a parsed SCIP index.
 *
 * Algorithm (mirrors the spirit of src/lsp/enrichment.ts):
 *  1. Walk every SCIP Document's definition occurrences and build a global map
 *     `scipSymbol → { file, symbol }` resolved against trace-mcp's index.
 *  2. Walk every reference occurrence (non-definition). Map it to:
 *       - source: the enclosing trace-mcp symbol at the reference's position
 *       - target: the trace-mcp symbol that *defines* the reference's SCIP
 *         symbol (looked up in the map from step 1)
 *  3. If a call/reference edge between source→target already exists, upgrade its
 *     resolution_tier to `scip_resolved`. Otherwise insert a new `references`
 *     edge tagged `scip_resolved` (compiler-grade, above lsp_resolved).
 *
 * The decoder is dependency-free (src/scip/protocol.ts); this module is pure DB
 * plumbing and is independently unit-testable against a fixture index + store.
 */

import type { Store } from '../db/store.js';
import type { FileRow, SymbolRow } from '../db/types.js';
import { logger } from '../logger.js';
import { decodeScipIndex, type ScipIndex } from './protocol.js';

/** Edge types eligible for a SCIP upgrade — same call/reference family as LSP. */
const SCIP_EDGE_TYPES = ['calls', 'references', 'esm_imports', 'imports', 'uses'] as const;

export interface ScipIngestResult {
  edgesUpgraded: number;
  edgesAdded: number;
  /** SCIP definition occurrences that mapped to a trace-mcp symbol. */
  definitionsMapped: number;
  /** Reference occurrences whose source OR target could not be resolved. */
  unresolvedReferences: number;
  documentsProcessed: number;
}

function emptyResult(): ScipIngestResult {
  return {
    edgesUpgraded: 0,
    edgesAdded: 0,
    definitionsMapped: 0,
    unresolvedReferences: 0,
    documentsProcessed: 0,
  };
}

/** Find the narrowest trace-mcp symbol whose line range contains a 0-based line. */
function symbolAtLine(symbols: SymbolRow[], zeroBasedLine: number): SymbolRow | null {
  const traceLine = zeroBasedLine + 1; // trace-mcp is 1-based
  let best: SymbolRow | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const sym of symbols) {
    const start = sym.line_start ?? 0;
    const end = sym.line_end ?? start;
    if (traceLine >= start && traceLine <= end) {
      const span = end - start;
      if (span < bestSpan) {
        bestSpan = span;
        best = sym;
      }
    }
  }
  return best;
}

interface DefTarget {
  file: FileRow;
  symbol: SymbolRow;
}

/**
 * Ingest a decoded SCIP index into the store, upgrading/inserting edges with
 * the `scip_resolved` tier. Pure DB operations — no IO beyond the store.
 */
export function ingestScipIndex(store: Store, index: ScipIndex): ScipIngestResult {
  const result = emptyResult();

  // Cache symbols-by-file so we don't re-query per occurrence.
  const symbolCache = new Map<number, SymbolRow[]>();
  const symbolsFor = (file: FileRow): SymbolRow[] => {
    let cached = symbolCache.get(file.id);
    if (!cached) {
      cached = store.getSymbolsByFile(file.id);
      symbolCache.set(file.id, cached);
    }
    return cached;
  };

  // ── Pass 1: map SCIP definition symbols → trace-mcp symbols ──────────────
  const defBySymbol = new Map<string, DefTarget>();
  for (const doc of index.documents) {
    const file = store.getFile(doc.relativePath);
    if (!file) continue;
    const symbols = symbolsFor(file);
    for (const occ of doc.occurrences) {
      if (!occ.isDefinition || !occ.symbol) continue;
      const sym = symbolAtLine(symbols, occ.range.startLine);
      if (!sym) continue;
      // First definition wins; SCIP guarantees one canonical definition.
      if (!defBySymbol.has(occ.symbol)) {
        defBySymbol.set(occ.symbol, { file, symbol: sym });
        result.definitionsMapped++;
      }
    }
  }

  // ── Build existing call/reference edge lookup: `${src}:${tgt}` → edgeId ──
  const existingEdges = new Map<string, number>();
  for (const edgeType of SCIP_EDGE_TYPES) {
    for (const edge of store.getEdgesByType(edgeType)) {
      existingEdges.set(`${edge.source_node_id}:${edge.target_node_id}`, edge.id);
    }
  }

  const upgradeStmt = store.db.prepare(
    `UPDATE edges SET resolution_tier = 'scip_resolved'
     WHERE id = ? AND resolution_tier != 'scip_resolved'`,
  );

  // ── Pass 2: map reference occurrences → source/target edges ──────────────
  for (const doc of index.documents) {
    const file = store.getFile(doc.relativePath);
    if (!file) continue;
    result.documentsProcessed++;
    const symbols = symbolsFor(file);

    for (const occ of doc.occurrences) {
      if (occ.isDefinition || !occ.symbol) continue;

      // Local references (a symbol referencing itself within its own def line)
      // are noise — skip them.
      const def = defBySymbol.get(occ.symbol);
      if (!def) {
        result.unresolvedReferences++;
        continue;
      }

      const sourceSym = symbolAtLine(symbols, occ.range.startLine);
      if (!sourceSym) {
        result.unresolvedReferences++;
        continue;
      }

      // Self-edges (reference inside the very symbol it points at) add nothing.
      if (sourceSym.id === def.symbol.id) continue;

      const sourceNodeId = store.getNodeId('symbol', sourceSym.id);
      const targetNodeId = store.getNodeId('symbol', def.symbol.id);
      if (sourceNodeId == null || targetNodeId == null) {
        result.unresolvedReferences++;
        continue;
      }

      const key = `${sourceNodeId}:${targetNodeId}`;
      const existingId = existingEdges.get(key);

      if (existingId != null) {
        const info = upgradeStmt.run(existingId);
        if (info.changes > 0) result.edgesUpgraded++;
      } else {
        const insertion = store.insertEdge(
          sourceNodeId,
          targetNodeId,
          'references',
          true,
          undefined,
          false,
          'scip_resolved',
        );
        if (insertion.isOk()) {
          result.edgesAdded++;
          // Avoid double-inserting if the same (src,tgt) recurs in this index.
          existingEdges.set(key, insertion.value);
        }
      }
    }
  }

  return result;
}

/**
 * Decode a `.scip` byte buffer and ingest it. Convenience wrapper used by the
 * bridge. Returns an empty result (and logs) on a decode failure rather than
 * throwing — SCIP ingestion is best-effort enrichment.
 */
export function ingestScipBytes(store: Store, bytes: Uint8Array): ScipIngestResult {
  let index: ScipIndex;
  try {
    index = decodeScipIndex(bytes);
  } catch (e) {
    logger.warn({ error: (e as Error).message }, 'Failed to decode SCIP index');
    return emptyResult();
  }
  return ingestScipIndex(store, index);
}
