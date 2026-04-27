/**
 * spatie/eloquent-sortable extraction.
 *
 * Detects:
 * - Models using SortableTrait / Sortable trait
 * - Models implementing Sortable interface
 * - $sortable property with order_column_name / sort_when_creating
 */
import type { RawSymbol } from '../../../../../plugin-api/types.js';

// ─── Interfaces ──────────────────────────────────────────────

export interface EloquentSortableModelInfo {
  className: string;
  fqn: string;
  orderColumn: string | null;
  sortWhenCreating: boolean;
}

// ─── Detection ───────────────────────────────────────────────

const NAMESPACE_RE = /namespace\s+([\w\\]+)\s*;/;
const CLASS_NAME_RE = /class\s+(\w+)/;
const SORTABLE_TRAIT_RE = /use\s+(?:[\w\\]*\\)?SortableTrait\b/;
const SORTABLE_INTERFACE_RE = /implements\s+[^\{]*?\bSortable\b/;
const ORDER_COLUMN_RE = /['"]order_column_name['"]\s*=>\s*['"]([^'"]+)['"]/;
const SORT_WHEN_CREATING_RE = /['"]sort_when_creating['"]\s*=>\s*(true|false)/;

// ─── Model extraction ────────────────────────────────────────

/**
 * Extract eloquent-sortable usage: SortableTrait + Sortable interface + $sortable config.
 */
export function extractEloquentSortableModel(
  source: string,
  _filePath: string,
): EloquentSortableModelInfo | null {
  const usesTrait = SORTABLE_TRAIT_RE.test(source);
  const hasInterface = SORTABLE_INTERFACE_RE.test(source);
  if (!usesTrait && !hasInterface) return null;
  if (!/class\s+\w+/.test(source)) return null;

  const nsMatch = source.match(NAMESPACE_RE);
  const namespace = nsMatch?.[1] ?? '';
  const classMatch = source.match(CLASS_NAME_RE);
  if (!classMatch) return null;
  const className = classMatch[1];
  const fqn = namespace ? `${namespace}\\${className}` : className;

  const orderColumn = source.match(ORDER_COLUMN_RE)?.[1] ?? null;
  const sortWhenMatch = source.match(SORT_WHEN_CREATING_RE);
  const sortWhenCreating = sortWhenMatch ? sortWhenMatch[1] === 'true' : false;

  return { className, fqn, orderColumn, sortWhenCreating };
}

// ─── Symbol builders ─────────────────────────────────────────

export function buildEloquentSortableModelSymbols(info: EloquentSortableModelInfo): RawSymbol[] {
  return [
    {
      name: `${info.className}::sortable`,
      kind: 'variable',
      signature: `sortable order_by=${info.orderColumn ?? 'order_column'}${info.sortWhenCreating ? ' sort_on_create' : ''}`,
      metadata: {
        frameworkRole: 'eloquent_sortable',
        modelFqn: info.fqn,
        orderColumn: info.orderColumn,
        sortWhenCreating: info.sortWhenCreating,
      },
    },
  ];
}
