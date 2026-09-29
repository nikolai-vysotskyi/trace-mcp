import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isSqliteShortReadError,
  openDatabaseWithWalRecovery,
} from '../../src/shared/sqlite-open.js';

describe('isSqliteShortReadError', () => {
  it('matches SQLITE_IOERR_SHORT_READ by code or message', () => {
    const byCode = new Error('disk I/O error') as NodeJS.ErrnoException;
    byCode.code = 'SQLITE_IOERR_SHORT_READ';
    expect(isSqliteShortReadError(byCode)).toBe(true);
    expect(isSqliteShortReadError(new Error('SQLITE_IOERR_SHORT_READ: short read'))).toBe(true);
  });

  it('rejects other SQLite errors and non-errors', () => {
    const busy = new Error('database is locked') as NodeJS.ErrnoException;
    busy.code = 'SQLITE_BUSY';
    expect(isSqliteShortReadError(busy)).toBe(false);
    expect(isSqliteShortReadError(new Error('boom'))).toBe(false);
    expect(isSqliteShortReadError(null)).toBe(false);
  });
});

describe('openDatabaseWithWalRecovery', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-open-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('opens a fresh database (passthrough, no healing needed)', () => {
    const dbPath = path.join(tmpDir, 'fresh.db');
    const db = openDatabaseWithWalRecovery(dbPath);
    try {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('opens a database with a stale 0-byte WAL without deleting anything live', () => {
    const dbPath = path.join(tmpDir, 'stale.db');
    const seed = openDatabaseWithWalRecovery(dbPath);
    seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    seed.exec("INSERT INTO t (v) VALUES ('kept')");
    seed.close();
    // Simulate the dead-process leftover from TRA-1233: clean close removes
    // sidecars, so plant the stray 0-byte WAL with no -shm companion.
    fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(0));
    const db = openDatabaseWithWalRecovery(dbPath);
    try {
      expect(db.prepare('SELECT v FROM t').get()).toEqual({ v: 'kept' });
    } finally {
      db.close();
    }
  });

  it('still throws the original error for a corrupt database', () => {
    const dbPath = path.join(tmpDir, 'corrupt.db');
    fs.writeFileSync(dbPath, 'corrupted header not a valid sqlite database');
    expect(() => openDatabaseWithWalRecovery(dbPath)).toThrow();
  });

  it('readonly opens never attempt healing', () => {
    const dbPath = path.join(tmpDir, 'ro.db');
    const seed = openDatabaseWithWalRecovery(dbPath);
    seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    seed.close();
    const db = openDatabaseWithWalRecovery(dbPath, { readonly: true });
    try {
      expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
      expect(() => db.exec('CREATE TABLE nope (id INTEGER)')).toThrow();
    } finally {
      db.close();
    }
  });
});
