/**
 * TRA-1619 Finding A — memory FTS search must not crash on hyphenated /
 * operator-shaped user input.
 *
 * `searchSessions('trace-mcp')` threw `SqliteError: no such column: mcp`
 * because the raw query string was interpolated into FTS5 MATCH: `trace-mcp`
 * parses as an FTS5 expression, not a literal. The same raw-MATCH hazard
 * existed in `queryDecisions({ search })` and `listClusters({ search })`.
 *
 * Contract under test: every `search`/`query` argument on the memory
 * read-path is plain user text. It is escaped before MATCH, never throws,
 * and still matches content containing the literal terms.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';

describe('memory FTS escaping (TRA-1619A)', () => {
  let store: DecisionStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-fts-escape-'));
    store = new DecisionStore(path.join(tmpDir, 'decisions.db'));

    store.addSessionChunks([
      {
        session_id: 'sess-tm',
        project_root: '/projects/alpha',
        chunk_index: 0,
        role: 'assistant',
        content: 'Indexed the trace-mcp repo and re-ran the daemon smoke test.',
        timestamp: '2026-09-01T10:00:00Z',
      },
      {
        session_id: 'sess-wk',
        project_root: '/projects/alpha',
        chunk_index: 0,
        role: 'user',
        content: 'Hit a well-known flake in the auth middleware refresh path.',
        timestamp: '2026-09-02T10:00:00Z',
      },
    ]);

    const d1 = store.addDecision({
      title: 'Adopt trace-mcp for code navigation',
      content: 'We use trace-mcp as the code-intelligence backend for agents.',
      type: 'tech_choice',
      project_root: '/projects/alpha',
    });
    const d2 = store.addDecision({
      title: 'Fix the well-known auth flake',
      content: 'Root cause is JWT expiration leaking into the refresh path.',
      type: 'bug_root_cause',
      project_root: '/projects/alpha',
    });
    store.createCluster({
      project_root: '/projects/alpha',
      title: 'trace-mcp rollout',
      summary: 'Well-known issues found while adopting trace-mcp.',
      decision_ids: [d1.id, d2.id],
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('searchSessions', () => {
    it('does not throw on the product name "trace-mcp" and finds the chunk', () => {
      const rows = store.searchSessions('trace-mcp');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((r) => r.content.includes('trace-mcp'))).toBe(true);
    });

    it('does not throw on "well-known" and finds the chunk', () => {
      const rows = store.searchSessions('well-known');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((r) => r.content.includes('well-known'))).toBe(true);
    });

    it('does not throw on user-typed quotes, parens, colons, wildcards', () => {
      for (const q of [
        '"trace-mcp"',
        '(trace-mcp',
        'title:trace',
        'trace*',
        'trace-mcp re-index',
        'trace-mcp OR daemon',
      ]) {
        expect(() => store.searchSessions(q)).not.toThrow();
      }
    });

    it('returns [] instead of throwing when nothing searchable remains', () => {
      for (const q of ['OR', '***', '(((', '"']) {
        expect(store.searchSessions(q)).toEqual([]);
      }
    });
  });

  describe('queryDecisions search', () => {
    it('does not throw on "trace-mcp" and finds the decision', () => {
      const rows = store.queryDecisions({ project_root: '/projects/alpha', search: 'trace-mcp' });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((r) => `${r.title} ${r.content}`.includes('trace-mcp'))).toBe(true);
    });

    it('does not throw on operator-shaped input', () => {
      for (const q of ['"well-known" (flake)', 'title:trace', 'auth*', 'trace-mcp OR daemon']) {
        expect(() =>
          store.queryDecisions({ project_root: '/projects/alpha', search: q }),
        ).not.toThrow();
      }
    });

    it('returns [] instead of throwing when nothing searchable remains', () => {
      expect(store.queryDecisions({ project_root: '/projects/alpha', search: 'OR' })).toEqual([]);
    });
  });

  describe('listClusters search', () => {
    it('does not throw on "trace-mcp" and finds the cluster', () => {
      const rows = store.listClusters({ project_root: '/projects/alpha', search: 'trace-mcp' });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((c) => `${c.title} ${c.summary}`.includes('trace-mcp'))).toBe(true);
    });

    it('does not throw on operator-shaped input', () => {
      for (const q of ['"well-known" (rollout)', 'title:trace', 'OR']) {
        expect(() =>
          store.listClusters({ project_root: '/projects/alpha', search: q }),
        ).not.toThrow();
      }
    });
  });
});
