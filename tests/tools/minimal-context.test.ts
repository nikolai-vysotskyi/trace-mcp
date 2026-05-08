/**
 * Tests for get_minimal_context — the single-call orientation tool that
 * routes follow-up suggestions based on the agent's stated task.
 *
 * The shape contract matters more than the exact numbers: agents read
 * `next_steps[*].tool` to pick the next call, so an accidental rename or
 * dropped suggestion silently degrades the orientation experience.
 */
import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import {
  getMinimalContext,
  inferTask,
  type MinimalContext,
} from '../../src/tools/project/minimal-context.js';
import type { TraceMcpConfig } from '../../src/config.js';
import type { ProjectContext } from '../../src/plugin-api/types.js';

function emptyConfig(): TraceMcpConfig {
  return {} as TraceMcpConfig;
}

function emptyCtx(): ProjectContext {
  return {
    rootPath: '/tmp/no-such',
    configFiles: [],
  };
}

function fixture() {
  const db = initializeDatabase(':memory:');
  const store = new Store(db);
  const registry = new PluginRegistry();
  return { db, store, registry };
}

describe('inferTask — keyword-based intent inference', () => {
  it.each([
    ['fix the auth bug in userService', 'debug'],
    ['review my pull request', 'review'],
    ['refactor the payment flow', 'refactor'],
    ['add a webhook endpoint', 'add_feature'],
    ['understand how the saga pattern is wired', undefined],
  ])('%s → %s', (input, expected) => {
    expect(inferTask(input)).toBe(expected);
  });

  it('returns undefined for missing input', () => {
    expect(inferTask(undefined)).toBeUndefined();
    expect(inferTask('')).toBeUndefined();
  });
});

describe('getMinimalContext — shape', () => {
  it('returns the documented top-level structure even on an empty repo', () => {
    const { store, registry } = fixture();
    const result = getMinimalContext(store, registry, emptyConfig(), '/tmp/empty', emptyCtx());
    expect(result).toMatchObject({
      project: { fileCount: 0, symbolCount: 0, frameworks: [] },
      health: { top_hotspots: [], top_central: [] },
      communities: { total: 0, top: [] },
    });
    expect(Array.isArray(result.next_steps)).toBe(true);
    expect(result.next_steps.length).toBeGreaterThan(0);
  });

  it('defaults to the "understand" suggestion set when no task is supplied', () => {
    const { store, registry } = fixture();
    const result = getMinimalContext(store, registry, emptyConfig(), '/tmp/empty', emptyCtx());
    const tools = result.next_steps.map((s) => s.tool);
    expect(tools).toContain('get_task_context');
    expect(tools).toContain('get_outline');
    expect(tools).toContain('search');
    expect(result._meta.task).toBeUndefined();
    expect(result._meta.intent_inferred).toBe(false);
  });

  it('routes "review" intent to compare_branches + scan_security', () => {
    const { store, registry } = fixture();
    const result = getMinimalContext(store, registry, emptyConfig(), '/tmp/empty', emptyCtx(), {
      intent: 'review',
    });
    const tools = result.next_steps.map((s) => s.tool);
    expect(tools).toContain('compare_branches');
    expect(tools).toContain('scan_security');
    expect(result._meta.task).toBe('review');
    expect(result._meta.intent_inferred).toBe(false);
  });

  it('infers debug intent from a free-text task and reports intent_inferred=true', () => {
    const { store, registry } = fixture();
    const result = getMinimalContext(store, registry, emptyConfig(), '/tmp/empty', emptyCtx(), {
      task: 'investigate why the checkout is broken on safari',
    });
    expect(result._meta.task).toBe('debug');
    expect(result._meta.intent_inferred).toBe(true);
    const tools = result.next_steps.map((s) => s.tool);
    expect(tools).toContain('predict_bugs');
    expect(tools).toContain('taint_analysis');
  });

  it('explicit intent wins over the task keyword', () => {
    const { store, registry } = fixture();
    const result = getMinimalContext(store, registry, emptyConfig(), '/tmp/empty', emptyCtx(), {
      task: 'fix the bug',
      intent: 'refactor',
    });
    expect(result._meta.task).toBe('refactor');
    expect(result._meta.intent_inferred).toBe(false);
    const tools = result.next_steps.map((s) => s.tool);
    expect(tools).toContain('plan_refactoring');
  });

  it('serialises under ~2KB for typical empty/small repos', () => {
    const { store, registry } = fixture();
    const result = getMinimalContext(store, registry, emptyConfig(), '/tmp/empty', emptyCtx());
    const json = JSON.stringify(result);
    // Loose bound — the point of the tool is "much smaller than full
    // get_project_map" — but a regression that doubles the size shows up here.
    expect(json.length).toBeLessThan(3000);
  });

  it('every next_step entry has tool + hint fields', () => {
    const { store, registry } = fixture();
    const all: NonNullable<MinimalContext['_meta']['task']>[] = [
      'understand',
      'review',
      'refactor',
      'debug',
      'add_feature',
    ];
    for (const intent of all) {
      const r = getMinimalContext(store, registry, emptyConfig(), '/tmp/x', emptyCtx(), {
        intent,
      });
      for (const step of r.next_steps) {
        expect(typeof step.tool).toBe('string');
        expect(step.tool.length).toBeGreaterThan(0);
        expect(typeof step.hint).toBe('string');
        expect(step.hint.length).toBeGreaterThan(0);
      }
    }
  });
});
