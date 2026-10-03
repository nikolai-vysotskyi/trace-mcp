/**
 * Phase 2: make repository SQL parseable by tree-sitter-sql without
 * resolving templates to real schema names.
 */

export interface SqlTemplateSlot {
  /** Inner name inside `{{NAME}}`. */
  name: string;
  /** Parser-safe identifier substituted in source. */
  placeholder: string;
  /** Original token, e.g. `{{SCHEMA_NAME}}`. */
  original: string;
}

/** Python `str.format` / `.format_map` slot inside SQL text, e.g. `{pool_date_filter}`. */
export interface SqlFormatSlot {
  name: string;
  placeholder: string;
  original: string;
}

export interface SqlPreprocessResult {
  /** Source passed to the SQL parser. */
  source: string;
  templates: SqlTemplateSlot[];
  /** Bind parameter names without leading `:`. */
  bindParams: string[];
  /** Inlined format fragments (not `{{mustache}}` templates). */
  formatSlots: SqlFormatSlot[];
}

const TEMPLATE_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
/** Lowercase snake_case slots used by Python `.format()` on SQL files. Not `{{NAME}}`. */
const FORMAT_BRACE_RE = /(?<!\{)\{([a-z][a-z0-9_]*)\}(?!\})/g;
const BIND_PARAM_RE = /(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g;
/** Chained PG: `(expr AT TIME ZONE 'a') AT TIME ZONE 'b'` — not in tree-sitter-sql. */
const CHAINED_AT_TZ_RE =
  /\(\s*([^()]+?)\s+AT\s+TIME\s+ZONE\s+'[^']*'\s*\)\s+AT\s+TIME\s+ZONE\s+'[^']*'/gi;
const AT_TZ_RE = /\s+AT\s+TIME\s+ZONE\s+'[^']*'/gi;
/** PG allows `SELECT DISTINCT\n  ON (cols)` — tree-sitter-sql expects `DISTINCT ON` on one token run. */
const DISTINCT_ON_SPLIT_RE = /\bDISTINCT(?:\s*\n\s*|\s+)ON\s*\(/gi;
const MATERIALIZED_CTE_RE = /\bAS\s+MATERIALIZED\s*\(/gi;
const PG_CAST_IDENT_RE = /([a-zA-Z_][\w.]*)\s*::\s*([a-zA-Z_][a-zA-Z0-9_]*)/g;
const PG_CAST_PAREN_RE = /\(([^()]+)\)\s*::\s*([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * Strip / fold `AT TIME ZONE` for parse-only indexing. Does not change stored SQL.
 */
export function normalizePgDistinctOn(source: string): string {
  return source.replace(DISTINCT_ON_SPLIT_RE, 'DISTINCT ON (');
}

/** `WITH x AS MATERIALIZED (` → `AS (` for parsers without PG materialized CTE keyword. */
export function normalizePgMaterializedCte(source: string): string {
  return source.replace(MATERIALIZED_CTE_RE, 'AS (');
}

/** PostgreSQL postfix casts — tree-sitter-sql handles `CAST(x AS t)` more reliably than `x::t`. */
export function normalizePgDoubleColonCast(source: string): string {
  let s = source;
  let prev = '';
  let guard = 0;
  while (s !== prev && guard < 32) {
    prev = s;
    s = s
      .replace(PG_CAST_PAREN_RE, (_m, expr: string, typ: string) => `CAST((${expr}) AS ${typ})`)
      .replace(PG_CAST_IDENT_RE, (_m, expr: string, typ: string) => `CAST(${expr} AS ${typ})`);
    guard++;
  }
  return s;
}

export function normalizePgIlike(source: string): string {
  return source.replace(/\bILIKE\b/gi, 'LIKE');
}

export function normalizePgAtTimeZone(source: string): string {
  let s = source;
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(CHAINED_AT_TZ_RE, '($1)');
  }
  return s.replace(AT_TZ_RE, '');
}

/**
 * Replace `{name}` format slots with a parse-safe block comment (indexing only).
 */
export function normalizePythonFormatBraces(source: string): {
  source: string;
  formatSlots: SqlFormatSlot[];
} {
  const formatSlots: SqlFormatSlot[] = [];
  const out = source.replace(FORMAT_BRACE_RE, (originalToken, name: string) => {
    const placeholder = `/* __fmt_${name}__ */`;
    formatSlots.push({ name, placeholder, original: originalToken });
    return placeholder;
  });
  return { source: out, formatSlots };
}

export function preprocessSqlForParse(original: string): SqlPreprocessResult {
  const templates: SqlTemplateSlot[] = [];
  let source = original.replace(TEMPLATE_RE, (originalToken, name: string) => {
    const placeholder = `__tpl_${name.toLowerCase()}__`;
    templates.push({ name, placeholder, original: originalToken });
    return placeholder;
  });

  const { source: afterFormat, formatSlots } = normalizePythonFormatBraces(source);
  source = afterFormat;

  const bindParams: string[] = [];
  source = source.replace(BIND_PARAM_RE, (full, name: string) => {
    if (!bindParams.includes(name)) bindParams.push(name);
    return `__bind_${name}__`;
  });

  source = normalizePgDistinctOn(source);
  source = normalizePgMaterializedCte(source);
  // Postfix `::` casts: available via normalizePgDoubleColonCast for experiments;
  // not enabled globally — corpus ok count drops (~196→~185) with little partial relief.
  source = normalizePgIlike(source);
  source = normalizePgAtTimeZone(source);

  return { source, templates, bindParams, formatSlots };
}
