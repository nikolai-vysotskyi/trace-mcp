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

import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTableNames, initializeDatabase } from '../../src/db/schema.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

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

  it('SCHEMA_VERSION row is 35 in schema_meta', () => {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    expect(row).toBeDefined();
    expect(Number(row!.value)).toBe(35);
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
    expect(names.has('idx_files_language')).toBe(true);
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

describe('edges_confidence_from_tier trigger — scip_resolved arm', () => {
  it('seeds confidence 1.0 for a scip_resolved edge on insert', async () => {
    const { Store } = await import('../../src/db/store.js');
    const db = initializeDatabase(':memory:');
    const store = new Store(db);

    const fileId = store.insertFile('src/t.ts', 'typescript', 'h', 10);
    const aId = store.insertSymbol(fileId, {
      symbolId: 'src/t.ts::a#function',
      name: 'a',
      kind: 'function',
      fqn: 'a',
      byteStart: 0,
      byteEnd: 1,
    });
    const bId = store.insertSymbol(fileId, {
      symbolId: 'src/t.ts::b#function',
      name: 'b',
      kind: 'function',
      fqn: 'b',
      byteStart: 2,
      byteEnd: 3,
    });
    const aNode = store.getNodeId('symbol', aId)!;
    const bNode = store.getNodeId('symbol', bId)!;

    const inserted = store.insertEdge(
      aNode,
      bNode,
      'references',
      true,
      undefined,
      false,
      'scip_resolved',
    );
    expect(inserted.isOk()).toBe(true);

    const edge = db
      .prepare('SELECT resolution_tier, confidence FROM edges WHERE source_node_id = ?')
      .get(aNode) as { resolution_tier: string; confidence: number };
    expect(edge.resolution_tier).toBe('scip_resolved');
    expect(edge.confidence).toBe(1.0);
  });
});

describe('migration 34 -> 35 (TRA-2282: idx_files_language)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir('migration-35-');
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('upgrades existing v34 database to v35 and creates idx_files_language', () => {
    const dbPath = path.join(tmpDir, 'test-v34.db');
    // Initialize DB then simulate v34 state
    const seedDb = initializeDatabase(dbPath);
    // Drop the v35 index and revert schema_meta / schema_migrations
    seedDb.exec('DROP INDEX IF EXISTS idx_files_language');
    seedDb.prepare("UPDATE schema_meta SET value = '34' WHERE key = 'schema_version'").run();
    seedDb.prepare('DELETE FROM schema_migrations WHERE version = 35').run();
    // Insert test files to verify rows remain valid and queryable
    seedDb
      .prepare(
        "INSERT INTO files (path, language, status, byte_length, content_hash, indexed_at) VALUES ('src/test.ts', 'typescript', 'ok', 123, 'hash1', '2026-10-09T00:00:00Z')",
      )
      .run();
    seedDb
      .prepare(
        "INSERT INTO files (path, language, status, byte_length, content_hash, indexed_at) VALUES ('src/test.py', 'python', 'ok', 456, 'hash2', '2026-10-09T00:00:00Z')",
      )
      .run();
    seedDb.close();

    // Verify v34 state before reopening with initializeDatabase
    const checkDb = new Database(dbPath);
    const v34Version = checkDb
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(v34Version.value).toBe('34');
    const idxBefore = checkDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_files_language'",
      )
      .get();
    expect(idxBefore).toBeUndefined();
    checkDb.close();

    // Now re-open with initializeDatabase — triggers migration 35
    const upgradedDb = initializeDatabase(dbPath);

    // Verify schema_version is now 35
    const v35Version = upgradedDb
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(v35Version.value).toBe('35');

    // Verify migration 35 is recorded in schema_migrations
    const migRow = upgradedDb
      .prepare('SELECT version FROM schema_migrations WHERE version = 35')
      .get() as { version: number } | undefined;
    expect(migRow).toBeDefined();
    expect(migRow!.version).toBe(35);

    // Verify idx_files_language index exists
    const idxAfter = upgradedDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_files_language'",
      )
      .get() as { name: string } | undefined;
    expect(idxAfter).toBeDefined();
    expect(idxAfter!.name).toBe('idx_files_language');

    // Verify existing rows are intact and can be queried via the new index
    const tsFiles = upgradedDb
      .prepare('SELECT path FROM files WHERE language = ?')
      .all('typescript') as { path: string }[];
    expect(tsFiles).toHaveLength(1);
    expect(tsFiles[0]?.path).toBe('src/test.ts');

    upgradedDb.close();
  });
});
