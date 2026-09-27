/**
 * Regression guard for TRA-2002: `findImplementors` (used by
 * `get_type_hierarchy`, `get_implementations`, and CHA expansion inside
 * `get_call_graph`) ran a leading-wildcard scan over symbol metadata:
 *
 *   json_extract(s.metadata, '$.implements') LIKE '%"Foo"%'
 *
 * which SQLite cannot serve from any index — in production it blocked the
 * event loop for 41s, tripped the `get_call_graph` compute budget, and
 * knocked 33 sessions into local fallback. These checks deliberately don't
 * run ANALYZE (matching the daemon condition at index time) and pin:
 *
 * 1. the query plan seeks `idx_symbol_heritage_parent` (no bare symbols scan),
 * 2. write-path sync keeps `symbol_heritage` in step with symbol writes,
 *    including upserts that remove heritage (no stale rows),
 * 3. the migration-34 backfill recovers rows written before the table existed
 *    and skips corrupt metadata blobs instead of aborting the migration.
 */

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backfillSymbolHeritage } from '../../src/db/heritage.js';
import { FIND_IMPLEMENTORS_SQL } from '../../src/db/repositories/symbol-repository.js';
import { initializeDatabase } from '../../src/db/schema.js';
import type { Store } from '../../src/db/store.js';
import { createTestStore } from '../test-utils.js';

function planLines(db: Database.Database): string[] {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${FIND_IMPLEMENTORS_SQL}`).all('Base') as Array<{
    detail: string;
  }>;
  return plan.map((p) => p.detail);
}

function heritageRows(db: Database.Database): { symbol_id: number; parent_name: string }[] {
  return db
    .prepare('SELECT symbol_id, parent_name FROM symbol_heritage ORDER BY symbol_id, parent_name')
    .all() as { symbol_id: number; parent_name: string }[];
}

describe('symbol_heritage (TRA-2002)', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  afterEach(() => {
    store.db.close();
  });

  it('fresh DB ships the symbol_heritage table at schema version 34', () => {
    const version = store.getRepoMetadata('no-such-key'); // touch store; version read below
    expect(version).toBeNull();
    const row = store.db
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(row.value).toBe('34');
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'symbol_heritage'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
    const idx = store.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_symbol_heritage_parent'",
      )
      .all() as { name: string }[];
    expect(idx).toHaveLength(1);
  });

  it('findImplementors seeks the heritage index instead of scanning symbols', () => {
    const lines = planLines(store.db);
    expect(lines.join(' | ')).toContain('idx_symbol_heritage_parent');
    expect(lines.some((l) => /^SCAN s$/.test(l))).toBe(false);
  });

  it('write path materializes extends (string + array) and implements (array + scalar)', () => {
    const fileId = store.insertFile('src/h.ts', 'typescript', null, null);
    const insert = (name: string, metadata?: Record<string, unknown>) =>
      store.insertSymbol(fileId, {
        symbolId: `src/h.ts::${name}#class`,
        name,
        kind: 'class' as never,
        byteStart: 0,
        byteEnd: 10,
        metadata,
      });

    insert('TsChild', { extends: 'Base' });
    insert('PhpChild', { extends: ['Base'], implements: ['IBase'] });
    insert('ScalarImpl', { implements: 'IBase' });
    insert('Unrelated', { extends: 'Other' });
    insert('Plain');

    expect(
      store
        .findImplementors('Base')
        .map((r) => r.name)
        .sort(),
    ).toEqual(['PhpChild', 'TsChild']);
    expect(
      store
        .findImplementors('IBase')
        .map((r) => r.name)
        .sort(),
    ).toEqual(['PhpChild', 'ScalarImpl']);
    expect(store.findImplementors('Nope')).toHaveLength(0);
    expect(heritageRows(store.db)).toHaveLength(5); // 1 + 2 + 1 + 1 + 0
  });

  it('python bases are deliberately not materialized (parity with the old LIKE query)', () => {
    // TRA-2002 review: serving `bases` through CHA fans get_call_graph output
    // out ~16x on wide hierarchies — deferred to a separate budgeted PR.
    const fileId = store.insertFile('src/h.py', 'python', null, null);
    store.insertSymbol(fileId, {
      symbolId: 'src/h.py::PyChild#class',
      name: 'PyChild',
      kind: 'class' as never,
      byteStart: 0,
      byteEnd: 10,
      metadata: { bases: ['Base'] },
    });
    expect(store.findImplementors('Base')).toHaveLength(0);
    expect(heritageRows(store.db)).toHaveLength(0);
  });

  it('upsert that removes heritage clears stale rows', () => {
    const fileId = store.insertFile('src/u.ts', 'typescript', null, null);
    const sym = {
      symbolId: 'src/u.ts::U#class',
      name: 'U',
      kind: 'class' as never,
      byteStart: 0,
      byteEnd: 10,
    };
    store.insertSymbol(fileId, { ...sym, metadata: { extends: 'Base' } });
    expect(store.findImplementors('Base')).toHaveLength(1);
    // Same symbol_id re-indexed without heritage (ON CONFLICT DO UPDATE branch).
    store.insertSymbol(fileId, { ...sym });
    expect(store.findImplementors('Base')).toHaveLength(0);
    expect(heritageRows(store.db)).toHaveLength(0);
  });

  it('deleting a file cascades its heritage rows', () => {
    const fileId = store.insertFile('src/d.ts', 'typescript', null, null);
    store.insertSymbol(fileId, {
      symbolId: 'src/d.ts::D#class',
      name: 'D',
      kind: 'class' as never,
      byteStart: 0,
      byteEnd: 10,
      metadata: { implements: ['IBase'] },
    });
    expect(store.findImplementors('IBase')).toHaveLength(1);
    store.deleteSymbolsByFile(fileId);
    expect(store.findImplementors('IBase')).toHaveLength(0);
    expect(heritageRows(store.db)).toHaveLength(0);
  });

  it('backfill recovers heritage written before the table existed', () => {
    const db = initializeDatabase(':memory:');
    try {
      const fileId = db
        .prepare(`INSERT INTO files (path, language, indexed_at) VALUES (?, ?, ?) RETURNING id`)
        .get('src/raw.ts', 'typescript', new Date().toISOString()) as { id: number };
      // Raw SQL bypasses SymbolRepository.syncHeritage — exactly the
      // pre-migration-34 shape.
      const raw = db.prepare(
        `INSERT INTO symbols (file_id, symbol_id, name, kind, byte_start, byte_end, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      raw.run(
        fileId.id,
        'src/raw.ts::R1#class',
        'R1',
        'class',
        0,
        10,
        JSON.stringify({ extends: 'Base' }),
      );
      raw.run(
        fileId.id,
        'src/raw.ts::R2#class',
        'R2',
        'class',
        0,
        10,
        JSON.stringify({ implements: ['IBase'], extends: ['Base'] }),
      );
      raw.run(fileId.id, 'src/raw.ts::R3#class', 'R3', 'class', 0, 10, null);
      // A corrupt blob (legacy/hand-edited DBs predate the json_valid guard).
      // The expression indexes on symbols() evaluate json_extract at INSERT
      // time and would reject this row first, so plant it the way such a row
      // can only exist — written before those indexes did. The backfill must
      // skip it, not abort the migration (TRA-2002 review item 1).
      db.exec(`DROP INDEX idx_symbols_has_heritage;
        DROP INDEX idx_symbols_exported;
        DROP INDEX idx_symbols_call_sites;
        DROP INDEX idx_symbols_type_refs;
        DROP INDEX idx_symbols_bases;`);
      raw.run(fileId.id, 'src/raw.ts::R4#class', 'R4', 'class', 0, 10, '{extends: "Base", ');
      expect(heritageRows(db)).toHaveLength(0);

      expect(backfillSymbolHeritage(db)).toBe(3);
      expect(heritageRows(db)).toHaveLength(3);
      const found = db.prepare(FIND_IMPLEMENTORS_SQL).all('Base') as { name: string }[];
      expect(found.map((r) => r.name).sort()).toEqual(['R1', 'R2']);
      // The corrupt row survives untouched and stays invisible.
      const corrupt = db.prepare('SELECT metadata FROM symbols WHERE name = ?').get('R4') as {
        metadata: string;
      };
      expect(corrupt.metadata).toBe('{extends: "Base", ');
    } finally {
      db.close();
    }
  });
});
