/**
 * TRA-1834 — the slow-statement guard must name the SQL that blocks the loop.
 *
 * The 2026-09-22 night run caught the daemon wedged 5+ min in one
 * synchronous `sqlite3_step` with nothing in the log identifying the
 * statement. These tests pin the guard's contract: threshold resolution,
 * warn-logging with SQL text past the threshold, silence below it,
 * idempotent install, and transparent pass-through of the Statement API.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/logger.js';
import {
  DEFAULT_SLOW_SQL_MS,
  installSlowStatementGuard,
  resolveSlowSqlThreshold,
  SLOW_SQL_ENV_VAR,
} from '../../src/db/slow-statement.js';

describe('resolveSlowSqlThreshold (TRA-1834)', () => {
  const saved = process.env[SLOW_SQL_ENV_VAR];

  afterEach(() => {
    if (saved === undefined) delete process.env[SLOW_SQL_ENV_VAR];
    else process.env[SLOW_SQL_ENV_VAR] = saved;
  });

  it('explicit threshold wins over env', () => {
    process.env[SLOW_SQL_ENV_VAR] = '9999';
    expect(resolveSlowSqlThreshold(5)).toBe(5);
  });

  it('zero means log everything', () => {
    expect(resolveSlowSqlThreshold(0)).toBe(0);
  });

  it('negative falls back to the default', () => {
    expect(resolveSlowSqlThreshold(-1)).toBe(DEFAULT_SLOW_SQL_MS);
  });

  it('reads the env var when no explicit value is given', () => {
    process.env[SLOW_SQL_ENV_VAR] = '123';
    expect(resolveSlowSqlThreshold()).toBe(123);
  });

  it('garbage env falls back to the default', () => {
    process.env[SLOW_SQL_ENV_VAR] = 'not-a-number';
    expect(resolveSlowSqlThreshold()).toBe(DEFAULT_SLOW_SQL_MS);
  });

  it('defaults when nothing is set', () => {
    delete process.env[SLOW_SQL_ENV_VAR];
    expect(resolveSlowSqlThreshold()).toBe(DEFAULT_SLOW_SQL_MS);
  });
});

describe('installSlowStatementGuard (TRA-1834)', () => {
  let db: Database.Database;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = new Database(':memory:');
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    db.close();
  });

  it('logs run/get/all/exec with SQL text at threshold 0', () => {
    installSlowStatementGuard(db, { thresholdMs: 0 });

    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
    db.prepare('SELECT * FROM t WHERE v = ?').get('hello');
    db.prepare('SELECT * FROM t').all();

    // exec + run + get + all = 4 slow-statement warnings, each naming its SQL.
    expect(warnSpy).toHaveBeenCalledTimes(4);
    const messages = warnSpy.mock.calls.map((c) => c[1]);
    expect(messages.every((m) => m === 'Slow SQLite statement blocked the event loop')).toBe(true);
    const sqls = warnSpy.mock.calls.map((c) => (c[0] as { sql: string }).sql);
    expect(sqls.some((s) => s.includes('CREATE TABLE t'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO t'))).toBe(true);
    expect(sqls.some((s) => s.includes('SELECT * FROM t WHERE v = ?'))).toBe(true);
    const ops = warnSpy.mock.calls.map((c) => (c[0] as { op: string }).op);
    expect(ops).toContain('exec');
    expect(ops).toContain('run');
    expect(ops).toContain('get');
    expect(ops).toContain('all');
  });

  it('stays silent below the threshold', () => {
    installSlowStatementGuard(db, { thresholdMs: 60_000 });

    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO t (id) VALUES (?)').run(1);
    db.prepare('SELECT * FROM t').all();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('installing twice does not double-log', () => {
    installSlowStatementGuard(db, { thresholdMs: 0 });
    installSlowStatementGuard(db, { thresholdMs: 0 });

    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('statements keep working through the wrapper', () => {
    installSlowStatementGuard(db, { thresholdMs: 60_000 });

    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const info = db.prepare('INSERT INTO t (v) VALUES (?)').run('x');
    expect(info.changes).toBe(1);
    // Chained modifiers (.pluck/.raw) and readers (.columns) pass through.
    const plucked = db.prepare('SELECT v FROM t').pluck().get();
    expect(plucked).toBe('x');
    expect(db.prepare('SELECT * FROM t').all()).toHaveLength(1);
    // Transactions built on the handle still commit.
    const insertMany = db.transaction((vals: string[]) => {
      const stmt = db.prepare('INSERT INTO t (v) VALUES (?)');
      for (const v of vals) stmt.run(v);
    });
    insertMany(['a', 'b']);
    expect(db.prepare('SELECT COUNT(*) AS c FROM t').get()).toMatchObject({ c: 3 });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
