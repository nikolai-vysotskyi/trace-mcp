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

/**
 * Default in-memory implementation. Wraps a single `Map` keyed by
 * `${taskName}::${cacheKey}`. Cheap, allocation-free for the hot path, and
 * the historical behaviour of `TaskDag` before the cache was made pluggable.
 *
 * Use this in tests and short-lived processes where persistence is not
 * desired. The daemon should construct `SqliteTaskCache` instead so that the
 * cache survives restarts.
 */
export class InMemoryTaskCache implements TaskCache {
  private readonly entries = new Map<string, unknown>();

  has(taskName: string, key: string): boolean {
    return this.entries.has(compositeKey(taskName, key));
  }

  get(taskName: string, key: string): unknown | undefined {
    return this.entries.get(compositeKey(taskName, key));
  }

  set(taskName: string, key: string, value: unknown): void {
    this.entries.set(compositeKey(taskName, key), value);
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
}

function compositeKey(taskName: string, key: string): string {
  return `${taskName}::${key}`;
}
