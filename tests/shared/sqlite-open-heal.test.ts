/**
 * Heal-path coverage for `openDatabaseWithWalRecovery` (TRA-2068 follow-up).
 *
 * The pinned SQLite never raises `SQLITE_IOERR_SHORT_READ` for a short WAL,
 * so the recovery branch is unreachable against the real engine. These tests
 * inject the failure by mocking `better-sqlite3` and assert the safety gate:
 * unlink only a 0-byte WAL with no `-shm`, never readonly, exactly one
 * retry, half-open handles closed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabaseWithWalRecovery } from '../../src/shared/sqlite-open.js';

const controls = vi.hoisted(() => ({
  calls: 0,
  closes: 0,
  failure: null as null | {
    at: 'ctor' | 'pragma';
    code: string;
    message: string;
    onCall: number;
  },
}));

vi.mock('better-sqlite3', () => {
  class FakeDatabase {
    constructor(_dbPath: string, _opts?: unknown) {
      controls.calls += 1;
      const f = controls.failure;
      if (f && f.at === 'ctor' && controls.calls === f.onCall) {
        const err = new Error(f.message) as unknown as NodeJS.ErrnoException;
        err.code = f.code;
        throw err;
      }
    }
    pragma(_stmt: string): unknown[] {
      const f = controls.failure;
      if (f && f.at === 'pragma' && controls.calls === f.onCall) {
        const err = new Error(f.message) as unknown as NodeJS.ErrnoException;
        err.code = f.code;
        throw err;
      }
      return [];
    }
    close(): void {
      controls.closes += 1;
    }
  }
  return { default: FakeDatabase };
});

const SHORT_READ = {
  at: 'ctor' as const,
  code: 'SQLITE_IOERR_SHORT_READ',
  message: 'short read',
  onCall: 1,
};

describe('openDatabaseWithWalRecovery heal-path (injected SHORT_READ)', () => {
  let tmpDir: string;
  let dbPath: string;
  let walPath: string;
  let shmPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-open-heal-'));
    dbPath = path.join(tmpDir, 'test.db');
    walPath = `${dbPath}-wal`;
    shmPath = `${dbPath}-shm`;
    controls.calls = 0;
    controls.closes = 0;
    controls.failure = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('heals a stale 0-byte WAL and retries exactly once', () => {
    fs.writeFileSync(walPath, Buffer.alloc(0));
    controls.failure = { ...SHORT_READ };
    const db = openDatabaseWithWalRecovery(dbPath);
    expect(controls.calls).toBe(2);
    expect(controls.closes).toBe(0); // ctor throw → no handle → nothing to close
    expect(fs.existsSync(walPath)).toBe(false);
    db.close();
  });

  it('closes the half-open handle when SHORT_READ surfaces at first pragma', () => {
    fs.writeFileSync(walPath, Buffer.alloc(0));
    controls.failure = { ...SHORT_READ, at: 'pragma' };
    const db = openDatabaseWithWalRecovery(dbPath);
    expect(controls.calls).toBe(2);
    expect(controls.closes).toBe(1); // first handle closed by openOnce
    expect(fs.existsSync(walPath)).toBe(false);
    db.close();
  });

  it('refuses to unlink when -shm exists and rethrows (live/crashed WAL)', () => {
    fs.writeFileSync(walPath, Buffer.alloc(0));
    fs.writeFileSync(shmPath, Buffer.alloc(32768));
    controls.failure = { ...SHORT_READ };
    expect(() => openDatabaseWithWalRecovery(dbPath)).toThrow(/short read/);
    expect(controls.calls).toBe(1); // no retry
    expect(fs.existsSync(walPath)).toBe(true); // untouched
  });

  it('never heals readonly opens', () => {
    fs.writeFileSync(walPath, Buffer.alloc(0));
    controls.failure = { ...SHORT_READ };
    expect(() => openDatabaseWithWalRecovery(dbPath, { readonly: true })).toThrow();
    expect(controls.calls).toBe(1);
    expect(fs.existsSync(walPath)).toBe(true);
  });

  it('non-SHORT_READ errors propagate without touching the WAL', () => {
    fs.writeFileSync(walPath, Buffer.alloc(0));
    controls.failure = { ...SHORT_READ, code: 'SQLITE_BUSY', message: 'database is locked' };
    expect(() => openDatabaseWithWalRecovery(dbPath)).toThrow(/locked/);
    expect(controls.calls).toBe(1);
    expect(fs.existsSync(walPath)).toBe(true);
  });

  it('non-empty WAL is never unlinked', () => {
    fs.writeFileSync(walPath, Buffer.alloc(100, 7));
    controls.failure = { ...SHORT_READ };
    expect(() => openDatabaseWithWalRecovery(dbPath)).toThrow();
    expect(controls.calls).toBe(1);
    expect(fs.statSync(walPath).size).toBe(100);
  });

  it('lost unlink race (ENOENT, WAL already gone) still retries', () => {
    fs.writeFileSync(walPath, Buffer.alloc(0));
    controls.failure = { ...SHORT_READ };
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      fs.rmSync(walPath, { force: true }); // another healer won
      const err = new Error('no such file') as unknown as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    const db = openDatabaseWithWalRecovery(dbPath);
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(controls.calls).toBe(2); // retry happened
    db.close();
  });

  it('unlink failure with WAL still present rethrows', () => {
    fs.writeFileSync(walPath, Buffer.alloc(0));
    controls.failure = { ...SHORT_READ };
    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      const err = new Error('permission denied') as unknown as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    expect(() => openDatabaseWithWalRecovery(dbPath)).toThrow(/short read/);
    expect(controls.calls).toBe(1);
    expect(fs.existsSync(walPath)).toBe(true);
  });
});
