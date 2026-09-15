import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fuzzySearch } from '../../src/db/fuzzy.js';
import { repairIndex } from '../../src/db/repair.js';
import {
  initializeDatabase,
  resolveIndexMemory,
  resolveIndexMemoryProfile,
} from '../../src/db/schema.js';
import { verifyIndex } from '../../src/db/verify.js';
import type { Store } from '../../src/db/store.js';
import { createTestStore } from '../test-utils.js';

function seedCorpus(store: Store): void {
  const db = store.db;
  const f1 = store.insertFile('src/services/user.ts', 'typescript', 'h1', 1000);
  const f2 = store.insertFile('src/services/payment.ts', 'typescript', 'h2', 1000);
  const f3 = store.insertFile('src/utils/format.py', 'python', 'h3', 500);
  const syms: Array<[number, string, string, string, string | null]> = [
    [f1, 'u-1', 'getUserProfile', 'function', 'UserService.getUserProfile'],
    [f1, 'u-2', 'getUserProfiles', 'function', 'UserService.getUserProfiles'],
    [f1, 'u-3', 'setUserProfile', 'function', 'UserService.setUserProfile'],
    [f1, 'u-4', 'UserService', 'class', 'UserService'],
    [f2, 'p-1', 'processPayment', 'function', 'PaymentService.processPayment'],
    [f2, 'p-2', 'PaymentService', 'class', 'PaymentService'],
    [f3, 'f-1', 'formatCurrency', 'function', 'format.formatCurrency'],
    [f3, 'f-2', 'formatDate', 'function', 'format.formatDate'],
    [f3, 'f-3', 'ab', 'function', 'format.ab'],
  ];
  for (const [fileId, symbolId, name, kind, fqn] of syms) {
    store.insertSymbol(fileId, {
      symbolId,
      name,
      kind,
      fqn,
      byteStart: 0,
      byteEnd: 100,
      lineStart: 1,
      lineEnd: 10,
    });
  }
  void db;
}

describe('TRA-1541 trigram-merge', () => {
  it('finds typo queries the old shared-trigram path found (recall parity)', () => {
    const store = createTestStore();
    seedCorpus(store);
    // 1-char deletions: a bare FTS5 MATCH would AND all trigrams and return
    // nothing (the mutated trigrams match no row); the OR-of-trigrams must
    // recover the same candidates the old shared>=1 path found, and the
    // unchanged Jaccard/edit gates make the final cut.
    const r1 = fuzzySearch(store.db, 'getUsrProfile');
    expect(r1.some((r) => r.name === 'getUserProfile')).toBe(true);
    const r2 = fuzzySearch(store.db, 'procesPayment');
    expect(r2.some((r) => r.name === 'processPayment')).toBe(true);
    const r3 = fuzzySearch(store.db, 'formatCurrenc');
    expect(r3.some((r) => r.name === 'formatCurrency')).toBe(true);
  });

  it('resolves short (<3 char) queries via the LIKE fallback', () => {
    const store = createTestStore();
    seedCorpus(store);
    const r = fuzzySearch(store.db, 'ab');
    expect(r.some((x) => x.name === 'ab')).toBe(true);
  });

  it('keeps kind/language/filePattern filters working', () => {
    const store = createTestStore();
    seedCorpus(store);
    const byKind = fuzzySearch(store.db, 'formatCurrencyy', {
      kind: 'class',
      threshold: 0.1,
      maxEditDistance: 5,
    });
    expect(byKind.every((r) => r.kind === 'class')).toBe(true);
    const byLang = fuzzySearch(store.db, 'formatCurrencyy', {
      language: 'typescript',
      threshold: 0.1,
      maxEditDistance: 5,
    });
    expect(byLang.length).toBe(0);
    const byFile = fuzzySearch(store.db, 'formatCurrencyy', {
      filePattern: '*.py',
      threshold: 0.1,
      maxEditDistance: 5,
    });
    expect(byFile.some((r) => r.name === 'formatCurrency')).toBe(true);
  });

  it('stays in sync on symbol delete + update via triggers (no explicit calls)', () => {
    const store = createTestStore();
    seedCorpus(store);
    expect(fuzzySearch(store.db, 'processPayment').length).toBeGreaterThan(0);
    const f2 = store.getFile('src/services/payment.ts')!;
    store.deleteSymbolsByFile(f2.id);
    expect(fuzzySearch(store.db, 'processPayment').some((r) => r.name === 'processPayment')).toBe(
      false,
    );
    // Other files unaffected.
    expect(fuzzySearch(store.db, 'getUserProfile').length).toBeGreaterThan(0);
  });

  it('fresh DBs have no symbol_trigrams table and a populated tri index', () => {
    const store = createTestStore();
    seedCorpus(store);
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'symbol_trigrams'")
      .all();
    expect(tables).toEqual([]);
    const triCount = (
      store.db.prepare('SELECT COUNT(*) AS c FROM symbols_name_tri').get() as { c: number }
    ).c;
    const symCount = (store.db.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number })
      .c;
    expect(triCount).toBe(symCount);
  });

  it('migration 33 upgrades a v32-shaped DB: drops the side table, backfills tri', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tri-mig-'));
    const dbPath = join(dir, 'index.db');
    // Build a v33 DB, then rewind it to a v32 shape: legacy side table with
    // junk + schema_version 32 + no tri table.
    const db = initializeDatabase(dbPath);
    db.exec('DROP TABLE symbols_name_tri');
    db.exec('DROP TRIGGER IF EXISTS symbols_tri_ai');
    db.exec('DROP TRIGGER IF EXISTS symbols_tri_ad');
    db.exec('DROP TRIGGER IF EXISTS symbols_tri_au');
    db.exec('CREATE TABLE symbol_trigrams (symbol_id INTEGER NOT NULL, trigram TEXT NOT NULL)');
    db.exec(`INSERT INTO symbol_trigrams VALUES (1, 'zzz')`);
    db.prepare("UPDATE schema_meta SET value = '32' WHERE key = 'schema_version'").run();
    db.close();

    const reopened = initializeDatabase(dbPath);
    const legacy = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'symbol_trigrams'")
      .all();
    expect(legacy).toEqual([]);
    const triCount = (
      reopened.prepare('SELECT COUNT(*) AS c FROM symbols_name_tri').get() as { c: number }
    ).c;
    expect(triCount).toBe(
      (reopened.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number }).c,
    );
    const version = reopened
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(Number(version.value)).toBe(33);
    reopened.close();
  });

  it('fresh file DBs pin page_size=4096 and incremental auto_vacuum', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tri-pragma-'));
    const dbPath = join(dir, 'index.db');
    const db = initializeDatabase(dbPath);
    const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    expect(pageSize).toBe(4096);
    const autoVacuum = (db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number })
      .auto_vacuum;
    // 2 = INCREMENTAL
    expect(autoVacuum).toBe(2);
    db.close();
  });

  it('resolveIndexMemory clamps on low RAM and passes through otherwise', () => {
    const fourGB = 4 * 1024 * 1024 * 1024;
    const sixteenGB = 16 * 1024 * 1024 * 1024;
    expect(resolveIndexMemoryProfile('auto', fourGB)).toBe('low-power');
    expect(resolveIndexMemoryProfile('auto', sixteenGB)).toBe('full');
    expect(resolveIndexMemoryProfile('full', fourGB)).toBe('full');
    expect(resolveIndexMemoryProfile('low-power', sixteenGB)).toBe('low-power');

    const clamped = resolveIndexMemory({ cacheMb: 16, mmapMb: 64 }, 'auto', fourGB);
    expect(clamped).toEqual({ cacheMb: 8, mmapMb: 32, profile: 'low-power' });
    // Never raises above what was requested.
    const small = resolveIndexMemory({ cacheMb: 4, mmapMb: 16 }, 'low-power', sixteenGB);
    expect(small).toEqual({ cacheMb: 4, mmapMb: 16, profile: 'low-power' });
    const full = resolveIndexMemory({ cacheMb: 16, mmapMb: 64 }, 'auto', sixteenGB);
    expect(full).toEqual({ cacheMb: 16, mmapMb: 64, profile: 'full' });
    // 8 loaded projects on low-power: (8+32) * 8 = 320 MB — inside 4 GB.
    expect((clamped.cacheMb + clamped.mmapMb) * 8).toBeLessThanOrEqual(1024);
  });

  it('rebuild-fts restores the trigram index and verify covers it', () => {
    const store = createTestStore();
    seedCorpus(store);
    // Simulate drift: drop the tri table entirely.
    store.db.exec('DROP TABLE symbols_name_tri');
    let report = verifyIndex(store.db);
    expect(report.checks.find((c) => c.name === 'required_tables')?.status).toBe('error');
    const repair = repairIndex(store.db, 'rebuild-fts');
    expect(repair.ok).toBe(true);
    report = verifyIndex(store.db);
    expect(report.ok).toBe(true);
    expect(fuzzySearch(store.db, 'getUsrProfile').some((r) => r.name === 'getUserProfile')).toBe(
      true,
    );
  });

  it('bm25 read contract untouched: exact FTS ranking still name-first', () => {
    const store = createTestStore();
    seedCorpus(store);
    const rows = store.db
      .prepare(
        `SELECT s.name, bm25(symbols_fts, 10.0, 5.0, 3.0, 1.0) AS rank
         FROM symbols_fts fts JOIN symbols s ON s.id = fts.rowid
         WHERE symbols_fts MATCH ? ORDER BY rank LIMIT 3`,
      )
      .all('"UserService"') as Array<{ name: string; rank: number }>;
    expect(rows[0].name).toBe('UserService');
  });
});
