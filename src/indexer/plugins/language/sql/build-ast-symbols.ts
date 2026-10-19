import type { RawSymbol } from '../../../../plugin-api/types.js';
import {
  buildCteSymbolMetadata,
  buildSqlFileSymbolMetadata,
  buildSqlFileUnitMetadata,
  sqlCteSymbolId,
  sqlFileUnitSymbolId,
} from './sql-index-metadata.js';
import type { SqlSpikeParseResult } from './spike-parse.js';

function mergeFileMeta(
  spike: SqlSpikeParseResult,
  extractor: 'tree-sitter-sql' | 'regex-fallback',
  notes?: string,
): Record<string, unknown> {
  const fileMeta = buildSqlFileSymbolMetadata(spike, { extractor, notes });
  return { ...fileMeta };
}

export function buildCteSymbolsFromSpike(
  filePath: string,
  spike: SqlSpikeParseResult,
  opts?: { extractor?: 'tree-sitter-sql' | 'regex-fallback'; notes?: string },
): RawSymbol[] {
  const extractor = opts?.extractor ?? 'tree-sitter-sql';
  const fileMeta = mergeFileMeta(spike, extractor, opts?.notes);
  const out: RawSymbol[] = [];

  for (const cte of spike.ctes) {
    const cteMeta = buildCteSymbolMetadata(cte);
    out.push({
      symbolId: sqlCteSymbolId(filePath, cte.name, cte.lineStart, cte.defIndex),
      name: cte.name,
      kind: 'variable',
      fqn: cte.name,
      byteStart: cte.byteStart,
      byteEnd: cte.byteEnd,
      lineStart: cte.lineStart,
      lineEnd: cte.lineEnd,
      metadata: {
        ...fileMeta,
        ...cteMeta,
      },
    });
  }

  return out;
}

/** Standalone SELECT / DDL-only files: file-level symbol so sql_reads can run without CTEs. */
export function buildSqlFileUnitSymbolFromSpike(
  filePath: string,
  source: string,
  spike: SqlSpikeParseResult,
  opts?: { extractor?: 'tree-sitter-sql' | 'regex-fallback'; notes?: string },
): RawSymbol | null {
  if (spike.ctes.length > 0) return null;
  if (spike.relationRefs.length === 0 && spike.status === 'failed') return null;
  const extractor = opts?.extractor ?? 'tree-sitter-sql';
  const fileMeta = mergeFileMeta(spike, extractor, opts?.notes);
  const lineEnd = source.split('\n').length;
  return {
    symbolId: sqlFileUnitSymbolId(filePath),
    name: '__sql',
    kind: 'module',
    fqn: filePath,
    byteStart: 0,
    byteEnd: source.length,
    lineStart: 1,
    lineEnd,
    metadata: {
      ...fileMeta,
      ...buildSqlFileUnitMetadata(),
    },
  };
}

export function annotateSymbolsWithFileMeta(
  symbols: RawSymbol[],
  spike: SqlSpikeParseResult,
  extractor: 'tree-sitter-sql' | 'regex-fallback',
  notes?: string,
): RawSymbol[] {
  const fileMeta = mergeFileMeta(spike, extractor, notes);
  return symbols.map((s) => ({
    ...s,
    metadata: { ...fileMeta, ...(s.metadata ?? {}) },
  }));
}
