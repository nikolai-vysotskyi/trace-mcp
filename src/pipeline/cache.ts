/**
 * Idempotency cache abstraction for `TaskDag`.
 *
 * `TaskDag` was originally backed by an in-memory `Map<string, unknown>` which
 * meant a freshly-started daemon paid full cost for every pass on its first
 * run, even when nothing had changed. Pulling the cache behind an interface
 * lets us swap in a SQLite-backed implementation for the long-lived daemon
 * while keeping tests fast with the in-memory fallback.
 *
 * Contract:
 *   - get(task, key)  → previously-stored value or `undefined`
 *   - set(task, key, value) → stores the value (overwriting)
 *   - clear(task?)    → drops everything for one task name, or all entries
 *
 * Composite key: implementations store `(task_name, cache_key)` as a pair so
 * two tasks emitting the same `key(input)` never collide.
 *
 * JSON safety: persisted implementations serialise values via `JSON.stringify`.
 * Callers that need to cache must produce JSON-safe values (no functions,
 * BigInt, Map/Set, cycles). The SQLite implementation throws a clear error
 * when given an unserialisable value rather than silently coercing.
 */
import type Database from 'better-sqlite3';

/** Pluggable cache used by `TaskDag` to memoise task outputs by stable key. */
export interface TaskCache {
  /** True when an entry exists under `(taskName, key)`. Distinguishes
   * a cached `undefined`/`null` from a miss. */
  has(taskName: string, key: string): boolean;
  /** Returns the cached value or `undefined` when not present. Callers that
   * need to distinguish a cached `undefined` from a miss must call `has` first. */
  get(taskName: string, key: string): unknown | undefined;
  /** Stores `value` under `(taskName, key)`. Overwrites any prior entry. */
  set(taskName: string, key: string, value: unknown): void;
  /** Drops a single entry. No-op when the entry is absent. */
  delete(taskName: string, key: string): void;
  /** Drops cache rows. With no arg empties the cache; with a name only that task. */
  clear(taskName?: string): void;
  /** Total number of cache entries — used by `TaskDag.cacheSize` for tests. */
  size(): number;
}

/** Default LRU cap for `InMemoryTaskCache` — see class docstring. */
export const DEFAULT_IN_MEMORY_TASK_CACHE_CAPACITY = 1000;

/**
 * Default in-memory implementation. Wraps a single `Map` keyed by
 * `${taskName}::${cacheKey}` and evicts least-recently-used entries when
 * the entry count would exceed `capacity` (default
 * `DEFAULT_IN_MEMORY_TASK_CACHE_CAPACITY`).
 *
 * The cap exists so that a long-running daemon process that registers tasks
 * with unbounded `key()` domains (e.g. one cache entry per indexed file)
 * cannot grow the in-memory map indefinitely. The cap is purposely small —
 * the daemon should construct `SqliteTaskCache` instead and rely on disk
 * persistence for "real" cache reuse across restarts. The in-memory cache is
 * a short-horizon idempotency buffer, not a long-term store.
 *
 * LRU implementation note: insertion order in `Map` is iteration order, so
 * we rely on delete+reinsert on access (`get` / `has`) to bubble recently
 * touched entries to the tail. Eviction pops the head (oldest) entry.
 */
export class InMemoryTaskCache implements TaskCache {
  private readonly entries = new Map<string, unknown>();
  private readonly capacity: number;

  constructor(capacity: number = DEFAULT_IN_MEMORY_TASK_CACHE_CAPACITY) {
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new Error(
        `InMemoryTaskCache: capacity must be a positive integer, received ${capacity}`,
      );
    }
    this.capacity = Math.floor(capacity);
  }

  has(taskName: string, key: string): boolean {
    return this.entries.has(compositeKey(taskName, key));
  }

  get(taskName: string, key: string): unknown | undefined {
    const k = compositeKey(taskName, key);
    if (!this.entries.has(k)) return undefined;
    // Bubble to tail so the entry is "recently used" for LRU bookkeeping.
    const value = this.entries.get(k);
    this.entries.delete(k);
    this.entries.set(k, value);
    return value;
  }

  set(taskName: string, key: string, value: unknown): void {
    const k = compositeKey(taskName, key);
    // Delete first so re-insert always goes to the tail (LRU bookkeeping).
    this.entries.delete(k);
    this.entries.set(k, value);
    while (this.entries.size > this.capacity) {
      // Pop the head — oldest (least-recently used) entry.
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(taskName: string, key: string): void {
    this.entries.delete(compositeKey(taskName, key));
  }

  clear(taskName?: string): void {
    if (taskName === undefined) {
      this.entries.clear();
      return;
    }
    const prefix = `${taskName}::`;
    for (const k of Array.from(this.entries.keys())) {
      if (k.startsWith(prefix)) this.entries.delete(k);
    }
  }

  size(): number {
    return this.entries.size;
  }

  /** Maximum entries this cache will retain before LRU eviction kicks in. */
  getCapacity(): number {
    return this.capacity;
  }
}

/**
 * SQLite-backed cache. Persists rows in the `pass_cache` table so cached
 * outputs survive daemon restarts. The table is created by the v28 migration
 * in `src/db/schema.ts`; do not construct this cache against a database that
 * has not been initialised via `initializeDatabase`.
 *
 * Values are JSON-serialised. If the caller hands in something that
 * `JSON.stringify` cannot represent (a function, a BigInt, a Map, a cyclic
 * graph), `set()` throws a clear error — we never silently downgrade to
 * `null` or skip the write.
 */
export class SqliteTaskCache implements TaskCache {
  private readonly getStmt: Database.Statement;
  private readonly setStmt: Database.Statement;
  private readonly clearTaskStmt: Database.Statement;
  private readonly clearAllStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  private readonly hasStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly evictExpiredStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.getStmt = db.prepare(
      'SELECT value_json FROM pass_cache WHERE task_name = ? AND cache_key = ?',
    );
    this.hasStmt = db.prepare(
      'SELECT 1 FROM pass_cache WHERE task_name = ? AND cache_key = ? LIMIT 1',
    );
    this.setStmt = db.prepare(
      'INSERT OR REPLACE INTO pass_cache (task_name, cache_key, value_json, created_at) VALUES (?, ?, ?, ?)',
    );
    this.deleteStmt = db.prepare('DELETE FROM pass_cache WHERE task_name = ? AND cache_key = ?');
    this.clearTaskStmt = db.prepare('DELETE FROM pass_cache WHERE task_name = ?');
    this.clearAllStmt = db.prepare('DELETE FROM pass_cache');
    this.countStmt = db.prepare('SELECT COUNT(*) as c FROM pass_cache');
    // Uses idx_pass_cache_created (added by v28 migration) — single-index DELETE.
    this.evictExpiredStmt = db.prepare('DELETE FROM pass_cache WHERE created_at < ?');
  }

  has(taskName: string, key: string): boolean {
    return this.hasStmt.get(taskName, key) !== undefined;
  }

  get(taskName: string, key: string): unknown | undefined {
    const row = this.getStmt.get(taskName, key) as { value_json: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json);
    } catch (err) {
      throw new Error(
        `SqliteTaskCache: stored value for (${taskName}, ${key}) is not valid JSON: ${(err as Error).message}`,
      );
    }
  }

  set(taskName: string, key: string, value: unknown): void {
    let serialised: string;
    try {
      serialised = JSON.stringify(value);
    } catch (err) {
      throw new Error(
        `SqliteTaskCache: value for (${taskName}, ${key}) is not JSON-serialisable: ${(err as Error).message}`,
      );
    }
    if (serialised === undefined) {
      // JSON.stringify returns undefined for a top-level function/symbol/etc.
      throw new Error(
        `SqliteTaskCache: value for (${taskName}, ${key}) serialises to undefined (function/symbol/etc.)`,
      );
    }
    this.setStmt.run(taskName, key, serialised, Date.now());
  }

  delete(taskName: string, key: string): void {
    this.deleteStmt.run(taskName, key);
  }

  clear(taskName?: string): void {
    if (taskName === undefined) {
      this.clearAllStmt.run();
      return;
    }
    this.clearTaskStmt.run(taskName);
  }

  size(): number {
    const row = this.countStmt.get() as { c: number };
    return row.c;
  }

  /**
   * Drop rows older than `ttlMs` milliseconds. Returns the number of rows
   * removed. Used by the long-running daemon to bound the `pass_cache` table
   * size — without this, every fresh (task, input-hash) pair adds one row
   * forever. Cheap: single indexed DELETE backed by `idx_pass_cache_created`.
   */
  evictExpired(ttlMs: number): number {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error(
        `SqliteTaskCache.evictExpired: ttlMs must be a non-negative finite number, received ${ttlMs}`,
      );
    }
    const cutoff = Date.now() - ttlMs;
    const result = this.evictExpiredStmt.run(cutoff);
    return Number(result.changes ?? 0);
  }
}

function compositeKey(taskName: string, key: string): string {
  return `${taskName}::${key}`;
}
