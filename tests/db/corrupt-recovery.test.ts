/**
 * TRA-1923: SQLITE_CORRUPT_VTAB (`database disk image is malformed`) in FTS5.
 *
 * A torn bulk-index write (overlapping indexer, force exit with
 * synchronous=OFF) leaves the FTS5 index malformed. SQLite reports it on
 * first touch — here simulated by zeroing the file pages past the header,
 * the way a torn WAL checkpoint leaves them — and the daemon must classify
 * the failure and recover (delete the torn family, rebuild from scratch)
 * instead of leaving the DB to rot.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { isCorruptDbError } from '../../src/db/repair.js';
import { Store } from '../../src/db/store.js';
import { verifyIndex } from '../../src/db/verify.js';
import { deleteDbFamily } from '../../src/utils/db-family.js';
import type { RawSymbol } from '../../src/plugin-api/types.js';

describe('isCorruptDbError', () => {
  it('matches the better-sqlite3 corrupt shape (message + code + codeName)', () => {
    const err = Object.assign(new Error('database disk image is malformed'), {
      code: 'SQLITE_CORRUPT',
      codeName: 'SQLITE_CORRUPT_VTAB',
    });
    expect(isCorruptDbError(err)).toBe(true);
  });

  it('matches on message alone (re-wrapped errors lose code/codeName)', () => {
    expect(isCorruptDbError(new Error('database disk image is malformed'))).toBe(true);
    expect(isCorruptDbError({ message: 'database disk image is malformed' })).toBe(true);
  });

  it('matches on code / codeName alone', () => {
    expect(isCorruptDbError({ code: 'SQLITE_CORRUPT', message: 'something else' })).toBe(true);
    expect(isCorruptDbError({ codeName: 'SQLITE_CORRUPT_VTAB' })).toBe(true);
    expect(isCorruptDbError({ codeName: 'SQLITE_CORRUPT' })).toBe(true);
  });

  it('rejects FK violations, busy errors, and generic failures', () => {
    expect(isCorruptDbError(new Error('FOREIGN KEY constraint failed'))).toBe(false);
    expect(
      isCorruptDbError(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })),
    ).toBe(false);
    expect(isCorruptDbError(new Error('no such table: symbols'))).toBe(false);
    expect(isCorruptDbError(null)).toBe(false);
    expect(isCorruptDbError(undefined)).toBe(false);
  });
});

describe('torn-DB recovery primitives (TRA-1923)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-corrupt-'));
    dbPath = path.join(tmpDir, 'index.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Build a file-backed index with enough FTS content to span many pages. */
  function buildIndex(symbolCount: number): void {
    const db = initializeDatabase(dbPath);
    const store = new Store(db);
    const fileId = store.insertFile('src/a.ts', 'typescript', 'hash1', 100, null, null, (t, r) =>
      store.createNode(t, r),
    );
    const syms: RawSymbol[] = Array.from({ length: symbolCount }, (_, i) => ({
      name: `fn_${i}`,
      kind: 'function' as const,
      fqn: `a.fn_${i}`,
      signature: `fn_${i}()`,
    }));
    store.insertSymbols(fileId, syms);
    db.close();
  }

  /**
   * Simulate a torn write: zero every page past the first two, keeping the
   * SQLite header + sqlite_master readable so the file still opens and the
   * failure surfaces as SQLITE_CORRUPT on first touch (not NOTADB at open).
   */
  function tearPagesPastHeader(): void {
    // Drop WAL sidecars first — the reopen must read the torn main file, not
    // replay a healthy WAL over it.
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        /* absent — fine */
      }
    }
    const fd = fs.openSync(dbPath, 'r+');
    try {
      const size = fs.fstatSync(fd).size;
      expect(size).toBeGreaterThan(64 * 1024);
      const KEEP = 8192; // first two 4K pages: header + schema roots
      const zero = Buffer.alloc(Math.min(65536, size - KEEP), 0);
      let off = KEEP;
      while (off < size) {
        const n = Math.min(zero.length, size - off);
        fs.writeSync(fd, zero.subarray(0, n), 0, n, off);
        off += n;
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  it('an FTS-triggering write on the torn DB throws a corrupt-classified error', () => {
    buildIndex(1000);
    tearPagesPastHeader();

    const db = new Database(dbPath);
    try {
      // DELETE fires the symbols_ad FTS trigger — the exact statement from
      // the TRA-1923 field stack (deleteSymbolsByFile inside reconcileScope).
      const fireFtsDelete = (): void => {
        db.prepare('DELETE FROM symbols WHERE id = ?').run(1);
      };
      expect(fireFtsDelete).toThrowError();
      let caught: unknown;
      try {
        fireFtsDelete();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      expect(isCorruptDbError(caught)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('deleteDbFamily + fresh open rebuilds a healthy index from the torn DB', () => {
    buildIndex(1000);
    tearPagesPastHeader();

    deleteDbFamily(dbPath);
    expect(fs.existsSync(dbPath)).toBe(false);

    const db = initializeDatabase(dbPath);
    try {
      // Fresh schema, empty but structurally sound — the daemon's next
      // indexAll repopulates it (bulk-load mode, from scratch).
      const report = verifyIndex(db);
      expect(report.checks.find((c) => c.name === 'sqlite_integrity')?.status).toBe('ok');
      expect(report.checks.find((c) => c.name === 'fts_integrity')?.status).toBe('ok');
      expect(report.checks.find((c) => c.name === 'required_tables')?.status).toBe('ok');
    } finally {
      db.close();
    }
  });
});
