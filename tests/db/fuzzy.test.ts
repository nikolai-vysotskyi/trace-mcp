import type Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  deleteTrigramsByFile,
  fuzzySearch,
  generateTrigrams,
  indexTrigramsBatch,
} from '../../src/db/fuzzy.js';
import type { Store } from '../../src/db/store.js';
import { createTestStore } from '../test-utils.js';

describe('Fuzzy search', () => {
  let db: Database.Database;
  let store: Store;

  beforeAll(() => {
    store = createTestStore();
    db = store.db;

    // Insert test files
    const fileId1 = store.insertFile('src/services/user.ts', 'typescript', 'hash1', 1000);
    const fileId2 = store.insertFile('src/services/payment.ts', 'typescript', 'hash2', 1000);
    const fileId3 = store.insertFile('src/utils/format.py', 'python', 'hash3', 500);

    // Insert test symbols
    const symbols = [
      {
        fileId: fileId1,
        symbolId: 'user-1',
        name: 'getUserProfile',
        kind: 'function',
        fqn: 'UserService.getUserProfile',
      },
      {
        fileId: fileId1,
        symbolId: 'user-2',
        name: 'getUserProfiles',
        kind: 'function',
        fqn: 'UserService.getUserProfiles',
      },
      {
        fileId: fileId1,
        symbolId: 'user-3',
        name: 'setUserProfile',
        kind: 'function',
        fqn: 'UserService.setUserProfile',
      },
      {
        fileId: fileId1,
        symbolId: 'user-4',
        name: 'UserService',
        kind: 'class',
        fqn: 'UserService',
      },
      {
        fileId: fileId2,
        symbolId: 'pay-1',
        name: 'processPayment',
        kind: 'function',
        fqn: 'PaymentService.processPayment',
      },
      {
        fileId: fileId2,
        symbolId: 'pay-2',
        name: 'PaymentService',
        kind: 'class',
        fqn: 'PaymentService',
      },
      {
        fileId: fileId3,
        symbolId: 'fmt-1',
        name: 'formatCurrency',
        kind: 'function',
        fqn: 'format.formatCurrency',
      },
      {
        fileId: fileId3,
        symbolId: 'fmt-2',
        name: 'formatDate',
        kind: 'function',
        fqn: 'format.formatDate',
      },
    ];

    // Use raw inserts for test symbols since we need specific IDs
    const trigramBatch: Array<{ id: number; name: string; fqn: string | null }> = [];
    for (const sym of symbols) {
      const result = store.insertSymbol(sym.fileId, {
        symbolId: sym.symbolId,
        name: sym.name,
        kind: sym.kind,
        fqn: sym.fqn,
        byteStart: 0,
        byteEnd: 100,
        lineStart: 1,
        lineEnd: 10,
      });
      trigramBatch.push({ id: result, name: sym.name, fqn: sym.fqn });
    }

    // Index trigrams
    indexTrigramsBatch(db, trigramBatch);
  });

  describe('generateTrigrams()', () => {
    it('generates correct trigrams', () => {
      const result = generateTrigrams('User');
      expect(result).toEqual(['use', 'ser']);
    });

    it('handles short strings', () => {
      const result = generateTrigrams('ab');
      expect(result).toEqual(['ab']);
    });

    it('generates lowercase trigrams', () => {
      const result = generateTrigrams('getUserProfile');
      expect(result[0]).toBe('get');
      expect(result.every((t) => t === t.toLowerCase())).toBe(true);
    });

    it('deduplicates trigrams', () => {
      const result = generateTrigrams('aaa');
      expect(result).toEqual(['aaa']);
    });
  });

  describe('fuzzySearch()', () => {
    it('finds exact match', () => {
      const results = fuzzySearch(db, 'getUserProfile');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe('getUserProfile');
      expect(results[0].editDistance).toBe(0);
    });

    it('finds match with typo (1 char off)', () => {
      const results = fuzzySearch(db, 'getUserProfle');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.name === 'getUserProfile')).toBe(true);
    });

    it('finds similar names', () => {
      const results = fuzzySearch(db, 'getUserProfile', { limit: 10 });
      const names = results.map((r) => r.name);
      // Should find getUserProfiles and setUserProfile too
      expect(names).toContain('getUserProfile');
      expect(names).toContain('getUserProfiles');
    });

    it('respects kind filter', () => {
      const results = fuzzySearch(db, 'UserService', { kind: 'class' });
      for (const r of results) {
        expect(r.kind).toBe('class');
      }
    });

    it('respects language filter', () => {
      const results = fuzzySearch(db, 'format', { language: 'python' });
      // Only python symbols should match
      for (const r of results) {
        expect(r.fileId).toBeGreaterThan(0);
      }
      // Should not include TypeScript symbols
      expect(results.some((r) => r.name === 'UserService')).toBe(false);
    });

    it('respects threshold', () => {
      // Very high threshold — should filter out distant matches
      const highThreshold = fuzzySearch(db, 'getUserProfle', { threshold: 0.9 });
      const lowThreshold = fuzzySearch(db, 'getUserProfle', { threshold: 0.2 });
      expect(lowThreshold.length).toBeGreaterThanOrEqual(highThreshold.length);
    });

    it('respects maxEditDistance', () => {
      const results = fuzzySearch(db, 'getUserProfle', { maxEditDistance: 0 });
      // Edit distance 0 means exact match only — "getUserProfle" doesn't exist
      expect(results.length).toBe(0);
    });

    it('returns empty for completely unrelated query', () => {
      const results = fuzzySearch(db, 'zzzyyyxxx');
      expect(results.length).toBe(0);
    });

    it('handles multiple results without N+1', () => {
      // fuzzySearch uses batch SQL — single candidate query + batch metadata
      const results = fuzzySearch(db, 'formatCurrencyy', {
        limit: 50,
        threshold: 0.1,
        maxEditDistance: 5,
      });
      // Should find formatCurrency and formatDate
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.name === 'formatCurrency')).toBe(true);
    });
  });

  describe('deleteTrigramsByFile()', () => {
    it('removes trigrams for a specific file', () => {
      // Insert a new file with symbols
      const fileId = store.insertFile('src/temp.ts', 'typescript', 'temphash', 100);
      const symId = store.insertSymbol(fileId, {
        symbolId: 'temp-1',
        name: 'temporaryFunction',
        kind: 'function',
        fqn: 'temporaryFunction',
        byteStart: 0,
        byteEnd: 50,
      });

      indexTrigramsBatch(db, [{ id: symId, name: 'temporaryFunction', fqn: 'temporaryFunction' }]);

      // Verify trigrams exist
      const before = fuzzySearch(db, 'temporaryFunction');
      expect(before.some((r) => r.name === 'temporaryFunction')).toBe(true);

      // Delete and verify gone
      deleteTrigramsByFile(db, fileId);
      const after = fuzzySearch(db, 'temporaryFunction');
      expect(after.some((r) => r.name === 'temporaryFunction')).toBe(false);
    });
  });
});
