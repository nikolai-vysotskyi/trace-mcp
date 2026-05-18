import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';
import { assembleWakeUp, assembleWakeUpSplit } from '../../src/memory/wake-up.js';

describe('assembleWakeUp', () => {
  let store: DecisionStore;
  let dbPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeup-test-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('returns empty wake-up for new project', () => {
    const ctx = assembleWakeUp(store, '/projects/new');
    expect(ctx.project.name).toBe('new');
    expect(ctx.decisions.total_active).toBe(0);
    expect(ctx.decisions.recent).toHaveLength(0);
    expect(ctx.memory.total_decisions).toBe(0);
    expect(ctx.estimated_tokens).toBeGreaterThan(0);
  });

  it('includes active decisions in wake-up', () => {
    store.addDecision({
      title: 'Use PostgreSQL',
      content: 'Chose PostgreSQL for JSONB support.',
      type: 'tech_choice',
      project_root: '/projects/myapp',
      symbol_id: 'src/db.ts::Pool#class',
      file_path: 'src/db.ts',
      tags: ['database'],
    });
    store.addDecision({
      title: 'GraphQL over REST',
      content: 'Switched to GraphQL for flexible queries.',
      type: 'architecture_decision',
      project_root: '/projects/myapp',
      tags: ['api'],
    });

    const ctx = assembleWakeUp(store, '/projects/myapp');
    expect(ctx.decisions.total_active).toBe(2);
    expect(ctx.decisions.recent).toHaveLength(2);
    expect(ctx.decisions.recent.some((d) => d.title === 'Use PostgreSQL')).toBe(true);
    expect(ctx.decisions.recent.find((d) => d.title === 'Use PostgreSQL')?.symbol).toBe(
      'src/db.ts::Pool#class',
    );
    expect(ctx.decisions.recent.find((d) => d.title === 'Use PostgreSQL')?.file).toBe('src/db.ts');
  });

  it('excludes invalidated decisions from wake-up', () => {
    const d = store.addDecision({
      title: 'Use MySQL (old)',
      content: 'Original choice.',
      type: 'tech_choice',
      project_root: '/projects/myapp',
    });
    store.addDecision({
      title: 'Use PostgreSQL (new)',
      content: 'Replacement choice.',
      type: 'tech_choice',
      project_root: '/projects/myapp',
    });
    store.invalidateDecision(d.id);

    const ctx = assembleWakeUp(store, '/projects/myapp');
    expect(ctx.decisions.total_active).toBe(1);
    expect(ctx.decisions.recent).toHaveLength(1);
    expect(ctx.decisions.recent[0].title).toBe('Use PostgreSQL (new)');
  });

  it('respects maxDecisions', () => {
    for (let i = 0; i < 20; i++) {
      store.addDecision({
        title: `Decision ${i}`,
        content: `Content ${i}`,
        type: 'tech_choice',
        project_root: '/projects/myapp',
      });
    }

    const ctx = assembleWakeUp(store, '/projects/myapp', { maxDecisions: 5 });
    expect(ctx.decisions.recent).toHaveLength(5);
    expect(ctx.decisions.total_active).toBe(20);
  });

  it('includes memory stats', () => {
    store.addDecision({
      title: 'Test',
      content: 'Test content.',
      type: 'tech_choice',
      project_root: '/projects/myapp',
      source: 'mined',
    });
    store.markSessionMined('/fake/session.jsonl', 1);
    store.addSessionChunks([
      {
        session_id: 'sess-1',
        project_root: '/projects/myapp',
        chunk_index: 0,
        role: 'user',
        content: 'Some session content here.',
        timestamp: '2025-06-01T10:00:00Z',
      },
    ]);

    const ctx = assembleWakeUp(store, '/projects/myapp');
    expect(ctx.memory.total_decisions).toBe(1);
    expect(ctx.memory.sessions_mined).toBe(1);
    expect(ctx.memory.sessions_indexed).toBe(1);
    expect(ctx.memory.by_type.tech_choice).toBe(1);
  });

  it('produces compact output (~300 tokens)', () => {
    for (let i = 0; i < 10; i++) {
      store.addDecision({
        title: `Decision ${i}`,
        content: `Short content for decision ${i}.`,
        type: 'tech_choice',
        project_root: '/projects/myapp',
      });
    }

    const ctx = assembleWakeUp(store, '/projects/myapp');
    // Should stay under ~500 tokens for 10 decisions
    expect(ctx.estimated_tokens).toBeLessThan(500);
  });
});

describe('assembleWakeUpSplit', () => {
  let store: DecisionStore;
  let dbPath: string;
  const projectRoot = '/projects/split-app';

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeup-split-test-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('returns the split shape with cache hint for an empty project', () => {
    const out = assembleWakeUpSplit(store, projectRoot);
    expect(out.stable.project.name).toBe('split-app');
    expect(out.stable.project.root).toBe(projectRoot);
    expect(out.stable.conventions).toEqual([]);
    expect(out.stable.architecture).toEqual([]);
    expect(out.stable.stats.total_active).toBe(0);
    expect(out.dynamic.recent_decisions).toEqual([]);
    expect(out.dynamic.in_progress).toEqual([]);
    expect(out._cache_hint.inject_stable_into).toBe('system_prompt');
    expect(out._cache_hint.inject_dynamic_into).toBe('user_message');
    expect(out._cache_hint.rationale).toContain('system-prompt cache');
    expect(out.estimated_tokens).toBeGreaterThan(0);
  });

  it('routes conventions into stable.conventions only (no leak into dynamic)', () => {
    store.addDecision({
      title: 'Prefer pnpm',
      content: 'pnpm is the package manager.',
      type: 'convention',
      project_root: projectRoot,
    });
    store.addDecision({
      title: 'English-only strings',
      content: 'All user-facing strings must be English.',
      type: 'convention',
      project_root: projectRoot,
    });

    const out = assembleWakeUpSplit(store, projectRoot);
    expect(out.stable.conventions).toHaveLength(2);
    expect(out.stable.conventions.every((d) => d.type === 'convention')).toBe(true);
    expect(out.dynamic.recent_decisions).toHaveLength(0);
  });

  it('routes architecture_decision into stable.architecture only', () => {
    store.addDecision({
      title: 'Use PostgreSQL',
      content: 'JSONB support needed.',
      type: 'architecture_decision',
      project_root: projectRoot,
    });
    const out = assembleWakeUpSplit(store, projectRoot);
    expect(out.stable.architecture).toHaveLength(1);
    expect(out.stable.architecture[0].type).toBe('architecture_decision');
    expect(out.dynamic.recent_decisions).toHaveLength(0);
  });

  it('places non-stable, non-in-progress types into dynamic.recent_decisions', () => {
    store.addDecision({
      title: 'Switch to fastify',
      content: 'Better perf than express for our hot path.',
      type: 'tech_choice',
      project_root: projectRoot,
    });
    const out = assembleWakeUpSplit(store, projectRoot);
    expect(out.dynamic.recent_decisions).toHaveLength(1);
    expect(out.dynamic.recent_decisions[0].title).toBe('Switch to fastify');
    expect(out.stable.conventions).toHaveLength(0);
    expect(out.stable.architecture).toHaveLength(0);
  });

  it('deduplicates: items in stable do not appear in dynamic.recent_decisions', () => {
    // Conventions and architecture get returned by the recent-pool query too;
    // the split must filter them out so each decision lands in exactly one bucket.
    for (let i = 0; i < 3; i++) {
      store.addDecision({
        title: `Convention ${i}`,
        content: 'c',
        type: 'convention',
        project_root: projectRoot,
      });
    }
    for (let i = 0; i < 3; i++) {
      store.addDecision({
        title: `Arch ${i}`,
        content: 'a',
        type: 'architecture_decision',
        project_root: projectRoot,
      });
    }
    for (let i = 0; i < 3; i++) {
      store.addDecision({
        title: `Choice ${i}`,
        content: 'pick',
        type: 'tech_choice',
        project_root: projectRoot,
      });
    }

    const out = assembleWakeUpSplit(store, projectRoot);
    const stableIds = new Set<number>([
      ...out.stable.conventions.map((d) => d.id),
      ...out.stable.architecture.map((d) => d.id),
    ]);
    const recentIds = out.dynamic.recent_decisions.map((d) => d.id);
    for (const id of recentIds) {
      expect(stableIds.has(id)).toBe(false);
    }
    // Only tech_choice rows should appear in recent_decisions for this fixture.
    expect(out.dynamic.recent_decisions.every((d) => d.type === 'tech_choice')).toBe(true);
  });

  it('does not duplicate in_progress items inside recent_decisions', () => {
    // Discovery / tradeoff land in in_progress; they must not also show up in
    // recent_decisions, which would double-count them in the dynamic region.
    store.addDecision({
      title: 'Pick a JSON parser',
      content: 'k',
      type: 'tech_choice',
      project_root: projectRoot,
    });
    store.addDecision({
      title: 'Cache pollution discovered',
      content: 'd',
      type: 'discovery',
      project_root: projectRoot,
    });
    store.addDecision({
      title: 'Tradeoff: memory vs CPU',
      content: 't',
      type: 'tradeoff',
      project_root: projectRoot,
    });

    const out = assembleWakeUpSplit(store, projectRoot);
    const inProgressIds = new Set(out.dynamic.in_progress.map((d) => d.id));
    for (const r of out.dynamic.recent_decisions) {
      expect(inProgressIds.has(r.id)).toBe(false);
    }
  });

  it('places fresh discovery/tradeoff/bug_root_cause into dynamic.in_progress', () => {
    store.addDecision({
      title: 'Found leak in worker pool',
      content: 'Pool ref keeps growing.',
      type: 'discovery',
      project_root: projectRoot,
    });
    store.addDecision({
      title: 'Speed vs accuracy on PageRank',
      content: 'Trading some precision for latency.',
      type: 'tradeoff',
      project_root: projectRoot,
    });
    store.addDecision({
      title: 'CSRF token regen race',
      content: 'Two writers, lost update.',
      type: 'bug_root_cause',
      project_root: projectRoot,
    });

    const out = assembleWakeUpSplit(store, projectRoot);
    expect(out.dynamic.in_progress).toHaveLength(3);
    const titles = out.dynamic.in_progress.map((d) => d.title);
    expect(titles).toContain('Found leak in worker pool');
    expect(titles).toContain('Speed vs accuracy on PageRank');
    expect(titles).toContain('CSRF token regen race');
  });

  it('caps each section by item count', () => {
    for (let i = 0; i < 20; i++) {
      store.addDecision({
        title: `Conv ${i}`,
        content: 'c',
        type: 'convention',
        project_root: projectRoot,
      });
    }
    for (let i = 0; i < 20; i++) {
      store.addDecision({
        title: `Arch ${i}`,
        content: 'a',
        type: 'architecture_decision',
        project_root: projectRoot,
      });
    }
    for (let i = 0; i < 20; i++) {
      store.addDecision({
        title: `Disc ${i}`,
        content: 'd',
        type: 'discovery',
        project_root: projectRoot,
      });
    }
    for (let i = 0; i < 20; i++) {
      store.addDecision({
        title: `Pick ${i}`,
        content: 'p',
        type: 'tech_choice',
        project_root: projectRoot,
      });
    }

    const out = assembleWakeUpSplit(store, projectRoot);
    expect(out.stable.conventions.length).toBeLessThanOrEqual(5);
    expect(out.stable.architecture.length).toBeLessThanOrEqual(5);
    expect(out.dynamic.recent_decisions.length).toBeLessThanOrEqual(5);
    expect(out.dynamic.in_progress.length).toBeLessThanOrEqual(5);
  });

  it('respects maxRecent for the recent_decisions cap', () => {
    for (let i = 0; i < 10; i++) {
      store.addDecision({
        title: `Pick ${i}`,
        content: 'p',
        type: 'tech_choice',
        project_root: projectRoot,
      });
    }
    const out = assembleWakeUpSplit(store, projectRoot, { maxRecent: 3 });
    expect(out.dynamic.recent_decisions).toHaveLength(3);
  });

  it('reports stable.stats counts that match assembleWakeUp', () => {
    store.addDecision({
      title: 'A',
      content: 'a',
      type: 'tech_choice',
      project_root: projectRoot,
    });
    store.addDecision({
      title: 'B',
      content: 'b',
      type: 'convention',
      project_root: projectRoot,
    });
    store.markSessionMined('/fake/s1.jsonl', 1);
    store.addSessionChunks([
      {
        session_id: 'sess-x',
        project_root: projectRoot,
        chunk_index: 0,
        role: 'user',
        content: 'hi',
        timestamp: '2025-06-01T10:00:00Z',
      },
    ]);

    const flat = assembleWakeUp(store, projectRoot);
    const split = assembleWakeUpSplit(store, projectRoot);
    expect(split.stable.stats.total_active).toBe(flat.decisions.total_active);
    expect(split.stable.stats.total_decisions).toBe(flat.memory.total_decisions);
    expect(split.stable.stats.sessions_mined).toBe(flat.memory.sessions_mined);
    expect(split.stable.stats.sessions_indexed).toBe(flat.memory.sessions_indexed);
    expect(split.stable.stats.by_type).toEqual(flat.memory.by_type);
  });

  it('leaves the legacy assembleWakeUp shape untouched', () => {
    store.addDecision({
      title: 'X',
      content: 'x',
      type: 'tech_choice',
      project_root: projectRoot,
    });
    const flat = assembleWakeUp(store, projectRoot);
    // Spot-check the legacy keys still exist exactly where they did.
    expect(flat.project.name).toBe('split-app');
    expect(flat.decisions.total_active).toBe(1);
    expect(flat.decisions.recent[0].title).toBe('X');
    expect(flat.memory.total_decisions).toBe(1);
    // The split-only key must not have leaked into the flat shape.
    expect((flat as unknown as Record<string, unknown>)._cache_hint).toBeUndefined();
  });

  describe('heat-aware dynamic ordering', () => {
    it('orders recent_decisions by heat when heatEnabled=true', () => {
      const a = store.addDecision({
        title: 'A',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
        valid_from: '2026-01-01T00:00:00.000Z',
      });
      const b = store.addDecision({
        title: 'B',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
        valid_from: '2026-02-01T00:00:00.000Z',
      });
      const c = store.addDecision({
        title: 'C',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
        valid_from: '2026-03-01T00:00:00.000Z',
      });
      // Make B clearly hot.
      for (let i = 0; i < 8; i++) store.recordHits([b.id]);

      const heated = assembleWakeUpSplit(store, projectRoot, { heatEnabled: true });
      expect(heated.dynamic.recent_decisions[0].id).toBe(b.id);

      const plain = assembleWakeUpSplit(store, projectRoot, { heatEnabled: false });
      // Without heat, ordering remains valid_from DESC → [C, B, A].
      expect(plain.dynamic.recent_decisions.map((d) => d.id)).toEqual([c.id, b.id, a.id]);
    });

    it('does not reorder stable.conventions / stable.architecture by heat', () => {
      const conv1 = store.addDecision({
        title: 'Conv 1',
        content: 'c',
        type: 'convention',
        project_root: projectRoot,
        valid_from: '2026-01-01T00:00:00.000Z',
      });
      const conv2 = store.addDecision({
        title: 'Conv 2',
        content: 'c',
        type: 'convention',
        project_root: projectRoot,
        valid_from: '2026-02-01T00:00:00.000Z',
      });
      // Make conv1 hotter than conv2 — stable should still surface conv2 first
      // (newer valid_from), proving stable is NOT heat-reordered.
      for (let i = 0; i < 10; i++) store.recordHits([conv1.id]);

      const out = assembleWakeUpSplit(store, projectRoot, { heatEnabled: true });
      expect(out.stable.conventions.map((d) => d.id)).toEqual([conv2.id, conv1.id]);
    });
  });
});
