import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DecisionInput } from '../../src/memory/decision-store.js';
import { DecisionStore } from '../../src/memory/decision-store.js';

describe('DecisionStore', () => {
  let store: DecisionStore;
  let dbPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-db-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  const baseInput: DecisionInput = {
    title: 'Use PostgreSQL for auth service',
    content:
      'Chose PostgreSQL over MySQL because we need JSONB support for flexible user metadata.',
    type: 'tech_choice',
    project_root: '/projects/myapp',
    tags: ['database', 'auth'],
  };

  describe('addDecision', () => {
    it('creates a decision and returns it with an ID', () => {
      const decision = store.addDecision(baseInput);
      expect(decision.id).toBeGreaterThan(0);
      expect(decision.title).toBe('Use PostgreSQL for auth service');
      expect(decision.type).toBe('tech_choice');
      expect(decision.source).toBe('manual');
      expect(decision.confidence).toBe(1.0);
      expect(decision.valid_until).toBeNull();
    });

    it('links to symbol and file', () => {
      const decision = store.addDecision({
        ...baseInput,
        symbol_id: 'src/auth/provider.ts::AuthProvider#class',
        file_path: 'src/auth/provider.ts',
      });
      expect(decision.symbol_id).toBe('src/auth/provider.ts::AuthProvider#class');
      expect(decision.file_path).toBe('src/auth/provider.ts');
    });

    it('stores tags as JSON', () => {
      const decision = store.addDecision(baseInput);
      expect(JSON.parse(decision.tags!)).toEqual(['database', 'auth']);
    });
  });

  describe('addDecisions (batch)', () => {
    it('adds multiple decisions in a transaction', () => {
      const inputs: DecisionInput[] = [
        { ...baseInput, title: 'Decision 1' },
        { ...baseInput, title: 'Decision 2' },
        { ...baseInput, title: 'Decision 3' },
      ];
      const count = store.addDecisions(inputs);
      expect(count).toBe(3);
    });
  });

  describe('getDecision', () => {
    it('returns undefined for non-existent ID', () => {
      expect(store.getDecision(999)).toBeUndefined();
    });

    it('retrieves by ID', () => {
      const added = store.addDecision(baseInput);
      const got = store.getDecision(added.id);
      expect(got).toBeDefined();
      expect(got!.title).toBe(baseInput.title);
    });
  });

  describe('invalidateDecision', () => {
    it('sets valid_until on an active decision', () => {
      const d = store.addDecision(baseInput);
      expect(d.valid_until).toBeNull();

      const ok = store.invalidateDecision(d.id);
      expect(ok).toBe(true);

      const updated = store.getDecision(d.id);
      expect(updated!.valid_until).not.toBeNull();
    });

    it('returns false for already-invalidated decision', () => {
      const d = store.addDecision(baseInput);
      store.invalidateDecision(d.id);
      const ok = store.invalidateDecision(d.id);
      expect(ok).toBe(false);
    });

    it('returns false for non-existent decision', () => {
      expect(store.invalidateDecision(999)).toBe(false);
    });
  });

  describe('deleteDecision', () => {
    it('removes a decision', () => {
      const d = store.addDecision(baseInput);
      expect(store.deleteDecision(d.id)).toBe(true);
      expect(store.getDecision(d.id)).toBeUndefined();
    });
  });

  describe('queryDecisions', () => {
    beforeEach(() => {
      store.addDecision({ ...baseInput, title: 'Choice A', type: 'tech_choice' });
      store.addDecision({
        ...baseInput,
        title: 'Bug B',
        type: 'bug_root_cause',
        tags: ['performance'],
      });
      store.addDecision({
        ...baseInput,
        title: 'Arch C',
        type: 'architecture_decision',
        symbol_id: 'src/auth.ts::Auth#class',
      });
    });

    it('returns all decisions when no filter', () => {
      const results = store.queryDecisions({ project_root: '/projects/myapp' });
      expect(results.length).toBe(3);
    });

    it('filters by type', () => {
      const results = store.queryDecisions({
        project_root: '/projects/myapp',
        type: 'bug_root_cause',
      });
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Bug B');
    });

    it('filters by symbol_id', () => {
      const results = store.queryDecisions({
        project_root: '/projects/myapp',
        symbol_id: 'src/auth.ts::Auth#class',
      });
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Arch C');
    });

    it('filters by tag', () => {
      const results = store.queryDecisions({ project_root: '/projects/myapp', tag: 'performance' });
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Bug B');
    });

    it('excludes invalidated by default', () => {
      const all = store.queryDecisions({ project_root: '/projects/myapp' });
      const first = all[0];
      store.invalidateDecision(first.id);
      const after = store.queryDecisions({ project_root: '/projects/myapp' });
      expect(after.length).toBe(2);
    });

    it('includes invalidated when requested', () => {
      const all = store.queryDecisions({ project_root: '/projects/myapp' });
      store.invalidateDecision(all[0].id);
      const withInvalidated = store.queryDecisions({
        project_root: '/projects/myapp',
        include_invalidated: true,
      });
      expect(withInvalidated.length).toBe(3);
    });

    it('full-text search works', () => {
      store.addDecision({
        ...baseInput,
        title: 'GraphQL migration',
        content: 'We are migrating from REST to GraphQL for better developer experience.',
        project_root: '/projects/myapp',
      });
      const results = store.queryDecisions({
        project_root: '/projects/myapp',
        search: 'GraphQL migration',
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.title === 'GraphQL migration')).toBe(true);
    });

    it('respects limit', () => {
      const results = store.queryDecisions({ project_root: '/projects/myapp', limit: 2 });
      expect(results.length).toBe(2);
    });
  });

  describe('getTimeline', () => {
    it('returns chronological timeline', () => {
      store.addDecision({ ...baseInput, title: 'First', valid_from: '2025-01-01T00:00:00Z' });
      store.addDecision({ ...baseInput, title: 'Second', valid_from: '2025-06-01T00:00:00Z' });
      store.addDecision({ ...baseInput, title: 'Third', valid_from: '2026-01-01T00:00:00Z' });

      const timeline = store.getTimeline({ project_root: '/projects/myapp' });
      expect(timeline.length).toBe(3);
      expect(timeline[0].title).toBe('First');
      expect(timeline[2].title).toBe('Third');
      expect(timeline[0].is_active).toBe(1);
    });

    it('filters by symbol', () => {
      store.addDecision({ ...baseInput, title: 'Linked', symbol_id: 'sym::A#func' });
      store.addDecision({ ...baseInput, title: 'Unlinked' });

      const timeline = store.getTimeline({ symbol_id: 'sym::A#func' });
      expect(timeline.length).toBe(1);
      expect(timeline[0].title).toBe('Linked');
    });
  });

  describe('getStats', () => {
    it('returns correct breakdown', () => {
      store.addDecision({ ...baseInput, title: 'A', type: 'tech_choice', source: 'manual' });
      store.addDecision({ ...baseInput, title: 'B', type: 'bug_root_cause', source: 'mined' });
      const d = store.addDecision({
        ...baseInput,
        title: 'C',
        type: 'tech_choice',
        source: 'mined',
      });
      store.invalidateDecision(d.id);

      const stats = store.getStats('/projects/myapp');
      expect(stats.total).toBe(3);
      expect(stats.active).toBe(2);
      expect(stats.invalidated).toBe(1);
      expect(stats.by_type.tech_choice).toBe(2);
      expect(stats.by_type.bug_root_cause).toBe(1);
      expect(stats.by_source.manual).toBe(1);
      expect(stats.by_source.mined).toBe(2);
    });
  });

  describe('mined sessions tracking', () => {
    it('tracks mined sessions', () => {
      expect(store.isSessionMined('/path/to/session.jsonl')).toBe(false);
      store.markSessionMined('/path/to/session.jsonl', 5);
      expect(store.isSessionMined('/path/to/session.jsonl')).toBe(true);
      expect(store.getMinedSessionCount()).toBe(1);
    });
  });

  describe('code-aware queries', () => {
    beforeEach(() => {
      store.addDecision({
        ...baseInput,
        title: 'Auth decision',
        symbol_id: 'src/auth.ts::Auth#class',
        file_path: 'src/auth.ts',
      });
      store.addDecision({
        ...baseInput,
        title: 'DB decision',
        symbol_id: 'src/db.ts::Pool#class',
        file_path: 'src/db.ts',
      });
      store.addDecision({ ...baseInput, title: 'Auth config', file_path: 'src/auth/config.ts' });
    });

    it('getDecisionsForSymbol returns linked decisions', () => {
      const results = store.getDecisionsForSymbol('src/auth.ts::Auth#class');
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Auth decision');
    });

    it('getDecisionsForFile returns linked decisions', () => {
      const results = store.getDecisionsForFile('src/auth.ts');
      expect(results.length).toBe(1);
    });

    it('getDecisionsForPath matches patterns', () => {
      const results = store.getDecisionsForPath('src/auth%');
      expect(results.length).toBe(2); // auth.ts and auth/config.ts
    });
  });

  describe('subproject support', () => {
    it('stores and queries by service_name', () => {
      store.addDecision({ ...baseInput, title: 'Auth uses JWT', service_name: 'auth-api' });
      store.addDecision({
        ...baseInput,
        title: 'Users DB is Postgres',
        service_name: 'user-service',
      });
      store.addDecision({ ...baseInput, title: 'Global rate limit' }); // no service

      const authDecisions = store.queryDecisions({
        project_root: '/projects/myapp',
        service_name: 'auth-api',
      });
      expect(authDecisions.length).toBe(1);
      expect(authDecisions[0].title).toBe('Auth uses JWT');
    });

    it('getDecisionsForService returns service-scoped decisions', () => {
      store.addDecision({ ...baseInput, title: 'Auth decision', service_name: 'auth-api' });
      store.addDecision({ ...baseInput, title: 'User decision', service_name: 'user-service' });

      const results = store.getDecisionsForService('auth-api', '/projects/myapp');
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Auth decision');
    });

    it('getServiceNames returns distinct names', () => {
      store.addDecision({ ...baseInput, title: 'A', service_name: 'auth-api' });
      store.addDecision({ ...baseInput, title: 'B', service_name: 'user-service' });
      store.addDecision({ ...baseInput, title: 'C', service_name: 'auth-api' });
      store.addDecision({ ...baseInput, title: 'D' }); // no service

      const names = store.getServiceNames('/projects/myapp');
      expect(names.sort()).toEqual(['auth-api', 'user-service']);
    });
  });

  describe('session chunks', () => {
    it('adds and searches session chunks', () => {
      const chunks = [
        {
          session_id: 'sess-001',
          project_root: '/projects/myapp',
          chunk_index: 0,
          role: 'user' as const,
          content: 'Why did we switch from MySQL to PostgreSQL for the auth service?',
          timestamp: '2025-06-01T10:00:00Z',
        },
        {
          session_id: 'sess-001',
          project_root: '/projects/myapp',
          chunk_index: 1,
          role: 'assistant' as const,
          content:
            'We switched to PostgreSQL because MySQL lacked JSONB support needed for flexible user metadata storage. The decision was made in January after evaluating both options.',
          timestamp: '2025-06-01T10:00:05Z',
          referenced_files: ['src/auth/db.ts', 'src/auth/user-model.ts'],
        },
        {
          session_id: 'sess-002',
          project_root: '/projects/myapp',
          chunk_index: 0,
          role: 'assistant' as const,
          content:
            'The GraphQL migration is progressing well. We have moved all REST endpoints to GraphQL resolvers.',
          timestamp: '2025-06-02T14:00:00Z',
        },
      ];

      const added = store.addSessionChunks(chunks);
      expect(added).toBe(3);

      // Search for PostgreSQL discussion
      const results = store.searchSessions('PostgreSQL MySQL', { project_root: '/projects/myapp' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.content.includes('PostgreSQL'))).toBe(true);

      // Search for GraphQL
      const gqlResults = store.searchSessions('GraphQL migration', {
        project_root: '/projects/myapp',
      });
      expect(gqlResults.length).toBeGreaterThanOrEqual(1);
    });

    it('skips duplicate chunks (same session_id + chunk_index)', () => {
      const chunk = {
        session_id: 'sess-dup',
        project_root: '/projects/myapp',
        chunk_index: 0,
        role: 'user' as const,
        content: 'Test deduplication of session chunks.',
        timestamp: '2025-06-01T10:00:00Z',
      };

      expect(store.addSessionChunks([chunk])).toBe(1);
      expect(store.addSessionChunks([chunk])).toBe(0); // ignored duplicate
    });

    it('tracks indexed sessions', () => {
      expect(store.isSessionIndexed('sess-new')).toBe(false);

      store.addSessionChunks([
        {
          session_id: 'sess-new',
          project_root: '/projects/myapp',
          chunk_index: 0,
          role: 'user' as const,
          content: 'Some content for indexing test.',
          timestamp: '2025-06-01T10:00:00Z',
        },
      ]);

      expect(store.isSessionIndexed('sess-new')).toBe(true);
      expect(store.getSessionChunkCount('/projects/myapp')).toBe(1);
      expect(store.getIndexedSessionIds('/projects/myapp')).toContain('sess-new');
    });

    it('filters search by project_root', () => {
      store.addSessionChunks([
        {
          session_id: 'sess-proj-a',
          project_root: '/projects/alpha',
          chunk_index: 0,
          role: 'assistant' as const,
          content: 'Redis cache implementation for alpha project.',
          timestamp: '2025-06-01T10:00:00Z',
        },
        {
          session_id: 'sess-proj-b',
          project_root: '/projects/beta',
          chunk_index: 0,
          role: 'assistant' as const,
          content: 'Redis cache implementation for beta project.',
          timestamp: '2025-06-01T10:00:00Z',
        },
      ]);

      const alphaResults = store.searchSessions('Redis cache', { project_root: '/projects/alpha' });
      expect(alphaResults.length).toBe(1);
      expect(alphaResults[0].session_id).toBe('sess-proj-a');
    });
  });
});
