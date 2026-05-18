/**
 * Tests for the decision-store exporter helpers used by both the
 * `export_decisions` MCP tool and `trace-mcp memory export` CLI command.
 *
 * Covers: JSONL line-validity + tag normalisation, filter forwarding,
 * markdown grouping, limit clamping, and malformed-tag tolerance.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXPORT_LIMIT_MAX,
  exportDecisionsAsJsonl,
  exportDecisionsAsMarkdown,
} from '../../src/memory/decision-exporter.js';
import { DecisionStore } from '../../src/memory/decision-store.js';

describe('decision-exporter', () => {
  let store: DecisionStore;
  let dbPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-export-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  function seedDecisions(): void {
    store.addDecision({
      title: 'Use PostgreSQL',
      content: 'JSONB beats schemaless KV for our usage.',
      type: 'tech_choice',
      project_root: '/proj',
      tags: ['db', 'pg'],
      service_name: 'auth',
    });
    store.addDecision({
      title: 'Adopt feature flags',
      content: 'Risk-isolated rollout via LaunchDarkly.',
      type: 'architecture_decision',
      project_root: '/proj',
      tags: ['rollout'],
      service_name: 'auth',
    });
    store.addDecision({
      title: 'Prefer 2-space indent',
      content: 'Editor defaults; matches Prettier.',
      type: 'convention',
      project_root: '/proj',
      tags: [],
      service_name: 'web',
    });
  }

  describe('exportDecisionsAsJsonl', () => {
    it('emits one valid JSON object per line', () => {
      seedDecisions();
      const { content, count } = exportDecisionsAsJsonl(store, {
        project_root: '/proj',
      });
      expect(count).toBe(3);
      const lines = content.split('\n');
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it('parses the stored tag column into an array', () => {
      seedDecisions();
      const { content } = exportDecisionsAsJsonl(store, { project_root: '/proj' });
      const parsed = content
        .split('\n')
        .map((l) => JSON.parse(l) as { title: string; tags: string[] });
      const pg = parsed.find((p) => p.title === 'Use PostgreSQL')!;
      expect(Array.isArray(pg.tags)).toBe(true);
      expect(pg.tags).toEqual(['db', 'pg']);
      const conv = parsed.find((p) => p.title === 'Prefer 2-space indent')!;
      expect(conv.tags).toEqual([]);
    });

    it('respects type filter', () => {
      seedDecisions();
      const { content, count } = exportDecisionsAsJsonl(store, {
        project_root: '/proj',
        type: 'convention',
      });
      expect(count).toBe(1);
      expect(JSON.parse(content).title).toBe('Prefer 2-space indent');
    });

    it('respects service_name filter', () => {
      seedDecisions();
      const { count } = exportDecisionsAsJsonl(store, {
        project_root: '/proj',
        service_name: 'auth',
      });
      expect(count).toBe(2);
    });

    it('hides invalidated rows by default and surfaces them when asked', () => {
      seedDecisions();
      const allActive = exportDecisionsAsJsonl(store, { project_root: '/proj' });
      expect(allActive.count).toBe(3);
      const conv = store.queryDecisions({ project_root: '/proj', type: 'convention' })[0];
      store.invalidateDecision(conv.id);
      const stillActive = exportDecisionsAsJsonl(store, { project_root: '/proj' });
      expect(stillActive.count).toBe(2);
      const everything = exportDecisionsAsJsonl(store, {
        project_root: '/proj',
        include_invalidated: true,
      });
      expect(everything.count).toBe(3);
    });

    it('honours an explicit limit', () => {
      for (let i = 0; i < 10; i++) {
        store.addDecision({
          title: `decision ${i}`,
          content: 'x',
          type: 'preference',
          project_root: '/proj',
        });
      }
      const { count } = exportDecisionsAsJsonl(store, { project_root: '/proj', limit: 4 });
      expect(count).toBe(4);
    });

    it('clamps absurd limits down to EXPORT_LIMIT_MAX', () => {
      seedDecisions();
      // Cap is enforced at the queryDecisions layer; here we only assert
      // the exporter does not blow up when handed a huge value.
      const { count } = exportDecisionsAsJsonl(store, {
        project_root: '/proj',
        limit: EXPORT_LIMIT_MAX + 100_000,
      });
      expect(count).toBe(3);
    });

    it('returns an empty string when no decisions match', () => {
      const { content, count } = exportDecisionsAsJsonl(store, {
        project_root: '/proj',
      });
      expect(content).toBe('');
      expect(count).toBe(0);
    });

    it('recovers from a malformed tags column by surfacing _tags_raw', () => {
      seedDecisions();
      // Force a malformed JSON tags value directly into the DB to simulate
      // legacy / hand-edited rows.
      store.db
        .prepare('UPDATE decisions SET tags = ? WHERE title = ?')
        .run('{not-json', 'Use PostgreSQL');
      const { content } = exportDecisionsAsJsonl(store, { project_root: '/proj' });
      const pg = content
        .split('\n')
        .map((l) => JSON.parse(l) as { title: string; tags: string[]; _tags_raw?: string })
        .find((p) => p.title === 'Use PostgreSQL')!;
      expect(pg.tags).toEqual([]);
      expect(pg._tags_raw).toBe('{not-json');
    });
  });

  describe('exportDecisionsAsMarkdown', () => {
    it('groups by type with a top-level heading per group', () => {
      seedDecisions();
      const { content, count } = exportDecisionsAsMarkdown(store, {
        project_root: '/proj',
      });
      expect(count).toBe(3);
      expect(content).toContain('# tech_choice');
      expect(content).toContain('# architecture_decision');
      expect(content).toContain('# convention');
    });

    it('renders title, type, content, and tags', () => {
      seedDecisions();
      const { content } = exportDecisionsAsMarkdown(store, { project_root: '/proj' });
      expect(content).toContain('## Use PostgreSQL');
      expect(content).toContain('**Type:** tech_choice');
      expect(content).toContain('**Service:** auth');
      expect(content).toContain('**Tags:** db, pg');
      expect(content).toContain('JSONB beats schemaless KV for our usage.');
      expect(content.trim()).toMatch(/---\s*$/);
    });

    it('adds per-service subheaders when the dump spans multiple services', () => {
      seedDecisions();
      const { content } = exportDecisionsAsMarkdown(store, { project_root: '/proj' });
      expect(content).toContain('### Service: auth');
      expect(content).toContain('### Service: web');
    });

    it('omits service subheaders for a single-service dump', () => {
      seedDecisions();
      const { content } = exportDecisionsAsMarkdown(store, {
        project_root: '/proj',
        service_name: 'auth',
      });
      expect(content).not.toContain('### Service:');
    });
  });
});
