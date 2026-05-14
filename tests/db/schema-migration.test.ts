/**
 * Permanent guard for fresh-DB schema migrations.
 *
 * Confirms that a brand-new SQLite database initialised via
 * `initializeDatabase(':memory:')` ships with every table the rest of the
 * codebase relies on at v1.36.0:
 *
 *   - ranking_pins  (E10) — user-supplied PageRank weight overrides
 *   - pass_cache    (W1)  — TaskDag persistent idempotency cache
 *
 * If these tables ever disappear from the fresh-DB DDL the corresponding
 * tools (pin_file/pin_symbol/list_pins, SqliteTaskCache) silently degrade
 * to first-touch failures. This test fails loudly instead.
 *
 * Columns are pinned by name + presence — the exact SQL type is not asserted
 * so a future widening (REAL → NUMERIC etc.) does not break the test.
 */

import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTableNames, initializeDatabase } from '../../src/db/schema.js';

interface PragmaColumn {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

function tableInfo(db: Database.Database, table: string): PragmaColumn[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as PragmaColumn[];
}

describe('schema-migration (fresh DB at v1.36.0)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
  });

  it('SCHEMA_VERSION row is 28 in schema_meta', () => {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    expect(row).toBeDefined();
    expect(Number(row!.value)).toBe(28);
  });

  it('ranking_pins table exists with the expected columns and PK', () => {
    const tables = getTableNames(db);
    expect(tables).toContain('ranking_pins');

    const cols = tableInfo(db, 'ranking_pins');
    const byName = new Map(cols.map((c) => [c.name, c]));

    for (const expected of [
      'scope',
      'target_id',
      'weight',
      'expires_at',
      'created_by',
      'created_at',
    ]) {
      expect(byName.has(expected), `ranking_pins missing column: ${expected}`).toBe(true);
    }
    // Composite PK on (scope, target_id) — both columns must be marked pk > 0.
    expect(byName.get('scope')!.pk).toBeGreaterThan(0);
    expect(byName.get('target_id')!.pk).toBeGreaterThan(0);
  });

  it('pass_cache table exists with the expected columns and PK', () => {
    const tables = getTableNames(db);
    expect(tables).toContain('pass_cache');

    const cols = tableInfo(db, 'pass_cache');
    const byName = new Map(cols.map((c) => [c.name, c]));

    for (const expected of ['task_name', 'cache_key', 'value_json', 'created_at']) {
      expect(byName.has(expected), `pass_cache missing column: ${expected}`).toBe(true);
    }
    expect(byName.get('task_name')!.pk).toBeGreaterThan(0);
    expect(byName.get('cache_key')!.pk).toBeGreaterThan(0);
  });

  it('expected indexes for ranking_pins and pass_cache are present', () => {
    const idxRows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
      name: string;
    }[];
    const names = new Set(idxRows.map((r) => r.name));

    expect(names.has('idx_ranking_pins_expires')).toBe(true);
    expect(names.has('idx_pass_cache_created')).toBe(true);
  });

  it('core graph tables ship in the same fresh init (regression guard)', () => {
    const tables = getTableNames(db);
    // Smaller required set — the broader contract lives in schema.test.ts.
    // We re-check the ones an MCP daemon boot path needs immediately so a
    // partial DDL drop is caught here too.
    // Note: `decisions` is intentionally NOT in this list — it is created
    // lazily by DecisionStore (src/memory/decision-store.ts) the first time
    // a decision write happens, not by initializeDatabase.
    for (const required of [
      'files',
      'symbols',
      'edges',
      'schema_meta',
      'ranking_pins',
      'pass_cache',
    ]) {
      expect(tables, `Missing table on fresh DB: ${required}`).toContain(required);
    }
  });
});
