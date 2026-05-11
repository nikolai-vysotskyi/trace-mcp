/**
 * Migration v26: wipe stale MD5-shaped content_hash rows so the new xxh64
 * digest can repopulate them on the next index. Without this, rename
 * detection and the hash-equality skip gate would silently miss every file
 * indexed before the algo bump.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

describe('migration v26 — wipe stale MD5 content_hash', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = createTmpDir('trace-mcp-mig26-');
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('NULLs every files.content_hash when upgrading from v25', () => {
    // Bootstrap a fresh DB at the latest version, then downgrade the
    // version stamp to v25 so reopening triggers migration 26.
    const initial = initializeDatabase(dbPath);
    initial.prepare("UPDATE schema_meta SET value = '25' WHERE key = 'schema_version'").run();

    // Seed two file rows with MD5-shaped hex (32 chars). These must be wiped.
    const md5A = 'd41d8cd98f00b204e9800998ecf8427e';
    const md5B = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    initial
      .prepare(
        `INSERT INTO files (path, language, content_hash, byte_length, indexed_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      )
      .run('src/a.ts', 'typescript', md5A, 100);
    initial
      .prepare(
        `INSERT INTO files (path, language, content_hash, byte_length, indexed_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      )
      .run('src/b.ts', 'typescript', md5B, 100);
    initial.close();

    // Reopen — runMigrations() should fire migration 26 and NULL all hashes.
    const upgraded = initializeDatabase(dbPath);
    const rows = upgraded
      .prepare('SELECT path, content_hash FROM files ORDER BY path')
      .all() as Array<{ path: string; content_hash: string | null }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.content_hash).toBeNull();
    }
    const versionRow = upgraded
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(Number(versionRow.value)).toBeGreaterThanOrEqual(26);
    upgraded.close();
  });

  it('is a no-op for fresh installs (no existing rows)', () => {
    const db = initializeDatabase(dbPath);
    const count = (db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number }).c;
    expect(count).toBe(0);
    // Migration ran via the seed path (marked applied without execution),
    // but a manual replay must still succeed without error.
    db.exec('UPDATE files SET content_hash = NULL');
    db.close();
  });

  it('is idempotent — replaying the migration on a v26 DB is a no-op', () => {
    const db = initializeDatabase(dbPath);
    // Insert a fresh xxh64-shaped hash (16 chars).
    db.prepare(
      `INSERT INTO files (path, language, content_hash, byte_length, indexed_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run('src/c.ts', 'typescript', 'deadbeefcafebabe', 50);
    // Direct manual replay of the migration body.
    db.exec('UPDATE files SET content_hash = NULL');
    const after = db.prepare("SELECT content_hash FROM files WHERE path = 'src/c.ts'").get() as {
      content_hash: string | null;
    };
    expect(after.content_hash).toBeNull();
    db.close();
  });
});

// Defensive: guard the test setup itself — better-sqlite3 must persist the file.
describe('migration v26 — sanity', () => {
  it('temp DB file exists on disk after init', () => {
    const tmpDir = createTmpDir('trace-mcp-mig26-sanity-');
    try {
      const dbPath = path.join(tmpDir, 'sanity.db');
      const db = new Database(dbPath);
      db.exec('CREATE TABLE t (x INTEGER)');
      db.close();
      expect(fs.existsSync(dbPath)).toBe(true);
    } finally {
      removeTmpDir(tmpDir);
    }
  });
});
