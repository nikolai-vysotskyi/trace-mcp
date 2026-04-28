import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';
import {
  decisionsForImpact,
  decisionsForResume,
  decisionsForTask,
} from '../../src/memory/enrichment.js';

describe('Decision Enrichment', () => {
  let store: DecisionStore;
  let dbPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-test-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);

    // Seed decisions
    store.addDecision({
      title: 'Use Clerk for auth',
      content: 'Chose Clerk over Auth0 for better DX and pricing.',
      type: 'tech_choice',
      project_root: '/projects/myapp',
      symbol_id: 'src/auth/provider.ts::AuthProvider#class',
      file_path: 'src/auth/provider.ts',
      tags: ['auth'],
    });
    store.addDecision({
      title: 'PostgreSQL for users DB',
      content: 'Switched to PostgreSQL for JSONB support.',
      type: 'tech_choice',
      project_root: '/projects/myapp',
      file_path: 'src/db/connection.ts',
      tags: ['database'],
    });
    store.addDecision({
      title: 'GraphQL migration',
      content: 'Migrating all REST endpoints to GraphQL resolvers.',
      type: 'architecture_decision',
      project_root: '/projects/myapp',
      file_path: 'src/api/schema.ts',
      tags: ['api', 'graphql'],
    });
    store.addDecision({
      title: 'Rate limiting via Redis',
      content: 'Use Redis for rate limiting middleware.',
      type: 'tech_choice',
      project_root: '/projects/other',
      file_path: 'src/middleware/rate-limit.ts',
      tags: ['performance'],
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  describe('decisionsForImpact', () => {
    it('finds decisions by symbol', () => {
      const results = decisionsForImpact(store, '/projects/myapp', {
        symbolId: 'src/auth/provider.ts::AuthProvider#class',
      });
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Use Clerk for auth');
      expect(results[0].symbol).toBe('src/auth/provider.ts::AuthProvider#class');
    });

    it('finds decisions by file', () => {
      const results = decisionsForImpact(store, '/projects/myapp', {
        filePath: 'src/db/connection.ts',
      });
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('PostgreSQL for users DB');
    });

    it('finds decisions from affected files', () => {
      const results = decisionsForImpact(
        store,
        '/projects/myapp',
        {
          filePath: 'src/some-unlinked-file.ts',
        },
        ['src/api/schema.ts', 'src/auth/provider.ts'],
      );
      expect(results.length).toBe(2);
    });

    it('deduplicates results', () => {
      const results = decisionsForImpact(
        store,
        '/projects/myapp',
        {
          symbolId: 'src/auth/provider.ts::AuthProvider#class',
          filePath: 'src/auth/provider.ts',
        },
        ['src/auth/provider.ts'],
      );
      expect(results.length).toBe(1); // same decision, not repeated
    });

    it('returns empty for no matches', () => {
      const results = decisionsForImpact(store, '/projects/myapp', {
        symbolId: 'nonexistent::symbol',
      });
      expect(results.length).toBe(0);
    });
  });

  describe('decisionsForTask', () => {
    it('finds decisions by task description FTS', () => {
      const results = decisionsForTask(
        store,
        '/projects/myapp',
        'migrate auth endpoints to GraphQL',
      );
      expect(results.length).toBeGreaterThanOrEqual(1);
      // Should find GraphQL migration and/or auth decisions
      const titles = results.map((r) => r.title);
      expect(titles.some((t) => t.includes('GraphQL') || t.includes('auth'))).toBe(true);
    });

    it('finds decisions from target files', () => {
      const results = decisionsForTask(store, '/projects/myapp', 'refactor database layer', [
        'src/db/connection.ts',
      ]);
      expect(results.some((r) => r.title === 'PostgreSQL for users DB')).toBe(true);
    });

    it('returns empty for unrelated task', () => {
      const results = decisionsForTask(store, '/projects/myapp', 'xyzzy foobar baz');
      expect(results.length).toBe(0);
    });
  });

  describe('decisionsForResume', () => {
    it('returns recent active decisions', () => {
      const results = decisionsForResume(store, '/projects/myapp', 5);
      expect(results.length).toBe(3); // 3 decisions for /projects/myapp
    });

    it('respects limit', () => {
      const results = decisionsForResume(store, '/projects/myapp', 2);
      expect(results.length).toBe(2);
    });

    it('filters by project', () => {
      const results = decisionsForResume(store, '/projects/other', 5);
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Rate limiting via Redis');
    });
  });
});
