/**
 * Materialized class-hierarchy lookup (TRA-2002).
 *
 * `findImplementors` used to locate subclasses/implementors with a
 * leading-wildcard scan over symbol metadata:
 *
 *   json_extract(s.metadata, '$.implements') LIKE '%"Foo"%'
 *
 * which SQLite cannot serve from any index — every call walked every symbol
 * row's metadata blob. In production this blocked the event loop for 41s and
 * tripped the `get_call_graph` compute budget (via CHA's collectDescendants).
 *
 * `symbol_heritage` materializes one row per (symbol, parent-name) heritage
 * edge at write time, so the lookup becomes an indexed equality seek on
 * `parent_name`. Rows are maintained by `SymbolRepository.insertSymbol` (the
 * single funnel for all live-DB symbol writes) and backfilled for upgraded
 * DBs by migration 34 (see schema.ts).
 */

import type Database from 'better-sqlite3';

export type HeritageKind = 'extends' | 'implements' | 'bases';

export interface HeritageEntry {
  parentName: string;
  kind: HeritageKind;
}

function pushNames(out: HeritageEntry[], value: unknown, kind: HeritageKind): void {
  if (typeof value === 'string') {
    if (value.length > 0) out.push({ parentName: value, kind });
  } else if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string' && v.length > 0) out.push({ parentName: v, kind });
    }
  }
}

/**
 * Extract heritage edges from a symbol's metadata object (already parsed —
 * callers pass the pre-stringify value so this never re-parses JSON).
 *
 * Shapes per language plugin:
 * - TypeScript: `extends: string`, `implements: string[]`
 * - PHP: `extends: string[]`, `implements: string[]`
 * - Python: `bases: string[]`
 */
export function extractHeritageEntries(metadata: unknown): HeritageEntry[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const meta = metadata as Record<string, unknown>;
  const out: HeritageEntry[] = [];
  pushNames(out, meta.extends, 'extends');
  pushNames(out, meta.implements, 'implements');
  pushNames(out, meta.bases, 'bases');
  return out;
}

/** Parse a stored metadata JSON blob leniently — malformed rows backfill as empty. */
function extractFromStoredJson(stored: string | null): HeritageEntry[] {
  if (!stored) return [];
  try {
    return extractHeritageEntries(JSON.parse(stored) as unknown);
  } catch {
    return [];
  }
}

/**
 * Backfill `symbol_heritage` from existing symbol rows. Used by migration 34
 * and covered directly by tests/db/symbol-heritage.test.ts (raw-SQL seeds
 * bypass the repository write path, exercising exactly this function).
 */
export function backfillSymbolHeritage(db: Database.Database): number {
  const rows = db
    .prepare(
      `SELECT id, metadata FROM symbols
        WHERE metadata IS NOT NULL
          AND (json_extract(metadata, '$.extends') IS NOT NULL
            OR json_extract(metadata, '$.implements') IS NOT NULL
            OR json_extract(metadata, '$.bases') IS NOT NULL)`,
    )
    .all() as { id: number; metadata: string | null }[];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO symbol_heritage (symbol_id, parent_name, kind)
     VALUES (?, ?, ?)`,
  );
  let count = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      for (const e of extractFromStoredJson(row.metadata)) {
        insert.run(row.id, e.parentName, e.kind);
        count++;
      }
    }
  });
  tx();
  return count;
}
