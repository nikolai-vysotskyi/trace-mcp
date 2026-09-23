/**
 * Slow-statement guard for better-sqlite3 (TRA-1834).
 *
 * The night QA run of 2026-09-22 caught the live daemon wedged for 5+ min
 * inside ONE synchronous `Statement.run` (`sqlite3_step` with B-tree /
 * string-compare frames) during a from-scratch bulk index — while
 * `daemon.log` stayed silent and `/health` answered nothing. No code path
 * recorded WHICH statement it was: the event-loop lag monitor (TRA-1828)
 * counted the stall, but nothing named the SQL. That blind spot is what
 * this module closes.
 *
 * `installSlowStatementGuard(db)` wraps the handle's `prepare`/`exec` so
 * every `run`/`get`/`all` (`iterate` covers creation only — it is lazy)
 * is timed, and any statement slower than the threshold warn-logs its SQL
 * text plus elapsed ms. The threshold comes from `TRACE_MCP_SLOW_SQL_MS`
 * (default 2000 ms); `0` logs everything (tests), negative/NaN falls back
 * to the default. Installed once per handle (WeakSet-guarded — installing
 * twice must not double-wrap and double-log).
 *
 * Cost: two `Date.now()` calls per statement execution — negligible next
 * to any SQLite work. Threading: better-sqlite3 is synchronous, so timing
 * on the calling thread attributes the stall to exactly the statement
 * holding the daemon's only thread.
 */
import type Database from 'better-sqlite3';
import { logger } from '../logger.js';

/** Env var overriding the slow-statement threshold (milliseconds). */
export const SLOW_SQL_ENV_VAR = 'TRACE_MCP_SLOW_SQL_MS';

/** Statements at or above this latency are warn-logged with their SQL. */
export const DEFAULT_SLOW_SQL_MS = 2000;

/** SQL text is clipped to this many chars in the log line. */
export const MAX_LOGGED_SQL_LEN = 500;

export interface SlowStatementGuardOptions {
  /**
   * Explicit threshold in ms. `0` logs every statement; negative falls
   * back to the env/default resolution. Defaults to env/default.
   */
  thresholdMs?: number;
}

const installed = new WeakSet<object>();

/** Resolve the effective threshold: explicit > env > default. */
export function resolveSlowSqlThreshold(thresholdMs?: number): number {
  if (thresholdMs != null && thresholdMs >= 0) return thresholdMs;
  if (thresholdMs != null && thresholdMs < 0) return DEFAULT_SLOW_SQL_MS;
  const fromEnv = Number(process.env[SLOW_SQL_ENV_VAR]);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return DEFAULT_SLOW_SQL_MS;
}

function clipSql(sql: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_LOGGED_SQL_LEN ? `${flat.slice(0, MAX_LOGGED_SQL_LEN)}…` : flat;
}

type StatementMethod = 'run' | 'get' | 'all' | 'iterate';
const TIMED_METHODS = new Set<string>(['run', 'get', 'all', 'iterate']);

/**
 * Wrap a prepared statement so its row-returning executions are timed.
 *
 * Two Proxy hazards, both handled here:
 * - Timed methods MUST be invoked with the REAL statement as `this` (never
 *   the Proxy — the native binding requires its internal slots).
 * - Fluent modifiers (`.pluck()`, `.raw()`, `.bind()`, ...) return `this`
 *   from native code, which likewise rejects a Proxy receiver. So EVERY
 *   method is forwarded with the real target as `this`; when the result is
 *   the target itself the Proxy is returned instead, keeping the chain
 *   wrapped (and timed at the terminal `run`/`get`/`all`).
 */
function wrapStatement<T extends object>(
  stmt: T,
  sql: string,
  thresholdMs: number,
  dbName: string,
): T {
  const timed = (method: StatementMethod, fn: (...a: unknown[]) => unknown) => {
    return (...args: unknown[]) => {
      const t0 = Date.now();
      try {
        return fn(...args);
      } finally {
        const ms = Date.now() - t0;
        if (ms >= thresholdMs) {
          logger.warn(
            { ms, op: method, db: dbName, sql: clipSql(sql) },
            'Slow SQLite statement blocked the event loop',
          );
        }
      }
    };
  };
  const proxy = new Proxy(stmt, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function' || typeof prop === 'symbol') return value;
      if (TIMED_METHODS.has(prop)) {
        return timed(prop as StatementMethod, (...args: unknown[]) =>
          (value as (...a: unknown[]) => unknown).apply(target, args),
        );
      }
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        return result === target ? proxy : result;
      };
    },
  });
  return proxy;
}

/**
 * Install the slow-statement guard on a better-sqlite3 handle. Idempotent
 * per handle. Call once, right after opening (see `initializeDatabase`).
 */
export function installSlowStatementGuard(
  db: Database.Database,
  opts: SlowStatementGuardOptions = {},
): void {
  if (installed.has(db)) return;
  installed.add(db);

  const thresholdMs = resolveSlowSqlThreshold(opts.thresholdMs);
  const handle = db as unknown as Record<string, unknown>;
  const dbName = typeof db.name === 'string' ? db.name : 'unknown';

  const origPrepare = (db.prepare as (...a: never[]) => Database.Statement).bind(db);
  handle['prepare'] = function (source: unknown, ...rest: never[]) {
    const stmt = origPrepare(source as never, ...rest);
    return wrapStatement(stmt as unknown as object, String(source), thresholdMs, dbName);
  };

  const origExec = (db.exec as (sql: string) => unknown).bind(db);
  handle['exec'] = function (source: unknown) {
    const sql = String(source);
    const t0 = Date.now();
    try {
      return origExec(sql);
    } finally {
      const ms = Date.now() - t0;
      if (ms >= thresholdMs) {
        logger.warn(
          { ms, op: 'exec', db: dbName, sql: clipSql(sql) },
          'Slow SQLite statement blocked the event loop',
        );
      }
    }
  };
}
