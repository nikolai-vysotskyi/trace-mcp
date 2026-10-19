import type { TraceMcpResult } from '../../../../errors.js';
import type { FileParseResult } from '../../../../plugin-api/types.js';
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { SymbolPattern } from '../regex-base.js';

/** v3.34.6 regex patterns for standalone `.sql` files (fallback path). */
export const SQL_SYMBOL_PATTERNS: SymbolPattern[] = [
  {
    kind: 'class',
    pattern:
      /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-zA-Z_]\w*\.)?([a-zA-Z_]\w*)/gim,
    meta: { sqlKind: 'table' },
  },
  {
    kind: 'class',
    pattern:
      /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-zA-Z_]\w*\.)?([a-zA-Z_]\w*)/gim,
    meta: { sqlKind: 'view' },
  },
  {
    kind: 'function',
    pattern:
      /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-zA-Z_]\w*\.)?([a-zA-Z_]\w*)/gim,
    meta: { sqlKind: 'function' },
  },
  {
    kind: 'function',
    pattern:
      /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-zA-Z_]\w*\.)?([a-zA-Z_]\w*)/gim,
    meta: { sqlKind: 'procedure' },
  },
  {
    kind: 'variable',
    pattern:
      /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:CONCURRENTLY\s+)?([a-zA-Z_]\w*)/gim,
    meta: { sqlKind: 'index' },
  },
  {
    kind: 'namespace',
    pattern: /^\s*CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_]\w*)/gim,
    meta: { sqlKind: 'schema' },
  },
  {
    kind: 'function',
    pattern:
      /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_]\w*)/gim,
    meta: { sqlKind: 'trigger' },
  },
  {
    kind: 'type',
    pattern:
      /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TYPE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-zA-Z_]\w*\.)?([a-zA-Z_]\w*)/gim,
    meta: { sqlKind: 'type' },
  },
  {
    kind: 'variable',
    pattern: /\bWITH\s+(?:RECURSIVE\s+)?([a-zA-Z_]\w*)\s+AS\s*\(/gim,
    meta: { sqlKind: 'cte' },
  },
  {
    kind: 'class',
    pattern:
      /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-zA-Z_]\w*\.)?([a-zA-Z_]\w*)/gim,
    meta: { sqlKind: 'temp_table' },
  },
];

export const SQL_DDL_SYMBOL_PATTERNS = SQL_SYMBOL_PATTERNS.filter(
  (p) => (p.meta as { sqlKind?: string })?.sqlKind !== 'cte',
);

const _regexPlugin = createRegexLanguagePlugin({
  name: 'sql',
  language: 'sql',
  extensions: ['.sql'],
  symbolPatterns: SQL_SYMBOL_PATTERNS,
});

const _ddlOnlyPlugin = createRegexLanguagePlugin({
  name: 'sql-ddl',
  language: 'sql',
  extensions: ['.sql'],
  symbolPatterns: SQL_DDL_SYMBOL_PATTERNS,
});

/** Full v3.34.6 regex extraction (first-CTE-only among WITH matches). */
export function extractSqlSymbolsRegex(
  filePath: string,
  content: Buffer,
): TraceMcpResult<FileParseResult> {
  return _regexPlugin.extractSymbols(filePath, content) as TraceMcpResult<FileParseResult>;
}

export function extractSqlDdlSymbolsRegex(
  filePath: string,
  content: Buffer,
): TraceMcpResult<FileParseResult> {
  return _ddlOnlyPlugin.extractSymbols(filePath, content) as TraceMcpResult<FileParseResult>;
}
