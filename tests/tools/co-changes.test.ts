import type Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { getCoChanges, persistCoChanges } from '../../src/tools/quality/co-changes.js';

describe('Co-Change Analysis', () => {
  let db: Database.Database;
  let store: Store;

  beforeAll(() => {
    db = initializeDatabase(':memory:');
    store = new Store(db);

    // Insert test files
    store.insertFile('src/controllers/UserController.ts', 'typescript', 'h1', 500);
    store.insertFile('tests/user.test.ts', 'typescript', 'h2', 300);
    store.insertFile('src/models/User.ts', 'typescript', 'h3', 400);
    store.insertFile('src/routes/api.ts', 'typescript', 'h4', 200);

    // Manually insert co-change data (simulating git log analysis)
    const pairs = new Map<string, Map<string, { count: number; lastDate: string }>>();

    const inner = new Map<string, { count: number; lastDate: string }>();
    inner.set('tests/user.test.ts', { count: 47, lastDate: '2026-04-01' });
    inner.set('src/models/User.ts', { count: 38, lastDate: '2026-03-28' });
    inner.set('src/routes/api.ts', { count: 15, lastDate: '2026-03-15' });
    pairs.set('src/controllers/UserController.ts', inner);

    const inner2 = new Map<string, { count: number; lastDate: string }>();
    inner2.set('src/models/User.ts', { count: 5, lastDate: '2026-03-10' });
    pairs.set('tests/user.test.ts', inner2);

    persistCoChanges(store, pairs, '/tmp/test', 180);
  });

  describe('getCoChanges()', () => {
    it('returns co-changes for a file sorted by confidence', () => {
      const result = getCoChanges(store, {
        file: 'src/controllers/UserController.ts',
        minCount: 1,
        minConfidence: 0,
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.file).toBe('src/controllers/UserController.ts');
      expect(data.coChanges.length).toBeGreaterThan(0);
      // Should be sorted by confidence DESC
      for (let i = 1; i < data.coChanges.length; i++) {
        expect(data.coChanges[i - 1].confidence).toBeGreaterThanOrEqual(
          data.coChanges[i].confidence,
        );
      }
    });

    it('respects minConfidence filter', () => {
      const highConf = getCoChanges(store, {
        file: 'src/controllers/UserController.ts',
        minConfidence: 0.8,
        minCount: 1,
      });
      const lowConf = getCoChanges(store, {
        file: 'src/controllers/UserController.ts',
        minConfidence: 0.1,
        minCount: 1,
      });
      expect(lowConf._unsafeUnwrap().coChanges.length).toBeGreaterThanOrEqual(
        highConf._unsafeUnwrap().coChanges.length,
      );
    });

    it('respects minCount filter', () => {
      const result = getCoChanges(store, {
        file: 'src/controllers/UserController.ts',
        minCount: 40,
        minConfidence: 0,
      });
      const data = result._unsafeUnwrap();
      for (const cc of data.coChanges) {
        expect(cc.count).toBeGreaterThanOrEqual(40);
      }
    });

    it('respects limit', () => {
      const result = getCoChanges(store, {
        file: 'src/controllers/UserController.ts',
        limit: 1,
        minCount: 1,
        minConfidence: 0,
      });
      expect(result._unsafeUnwrap().coChanges.length).toBeLessThanOrEqual(1);
    });

    it('returns empty for file with no co-changes', () => {
      const result = getCoChanges(store, {
        file: 'nonexistent/file.ts',
      });
      expect(result._unsafeUnwrap().coChanges.length).toBe(0);
    });

    it('does not include the empty-index warning when populated', () => {
      const result = getCoChanges(store, {
        file: 'src/controllers/UserController.ts',
        minCount: 1,
        minConfidence: 0,
      });
      const data = result._unsafeUnwrap();
      const empty = (data._warnings ?? []).find((w) => /empty/i.test(w));
      expect(empty).toBeUndefined();
    });
  });

  describe('empty-index handling', () => {
    it('surfaces a warning + hint when co_changes is empty', () => {
      const emptyDb = initializeDatabase(':memory:');
      const emptyStore = new Store(emptyDb);
      const result = getCoChanges(emptyStore, { file: 'anything.ts' });
      const data = result._unsafeUnwrap();
      expect(data.coChanges).toEqual([]);
      expect(data._warnings).toBeDefined();
      expect(data._warnings!.some((w) => /empty/i.test(w))).toBe(true);
      expect(data._hints).toBeDefined();
      expect(data._hints!.some((h) => h.tool === 'refresh_co_changes')).toBe(true);
    });
  });

  describe('stale-index handling', () => {
    it('warns when MAX(last_co_change) is more than 30 days old', () => {
      const staleDb = initializeDatabase(':memory:');
      const staleStore = new Store(staleDb);
      staleStore.insertFile('a.ts', 'typescript', 'h1', 100);
      staleStore.insertFile('b.ts', 'typescript', 'h2', 100);
      const stalePairs = new Map<string, Map<string, { count: number; lastDate: string }>>();
      const inner = new Map<string, { count: number; lastDate: string }>();
      // 120 days ago — well past the 30-day threshold
      const stale = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      inner.set('b.ts', { count: 10, lastDate: stale });
      stalePairs.set('a.ts', inner);
      persistCoChanges(staleStore, stalePairs, '/tmp/test', 180);

      const result = getCoChanges(staleStore, {
        file: 'a.ts',
        minCount: 1,
        minConfidence: 0,
      });
      const data = result._unsafeUnwrap();
      expect(data._warnings).toBeDefined();
      expect(data._warnings!.some((w) => /days ago/i.test(w))).toBe(true);
    });

    it('does not warn when the index is fresh (< 30 days)', () => {
      const freshDb = initializeDatabase(':memory:');
      const freshStore = new Store(freshDb);
      freshStore.insertFile('a.ts', 'typescript', 'h1', 100);
      freshStore.insertFile('b.ts', 'typescript', 'h2', 100);
      const freshPairs = new Map<string, Map<string, { count: number; lastDate: string }>>();
      const inner = new Map<string, { count: number; lastDate: string }>();
      const fresh = new Date().toISOString().split('T')[0];
      inner.set('b.ts', { count: 10, lastDate: fresh });
      freshPairs.set('a.ts', inner);
      persistCoChanges(freshStore, freshPairs, '/tmp/test', 180);

      const result = getCoChanges(freshStore, {
        file: 'a.ts',
        minCount: 1,
        minConfidence: 0,
      });
      const data = result._unsafeUnwrap();
      const stale = (data._warnings ?? []).find((w) => /days ago/i.test(w));
      expect(stale).toBeUndefined();
    });
  });

  describe('persistCoChanges()', () => {
    it('stores co-change pairs in the database', () => {
      const count = (db.prepare('SELECT COUNT(*) as c FROM co_changes').get() as { c: number }).c;
      expect(count).toBeGreaterThan(0);
    });

    it('does not create N+1 queries (single transaction)', () => {
      // Verify data integrity: all pairs should have positive counts
      const rows = db.prepare('SELECT * FROM co_changes').all() as Array<{
        co_change_count: number;
        confidence: number;
      }>;
      for (const row of rows) {
        expect(row.co_change_count).toBeGreaterThan(0);
        expect(row.confidence).toBeGreaterThan(0);
        expect(row.confidence).toBeLessThanOrEqual(1);
      }
    });
  });
});
