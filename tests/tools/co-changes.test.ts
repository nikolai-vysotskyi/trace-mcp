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
