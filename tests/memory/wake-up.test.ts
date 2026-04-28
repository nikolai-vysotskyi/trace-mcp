import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';
import { assembleWakeUp } from '../../src/memory/wake-up.js';

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
