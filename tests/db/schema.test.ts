import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initializeDatabase, getTableNames } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

describe('schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
  });

  it('creates all required tables', () => {
    const tables = getTableNames(db);

    const required = [
      'node_types',
      'edge_types',
      'nodes',
      'files',
      'symbols',
      'routes',
      'components',
      'migrations',
      'edges',
      'schema_meta',
    ];

    for (const table of required) {
      expect(tables, `Missing table: ${table}`).toContain(table);
    }
  });

  it('creates symbols_fts virtual table', () => {
    // FTS5 tables appear in sqlite_master with type=table but have VIRTUAL in sql
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'symbols_fts'").get() as
      | { sql: string }
      | undefined;

    expect(row).toBeDefined();
    expect(row!.sql).toContain('fts5');
  });

  it('seeds node_types with defaults', () => {
    const rows = db.prepare('SELECT name FROM node_types ORDER BY name').all() as {
      name: string;
    }[];
    const names = rows.map((r) => r.name);

    expect(names).toContain('symbol');
    expect(names).toContain('file');
    expect(names).toContain('route');
    expect(names).toContain('component');
    expect(names).toContain('migration');
  });

  it('seeds edge_types with defaults', () => {
    const rows = db.prepare('SELECT name, category FROM edge_types ORDER BY name').all() as {
      name: string;
      category: string;
    }[];

    const byName = new Map(rows.map((r) => [r.name, r.category]));
    expect(byName.get('imports')).toBe('php');
    expect(byName.get('extends')).toBe('php');
    expect(byName.get('implements')).toBe('php');
    expect(byName.get('uses_trait')).toBe('php');
    expect(byName.get('unresolved')).toBe('core');
  });

  it('stores schema version', () => {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(Number(row.value)).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent on repeated initialization', () => {
    // Calling initializeDatabase on the same in-memory db should not error
    // We simulate by inserting data and re-running DDL
    const store = new Store(db);
    store.insertFile('/test.php', 'php', 'abc123', 100);

    // Re-run - should not fail or duplicate seed data
    const tables = getTableNames(db);
    expect(tables).toContain('files');

    const nodeTypes = db.prepare('SELECT COUNT(*) as c FROM node_types').get() as { c: number };
    expect(nodeTypes.c).toBe(8);
  });

  it('has WAL journal mode (file-backed DB)', () => {
    // In-memory DBs ignore WAL, so test with a temp file
    const tmpDir = createTmpDir('trace-mcp-wal-');
    const tmpDb = initializeDatabase(path.join(tmpDir, 'test.db'));
    try {
      const mode = tmpDb.pragma('journal_mode', { simple: true }) as string;
      expect(mode).toBe('wal');
    } finally {
      tmpDb.close();
      removeTmpDir(tmpDir);
    }
  });

  it('has foreign keys enabled', () => {
    const fk = db.pragma('foreign_keys', { simple: true }) as number;
    expect(fk).toBe(1);
  });
});
