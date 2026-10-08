/**
 * Phase 2: make repository SQL parseable by tree-sitter-sql without
 * resolving templates to real schema names.
 */

import { SqlPositionMap, SqlSourceMapBuilder } from './sql-source-map.js';

export interface SqlTemplateSlot {
  name: string;
  placeholder: string;
  original: string;
}

export interface SqlFormatSlot {
  name: string;
  placeholder: string;
  original: string;
}

export interface SqlPreprocessResult {
  source: string;
  templates: SqlTemplateSlot[];
  bindParams: string[];
  formatSlots: SqlFormatSlot[];
  positionMap: SqlPositionMap;
}

const TEMPLATE_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
const FORMAT_BRACE_RE = /(?<!\{)\{([a-z][a-z0-9_]*)\}(?!\})/g;
const BIND_PARAM_RE = /(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g;
const CHAINED_AT_TZ_RE =
  /\(\s*([^()]+?)\s+AT\s+TIME\s+ZONE\s+'[^']*'\s*\)\s+AT\s+TIME\s+ZONE\s+'[^']*'/gi;
const AT_TZ_RE = /\s+AT\s+TIME\s+ZONE\s+'[^']*'/gi;
const DISTINCT_ON_SPLIT_RE = /\bDISTINCT(?:\s*\n\s*|\s+)ON\s*\(/gi;
const MATERIALIZED_CTE_RE = /\bAS\s+MATERIALIZED\s*\(/gi;

export function normalizePgDistinctOn(builder: SqlSourceMapBuilder): void {
  builder.replaceAll(
    DISTINCT_ON_SPLIT_RE,
    () => 'DISTINCT ON (',
    (s) => s,
  );
}

export function normalizePgMaterializedCte(builder: SqlSourceMapBuilder): void {
  builder.replaceAll(
    MATERIALIZED_CTE_RE,
    () => 'AS (',
    (s) => s,
  );
}

export function normalizePgIlike(builder: SqlSourceMapBuilder): void {
  builder.replaceAll(
    /\bILIKE\b/gi,
    () => 'LIKE',
    (s) => s,
  );
}

export function normalizePgAtTimeZone(builder: SqlSourceMapBuilder): void {
  let guard = 0;
  while (guard < 32) {
    guard++;
    const before = builder.text;
    builder.replaceAll(
      CHAINED_AT_TZ_RE,
      (_m, inner: string) => `(${inner})`,
      (s) => s,
    );
    if (builder.text === before) break;
  }
  builder.replaceAll(
    AT_TZ_RE,
    () => '',
    (s) => s,
  );
}

function applyTemplateMustache(builder: SqlSourceMapBuilder, templates: SqlTemplateSlot[]): void {
  builder.replaceAll(
    TEMPLATE_RE,
    (_tok, name: string) => {
      const placeholder = `__tpl_${name.toLowerCase()}__`;
      templates.push({ name, placeholder, original: _tok });
      return placeholder;
    },
    (s) => s,
  );
}

function applyFormatBraces(builder: SqlSourceMapBuilder, formatSlots: SqlFormatSlot[]): void {
  builder.replaceAll(
    FORMAT_BRACE_RE,
    (originalToken, name: string) => {
      const placeholder = `/* __fmt_${name}__ */`;
      formatSlots.push({ name, placeholder, original: originalToken });
      return placeholder;
    },
    (s) => s,
  );
}

function applyBindParams(builder: SqlSourceMapBuilder, bindParams: string[]): void {
  builder.replaceAll(
    BIND_PARAM_RE,
    (full, name: string) => {
      if (!bindParams.includes(name)) bindParams.push(name);
      return `__bind_${name}__`;
    },
    (s) => s,
  );
}

export function preprocessSqlForParse(original: string): SqlPreprocessResult {
  const templates: SqlTemplateSlot[] = [];
  const formatSlots: SqlFormatSlot[] = [];
  const bindParams: string[] = [];
  const builder = new SqlSourceMapBuilder(original);

  applyTemplateMustache(builder, templates);
  applyFormatBraces(builder, formatSlots);
  applyBindParams(builder, bindParams);
  normalizePgDistinctOn(builder);
  normalizePgMaterializedCte(builder);
  normalizePgIlike(builder);
  normalizePgAtTimeZone(builder);

  const positionMap = builder.finish();
  return {
    source: positionMap.preprocessed,
    templates,
    bindParams,
    formatSlots,
    positionMap,
  };
}
