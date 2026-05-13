/**
 * Tests for the SQLite-backed `TaskCache` implementation. The headline
 * guarantee is durability: cache entries written by one cache instance must
 * be visible to a fresh instance opened against the same database, so the
 * daemon does not lose its pass cache on restart.
 *
 * The tests bootstrap a temp DB via `initializeDatabase` so the schema
 * migration (v28) is exercised end-to-end — fresh DBs get the `pass_cache`
 * table from the DDL block, existing DBs would receive it via the v28
 * migration runner. Either way the table must exist before the cache opens.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initializeDatabase } from '../../db/schema.js';
import { SqliteTaskCache } from '../cache.js';

let workDir: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sqlite-task-cache-'));
  dbPath = join(workDir, 'test.db');
  db = initializeDatabase(dbPath);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // best effort — some tests close the db themselves
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe('SqliteTaskCache', () => {
  it('round-trips a value through set → has → get', () => {
    const cache = new SqliteTaskCache(db);

    cache.set('task-a', 'k1', { hello: 'world', n: 42 });

    expect(cache.has('task-a', 'k1')).toBe(true);
    expect(cache.get('task-a', 'k1')).toEqual({ hello: 'world', n: 42 });
    expect(cache.size()).toBe(1);
  });

  it('returns undefined / false for a missing key', () => {
    const cache = new SqliteTaskCache(db);

    expect(cache.has('task-a', 'nope')).toBe(false);
    expect(cache.get('task-a', 'nope')).toBeUndefined();
  });

  it('persists across cache instances pointing at the same DB', () => {
    const writer = new SqliteTaskCache(db);
    writer.set('persisted-task', 'stable-key', { value: 'survives' });
    expect(writer.size()).toBe(1);

    // Simulate a daemon restart: drop the in-process cache + DB handle,
    // reopen the file, and confirm the row is still readable.
    db.close();
    db = initializeDatabase(dbPath);

    const reader = new SqliteTaskCache(db);
    expect(reader.has('persisted-task', 'stable-key')).toBe(true);
    expect(reader.get('persisted-task', 'stable-key')).toEqual({ value: 'survives' });
    expect(reader.size()).toBe(1);
  });

  it('composite key: same key under different task names stays separate', () => {
    const cache = new SqliteTaskCache(db);

    cache.set('task-a', 'shared-key', 'value-a');
    cache.set('task-b', 'shared-key', 'value-b');

    expect(cache.get('task-a', 'shared-key')).toBe('value-a');
    expect(cache.get('task-b', 'shared-key')).toBe('value-b');
    expect(cache.size()).toBe(2);
  });

  it('clear(taskName) only removes rows for that task', () => {
    const cache = new SqliteTaskCache(db);

    cache.set('task-a', 'k1', 1);
    cache.set('task-a', 'k2', 2);
    cache.set('task-b', 'k1', 'b');
    expect(cache.size()).toBe(3);

    cache.clear('task-a');

    expect(cache.size()).toBe(1);
    expect(cache.has('task-a', 'k1')).toBe(false);
    expect(cache.has('task-a', 'k2')).toBe(false);
    expect(cache.get('task-b', 'k1')).toBe('b');
  });

  it('clear() with no argument empties the table', () => {
    const cache = new SqliteTaskCache(db);

    cache.set('task-a', 'k1', 1);
    cache.set('task-b', 'k1', 2);
    cache.set('task-c', 'k1', 3);
    expect(cache.size()).toBe(3);

    cache.clear();

    expect(cache.size()).toBe(0);
    expect(cache.has('task-a', 'k1')).toBe(false);
  });

  it('set() overwrites a prior entry for the same composite key', () => {
    const cache = new SqliteTaskCache(db);

    cache.set('task-a', 'k', 'first');
    cache.set('task-a', 'k', 'second');

    expect(cache.size()).toBe(1);
    expect(cache.get('task-a', 'k')).toBe('second');
  });

  it('delete() drops one entry without affecting siblings', () => {
    const cache = new SqliteTaskCache(db);

    cache.set('task-a', 'k1', 1);
    cache.set('task-a', 'k2', 2);

    cache.delete('task-a', 'k1');

    expect(cache.has('task-a', 'k1')).toBe(false);
    expect(cache.has('task-a', 'k2')).toBe(true);
    expect(cache.size()).toBe(1);
  });

  it('throws a clear error for JSON-unsafe values (BigInt)', () => {
    const cache = new SqliteTaskCache(db);

    expect(() => cache.set('task-a', 'k', BigInt(1))).toThrow(/JSON|serialis/i);
    // The failed write must not leave a partial row behind.
    expect(cache.size()).toBe(0);
  });

  it('throws for top-level functions (JSON.stringify returns undefined)', () => {
    const cache = new SqliteTaskCache(db);

    expect(() => cache.set('task-a', 'k', () => 1)).toThrow(/undefined|serialis/i);
    expect(cache.size()).toBe(0);
  });

  it('the pass_cache table exists after initializeDatabase', () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pass_cache'")
      .get();
    expect(row).toBeTruthy();
  });
});
