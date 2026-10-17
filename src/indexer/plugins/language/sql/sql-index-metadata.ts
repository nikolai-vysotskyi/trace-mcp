/**
 * Phase 3 contract: metadata shape for `.sql` file symbols and CTE symbols.
 * Joins, aliases, and column refs stay in metadata (not top-level symbol kinds).
 */
import type { ExtractedCte, ExtractedRelationRef } from './ast-extract.js';
import type { SqlParseStatus, SqlSpikeParseResult } from './spike-parse.js';
import type { SqlPreprocessResult } from './preprocess.js';

/** Steps applied by `preprocessSqlForParse` (parse-only; repo files unchanged). */
export const SQL_PREPROCESSOR_PIPELINE = [
  'template_mustache',
  'python_format_braces',
  'bind_param',
  'pg_distinct_on_join',
  'pg_materialized_cte',
  'pg_ilike_to_like',
  'pg_at_time_zone_fold',
] as const;

export type SqlPreprocessorStep = (typeof SQL_PREPROCESSOR_PIPELINE)[number];

export type SqlRelationConfidence = 'deterministic' | 'template-dependent' | 'heuristic';

export interface SqlRelationRefMeta {
  text: string;
  lineStart: number;
  confidence: SqlRelationConfidence;
}

export interface SqlCteSymbolMetadata {
  sqlKind: 'cte';
  name: string;
  lineStart: number;
  lineEnd: number;
  referencesCtes: string[];
  defIndex?: number;
}

export interface SqlFileUnitMetadata {
  sqlKind: 'file';
}

export interface SqlFileSymbolMetadata {
  dialect: 'postgresql';
  parseStatus: SqlParseStatus;
  hasError: boolean;
  extractor: 'tree-sitter-sql' | 'regex-fallback';
  preprocessorApplied: readonly SqlPreprocessorStep[];
  templates: SqlPreprocessResult['templates'];
  bindParams: string[];
  formatSlots: SqlPreprocessResult['formatSlots'];
  cteCount: number;
  relationRefs: SqlRelationRefMeta[];
  /** Reserved for Phase 4 — table/alias pairs from AST or heuristics. */
  aliases: Array<{ alias: string; relation: string; confidence: SqlRelationConfidence }>;
  notes?: string;
}

/** Stable CTE symbol id (compat with v3.34.6 regex indexer). Repeated names use `@line`. */
export function sqlCteSymbolId(
  filePath: string,
  cteName: string,
  lineStart?: number,
  defIndex?: number,
): string {
  if (defIndex != null && defIndex > 0 && lineStart != null) {
    return `${filePath}::${cteName}@${lineStart}#variable`;
  }
  return `${filePath}::${cteName}#variable`;
}

export function sqlFileUnitSymbolId(filePath: string): string {
  return `${filePath}::__sql#module`;
}

export function relationRefConfidence(text: string): SqlRelationConfidence {
  if (text.includes('__tpl_') || text.includes('{{')) return 'template-dependent';
  if (/^[a-zA-Z_][\w.]*$/.test(text)) return 'deterministic';
  return 'heuristic';
}

export function mapRelationRefs(refs: ExtractedRelationRef[]): SqlRelationRefMeta[] {
  const seen = new Set<string>();
  const out: SqlRelationRefMeta[] = [];
  for (const r of refs) {
    const key = `${r.lineStart}:${r.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      text: r.text,
      lineStart: r.lineStart,
      confidence: relationRefConfidence(r.text),
    });
  }
  return out;
}

export function buildCteSymbolMetadata(cte: ExtractedCte): SqlCteSymbolMetadata {
  return {
    sqlKind: 'cte',
    name: cte.name,
    lineStart: cte.lineStart,
    lineEnd: cte.lineEnd,
    referencesCtes: cte.referencesCtes,
    defIndex: cte.defIndex,
  };
}

export function buildSqlFileUnitMetadata(): SqlFileUnitMetadata {
  return { sqlKind: 'file' };
}

export function buildSqlFileSymbolMetadata(
  spike: SqlSpikeParseResult,
  opts?: { extractor?: SqlFileSymbolMetadata['extractor']; notes?: string },
): SqlFileSymbolMetadata {
  return {
    dialect: 'postgresql',
    parseStatus: spike.status,
    hasError: spike.hasError,
    extractor: opts?.extractor ?? 'tree-sitter-sql',
    preprocessorApplied: [...SQL_PREPROCESSOR_PIPELINE],
    templates: spike.preprocess.templates,
    bindParams: spike.preprocess.bindParams,
    formatSlots: spike.preprocess.formatSlots,
    cteCount: spike.ctes.length,
    relationRefs: mapRelationRefs(spike.relationRefs),
    aliases: [],
    notes: opts?.notes,
  };
}
