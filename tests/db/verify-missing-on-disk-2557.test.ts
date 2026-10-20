/**
 * TRA-2557: Tests for missing_on_disk verification probe in verifyIndex().
 *
 * Checks that indexed files in the SQLite database exist on disk under options.root,
 * ignoring synthetic files (__external__/*). Reports status 'warn' with suggested_repair
 * 'reindex --force' when files are missing on disk.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyIndex } from '../../src/db/verify.js';

function bootstrapFilesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);
    CREATE TABLE symbols (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name TEXT,
      fqn TEXT,
      signature TEXT,
      summary TEXT
    );
    CREATE TABLE nodes (id INTEGER PRIMARY KEY, kind TEXT, ref_id INTEGER);
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY,
      source_node_id INTEGER NOT NULL,
      target_node_id INTEGER NOT NULL,
      edge_type_id INTEGER NOT NULL
    );
    CREATE TABLE edge_types (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE VIRTUAL TABLE symbols_fts USING fts5(name, fqn, signature, summary, content='symbols', content_rowid='id');
    CREATE VIRTUAL TABLE symbols_name_tri USING fts5(name, content='symbols', content_rowid='id', tokenize='trigram');
  `);
}

describe('verifyIndex — missing_on_disk check (TRA-2557)', () => {
  let tempDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-verify-'));
    db = new Database(':memory:');
    bootstrapFilesTable(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('skips missing_on_disk probe when root is omitted', () => {
    db.prepare('INSERT INTO files (id, path) VALUES (?, ?)').run(1, 'src/missing.ts');
    const report = verifyIndex(db);
    const check = report.checks.find((c) => c.name === 'missing_on_disk');
    expect(check).toBeUndefined();
  });

  it('reports ok when all indexed files exist on disk and ignores synthetic files', () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'a.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(tempDir, 'src', 'b.ts'), 'export const b = 2;');

    db.prepare('INSERT INTO files (id, path) VALUES (?, ?)').run(1, 'src/a.ts');
    db.prepare('INSERT INTO files (id, path) VALUES (?, ?)').run(2, 'src/b.ts');
    // Synthetic file that doesn't exist on disk:
    db.prepare('INSERT INTO files (id, path) VALUES (?, ?)').run(
      3,
      '__external__/_root/typescript.synthetic',
    );

    const report = verifyIndex(db, { root: tempDir });
    const check = report.checks.find((c) => c.name === 'missing_on_disk');
    expect(check).toBeDefined();
    expect(check?.status).toBe('ok');
    expect(check?.detail).toContain('All 2 indexed files exist on disk');
    expect(check?.suggested_repair).toBeUndefined();
    expect(report.ok).toBe(true);
  });

  it('reports warn and suggested_repair "reindex --force" when indexed files are missing on disk', () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'existing.ts'), 'export const a = 1;');

    db.prepare('INSERT INTO files (id, path) VALUES (?, ?)').run(1, 'src/existing.ts');
    db.prepare('INSERT INTO files (id, path) VALUES (?, ?)').run(2, 'src/deleted1.ts');
    db.prepare('INSERT INTO files (id, path) VALUES (?, ?)').run(3, 'src/deleted2.ts');
    // Synthetic file should still be ignored
    db.prepare('INSERT INTO files (id, path) VALUES (?, ?)').run(
      4,
      '__external__/_root/typescript.synthetic',
    );

    const report = verifyIndex(db, { root: tempDir });
    expect(report.ok).toBe(false);
    expect(report.status).toBe('warn');

    const check = report.checks.find((c) => c.name === 'missing_on_disk');
    expect(check).toBeDefined();
    expect(check?.status).toBe('warn');
    expect(check?.count).toBe(2);
    expect(check?.suggested_repair).toBe('reindex --force');
    expect(check?.detail).toContain('2 indexed file(s) missing on disk');
    expect(check?.detail).toContain('src/deleted1.ts');
    expect(check?.detail).toContain('src/deleted2.ts');
  });
});
