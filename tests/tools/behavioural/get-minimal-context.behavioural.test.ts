/**
 * Behavioural coverage for `getMinimalContext()` — the engine behind the
 * `get_minimal_context` MCP tool.
 *
 * IMPL NOTE: the MCP tool is inline-registered in `src/tools/register/core.ts`
 * and forwards directly to `getMinimalContext(store, registry, config,
 * projectRoot, projectCtx, opts)`. We assert the underlying function
 * (same approach as `get-env-vars.behavioural.test.ts`).
 *
 * Health / communities / hotspots aren't seeded — the function tolerates
 * empty graphs (try/catch around each enrichment) and we lean on that to
 * keep the test deterministic. We verify the envelope shape, task-routing,
 * and intent-override precedence.
 */
import { describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema, type TraceMcpConfig } from '../../../src/config.js';
import { PluginRegistry } from '../../../src/plugin-api/registry.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';
import { getMinimalContext } from '../../../src/tools/project/minimal-context.js';
import { createTestStore } from '../../test-utils.js';

const PROJECT_ROOT = '/projects/minimal-ctx-fixture';

function buildConfig(): TraceMcpConfig {
  const parsed = TraceMcpConfigSchema.safeParse({});
  if (!parsed.success) throw new Error('Failed to build default TraceMcpConfig');
  return parsed.data;
}

function buildProjectContext(): ProjectContext {
  return {
    rootPath: PROJECT_ROOT,
    detectedVersions: [],
    allDependencies: [],
    configFiles: [],
  };
}

describe('getMinimalContext() — behavioural contract', () => {
  it('returns the project / health / communities / next_steps envelope', () => {
    const store = createTestStore();
    const registry = new PluginRegistry();
    const config = buildConfig();
    const ctx = buildProjectContext();

    const result = getMinimalContext(store, registry, config, PROJECT_ROOT, ctx);

    expect(result.project).toBeTruthy();
    expect(typeof result.project.name).toBe('string');
    expect(typeof result.project.fileCount).toBe('number');
    expect(typeof result.project.symbolCount).toBe('number');
    expect(Array.isArray(result.project.frameworks)).toBe(true);

    expect(result.health).toBeTruthy();
    expect(Array.isArray(result.health.top_hotspots)).toBe(true);
    expect(Array.isArray(result.health.top_central)).toBe(true);

    expect(result.communities).toBeTruthy();
    expect(typeof result.communities.total).toBe('number');
    expect(Array.isArray(result.communities.top)).toBe(true);

    expect(Array.isArray(result.next_steps)).toBe(true);
    expect(result.next_steps.length).toBeGreaterThan(0);
    for (const step of result.next_steps) {
      expect(typeof step.tool).toBe('string');
      expect(typeof step.hint).toBe('string');
    }
  });

  it('task parameter varies next_steps content', () => {
    const store = createTestStore();
    const registry = new PluginRegistry();
    const config = buildConfig();
    const ctx = buildProjectContext();

    const review = getMinimalContext(store, registry, config, PROJECT_ROOT, ctx, {
      task: 'Please review this PR for the auth refactor',
    });
    const debug = getMinimalContext(store, registry, config, PROJECT_ROOT, ctx, {
      task: 'There is a bug in the login flow — investigate the regression',
    });

    expect(review._meta.task).toBe('review');
    expect(debug._meta.task).toBe('debug');
    expect(review._meta.intent_inferred).toBe(true);
    expect(debug._meta.intent_inferred).toBe(true);

    // The two routes pick different first-tool suggestions.
    expect(review.next_steps[0].tool).not.toBe(debug.next_steps[0].tool);

    // Review route surfaces compare_branches; debug route surfaces predict_bugs.
    expect(review.next_steps.map((s) => s.tool)).toContain('compare_branches');
    expect(debug.next_steps.map((s) => s.tool)).toContain('predict_bugs');
  });

  it('explicit intent override wins over inferred task', () => {
    const store = createTestStore();
    const registry = new PluginRegistry();
    const config = buildConfig();
    const ctx = buildProjectContext();

    // Task text suggests "debug" but intent forces "refactor".
    const result = getMinimalContext(store, registry, config, PROJECT_ROOT, ctx, {
      task: 'Fix the broken regression in the auth bug',
      intent: 'refactor',
    });
    expect(result._meta.task).toBe('refactor');
    expect(result._meta.intent_inferred).toBe(false);
    expect(result.next_steps.map((s) => s.tool)).toContain('assess_change_risk');
  });

  it('empty index produces a clear envelope with zero counts', () => {
    const store = createTestStore();
    const registry = new PluginRegistry();
    const config = buildConfig();
    const ctx = buildProjectContext();

    const result = getMinimalContext(store, registry, config, PROJECT_ROOT, ctx);
    expect(result.project.fileCount).toBe(0);
    expect(result.project.symbolCount).toBe(0);
    expect(result.health.top_hotspots).toEqual([]);
    expect(result.health.top_central).toEqual([]);
    expect(result.communities.total).toBe(0);
    expect(result.communities.top).toEqual([]);
    // No task / intent → default "understand" route, never inferred.
    expect(result._meta.task).toBeUndefined();
    expect(result._meta.intent_inferred).toBe(false);
    // "understand" route surfaces get_task_context.
    expect(result.next_steps.map((s) => s.tool)).toContain('get_task_context');
  });
});
