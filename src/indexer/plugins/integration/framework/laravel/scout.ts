/**
 * laravel/scout extraction.
 *
 * Extracts:
 * - Models using Searchable trait → searchable model edges
 * - toSearchableArray() method → indexed fields
 * - searchableAs() method → custom index name
 * - Scout config (scout.php) — driver, index settings
 */
import type { RawEdge, RawSymbol } from '../../../../../plugin-api/types.js';

// ─── Interfaces ──────────────────────────────────────────────

export interface SearchableModelInfo {
  className: string;
  fqn: string;
  indexName: string | null;
  searchableFields: string[];
  shouldBeSearchable: boolean;
}

// ─── Detection ───────────────────────────────────────────────

const NAMESPACE_RE = /namespace\s+([\w\\]+)\s*;/;
const CLASS_NAME_RE = /class\s+(\w+)/;
const SEARCHABLE_RE = /use\s+(?:[\w\\]*\\)?Searchable\b/;

// ─── Model extraction ────────────────────────────────────────

/**
 * Extract Searchable trait usage and search config from a model class.
 */
export function extractSearchableModel(
  source: string,
  _filePath: string,
): SearchableModelInfo | null {
  if (!SEARCHABLE_RE.test(source)) return null;
  if (!/class\s+\w+/.test(source)) return null;

  const nsMatch = source.match(NAMESPACE_RE);
  const namespace = nsMatch?.[1] ?? '';
  const classMatch = source.match(CLASS_NAME_RE);
  if (!classMatch) return null;
  const className = classMatch[1];
  const fqn = namespace ? `${namespace}\\${className}` : className;

  const indexName = extractIndexName(source);
  const searchableFields = extractSearchableFields(source);
  const shouldBeSearchable = source.includes('shouldBeSearchable');

  return { className, fqn, indexName, searchableFields, shouldBeSearchable };
}

// ─── Edge builders ───────────────────────────────────────────

export function buildSearchableModelEdges(info: SearchableModelInfo): RawEdge[] {
  const edges: RawEdge[] = [];

  edges.push({
    edgeType: 'scout_searchable',
    metadata: {
      modelFqn: info.fqn,
      indexName: info.indexName,
      fields: info.searchableFields,
    },
  });

  return edges;
}

export function buildSearchableModelSymbols(info: SearchableModelInfo): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  if (info.searchableFields.length > 0) {
    symbols.push({
      name: `${info.className}::searchableIndex`,
      kind: 'variable',
      signature: `index ${info.indexName ?? info.className.toLowerCase()} [${info.searchableFields.join(', ')}]`,
      metadata: {
        frameworkRole: 'scout_index',
        modelFqn: info.fqn,
        indexName: info.indexName,
        fields: info.searchableFields,
      },
    });
  }

  return symbols;
}

// ─── Internal helpers ────────────────────────────────────────

/**
 * Extract custom index name from searchableAs() method.
 */
function extractIndexName(source: string): string | null {
  const re = /function\s+searchableAs\s*\(\s*\)[\s\S]*?return\s+['"]([^'"]+)['"]/;
  return source.match(re)?.[1] ?? null;
}

/**
 * Extract fields from toSearchableArray() method.
 */
function extractSearchableFields(source: string): string[] {
  const fields: string[] = [];

  // Match toSearchableArray() => ['field' => ...] pattern
  const methodRe = /function\s+toSearchableArray\s*\(\s*\)[\s\S]*?\{([\s\S]*?)\n\s{4}\}/;
  const methodMatch = source.match(methodRe);
  if (!methodMatch) return fields;

  const body = methodMatch[1];

  // Extract array keys: 'fieldName' =>
  const keyRe = /['"](\w+)['"]\s*=>/g;
  let match: RegExpExecArray | null;
  while ((match = keyRe.exec(body)) !== null) {
    fields.push(match[1]);
  }

  return fields;
}
