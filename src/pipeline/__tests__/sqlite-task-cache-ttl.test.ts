/**
 * TTL eviction tests for the SQLite-backed `TaskCache`.
 *
 * The daemon stamps each `pass_cache` row with `Date.now()` at insert time,
 * and `SqliteTaskCache.evictExpired(ttlMs)` removes rows whose `created_at`
 * is older than `Date.now() - ttlMs`. Without this, the table would grow
 * forever in a long-running daemon (one row per (task, input-hash) pair).
 *
 * These tests bootstrap a real DB via `initializeDatabase` so the v28
 * migration (which provides `pass_cache` and `idx_pass_cache_created`) is
 * exercised end-to-end.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initializeDatabase } from '../../db/schema.js';
import { SqliteTaskCache } from '../cache.js';

const ONE_DAY_MS = 86_400_000;
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS;

let workDir: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sqlite-task-cache-ttl-'));
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

describe('SqliteTaskCache.evictExpired', () => {
  it('drops rows older than the TTL and keeps fresh rows', () => {
    const cache = new SqliteTaskCache(db);

    cache.set('task-a', 'fresh-1', { v: 1 });
    cache.set('task-a', 'fresh-2', { v: 2 });
    cache.set('task-a', 'stale-1', { v: 3 });

    // Backdate a single row by 90 days so it falls outside a 30-day TTL.
    const ninetyDaysAgo = Date.now() - 90 * ONE_DAY_MS;
    const update = db.prepare(
      'UPDATE pass_cache SET created_at = ? WHERE task_name = ? AND cache_key = ?',
    );
    const updateResult = update.run(ninetyDaysAgo, 'task-a', 'stale-1');
    expect(updateResult.changes).toBe(1);

    expect(cache.size()).toBe(3);

    const removed = cache.evictExpired(THIRTY_DAYS_MS);

    expect(removed).toBe(1);
    expect(cache.size()).toBe(2);
    expect(cache.has('task-a', 'fresh-1')).toBe(true);
    expect(cache.has('task-a', 'fresh-2')).toBe(true);
    expect(cache.has('task-a', 'stale-1')).toBe(false);
  });

  it('returns 0 when no rows are older than the TTL', () => {
    const cache = new SqliteTaskCache(db);

    cache.set('task-a', 'k1', 'v1');
    cache.set('task-a', 'k2', 'v2');

    const removed = cache.evictExpired(THIRTY_DAYS_MS);

    expect(removed).toBe(0);
    expect(cache.size()).toBe(2);
  });

  it('evicts all rows when TTL is 0 (everything is "older than now")', () => {
    const cache = new SqliteTaskCache(db);

    cache.set('task-a', 'k1', 'v1');
    cache.set('task-b', 'k2', 'v2');

    // Backdate everything by 1 ms so created_at < Date.now() - 0.
    db.prepare('UPDATE pass_cache SET created_at = created_at - 1').run();

    const removed = cache.evictExpired(0);

    expect(removed).toBe(2);
    expect(cache.size()).toBe(0);
  });

  it('throws on a non-finite or negative ttlMs', () => {
    const cache = new SqliteTaskCache(db);
    expect(() => cache.evictExpired(-1)).toThrow(/non-negative finite/);
    expect(() => cache.evictExpired(Number.NaN)).toThrow(/non-negative finite/);
    expect(() => cache.evictExpired(Number.POSITIVE_INFINITY)).toThrow(/non-negative finite/);
  });

  it('respects task boundaries — eviction is purely age-based, not per-task', () => {
    const cache = new SqliteTaskCache(db);

    cache.set('task-a', 'k1', 'a1');
    cache.set('task-b', 'k1', 'b1');

    const ninetyDaysAgo = Date.now() - 90 * ONE_DAY_MS;
    db.prepare('UPDATE pass_cache SET created_at = ? WHERE task_name = ? AND cache_key = ?').run(
      ninetyDaysAgo,
      'task-a',
      'k1',
    );

    const removed = cache.evictExpired(THIRTY_DAYS_MS);

    expect(removed).toBe(1);
    expect(cache.has('task-a', 'k1')).toBe(false);
    expect(cache.has('task-b', 'k1')).toBe(true);
  });
});
