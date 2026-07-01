/**
 * Regression test for CWE-89 (SQL injection) in Vec0Index.
 *
 * Every DDL/DML statement in vec-extension.ts interpolates `this.table`
 * directly into the SQL string (e.g. `DROP TABLE IF EXISTS ${this.table}`
 * in clear(), `CREATE VIRTUAL TABLE IF NOT EXISTS ${this.table} USING
 * vec0(...)` in ensure()). SQLite has no parameter-binding mechanism for
 * identifiers (table/column names can't be bound params), so string
 * interpolation is unavoidable here — but `this.table` MUST therefore be
 * validated as a safe identifier before it is ever used in SQL.
 *
 * Today `table` is a hardcoded private field (`'vec_symbol_embeddings'`),
 * never derived from external/config input — so this is defense-in-depth
 * rather than a currently-exploitable path. The fix adds:
 *   1. A reusable `isSafeSqliteIdentifier()` validator (exported, pure,
 *      directly testable).
 *   2. A constructor-time assertion so any future change that makes
 *      `table` configurable fails fast instead of building unsafe SQL.
 *   3. A defensive re-check immediately before the DROP TABLE statement
 *      in clear() (belt-and-suspenders, in case `table` is ever mutated
 *      post-construction).
 */
import { describe, expect, it } from 'vitest';
import { isSafeSqliteIdentifier, Vec0Index } from '../../src/ai/vec-extension.js';
import { createTestStore } from '../test-utils.js';

describe('isSafeSqliteIdentifier', () => {
  it('accepts the real accelerator table name', () => {
    expect(isSafeSqliteIdentifier('vec_symbol_embeddings')).toBe(true);
  });

  it('accepts simple identifiers (letters, digits, underscore, not leading digit)', () => {
    expect(isSafeSqliteIdentifier('foo')).toBe(true);
    expect(isSafeSqliteIdentifier('_foo')).toBe(true);
    expect(isSafeSqliteIdentifier('foo_bar_123')).toBe(true);
  });

  it('rejects identifiers with SQL injection payloads', () => {
    expect(isSafeSqliteIdentifier('x; DROP TABLE users; --')).toBe(false);
    expect(isSafeSqliteIdentifier('x` DROP TABLE users --')).toBe(false);
    expect(isSafeSqliteIdentifier('x"); DROP TABLE users; --')).toBe(false);
    expect(isSafeSqliteIdentifier("x' OR '1'='1")).toBe(false);
  });

  it('rejects identifiers with whitespace, quotes, or leading digits', () => {
    expect(isSafeSqliteIdentifier('has space')).toBe(false);
    expect(isSafeSqliteIdentifier('has"quote')).toBe(false);
    expect(isSafeSqliteIdentifier("has'quote")).toBe(false);
    expect(isSafeSqliteIdentifier('1leading_digit')).toBe(false);
    expect(isSafeSqliteIdentifier('')).toBe(false);
  });
});

describe('Vec0Index — SQL injection hardening', () => {
  it('tryCreate succeeds normally with the real hardcoded table name (non-regression)', () => {
    const store = createTestStore();
    const index = Vec0Index.tryCreate(store.db);
    // sqlite-vec may or may not be loadable in the test environment; either
    // outcome is fine — we only assert it never throws during construction.
    expect(index === null || index instanceof Vec0Index).toBe(true);
    store.db.close();
  });

  it('clear() defensively re-validates the table identifier before DROP TABLE', () => {
    const store = createTestStore();
    const index = Vec0Index.tryCreate(store.db);
    if (!index) {
      // sqlite-vec not installed in this environment — nothing to exercise.
      store.db.close();
      return;
    }

    // Tamper with the private table field to simulate what would happen if
    // `table` were ever derived from untrusted input post-construction.
    // The defensive check in clear() must reject this rather than execute
    // a DROP TABLE against an attacker-controlled identifier string.
    (index as unknown as { table: string }).table = 'x; DROP TABLE symbols; --';

    expect(() => index.clear()).toThrow(/invalid.*identifier|unsafe.*table/i);

    // Prove the malicious DDL never ran — the real `symbols` table (created
    // by initializeDatabase) must still exist.
    const row = store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'symbols'`)
      .get();
    expect(row).toBeDefined();

    store.db.close();
  });
});
