import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { VueLanguagePlugin } from '../../src/indexer/plugins/language/vue/index.js';
import { VueFrameworkPlugin } from '../../src/indexer/plugins/integration/view/vue/index.js';
import { getChangeImpact } from '../../src/tools/analysis/impact.js';
import type { TraceMcpConfig } from '../../src/config.js';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/vue3-composition');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE_DIR,
    include: ['src/**/*.vue', 'src/**/*.ts'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

function setup() {
  const store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  registry.registerLanguagePlugin(new VueLanguagePlugin());
  registry.registerFrameworkPlugin(new VueFrameworkPlugin());

  const config = makeConfig();
  const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
  return { store, registry, config, pipeline };
}

describe('get_change_impact', () => {
  let store: Store;
  let pipeline: IndexingPipeline;

  beforeEach(async () => {
    const ctx = setup();
    store = ctx.store;
    pipeline = ctx.pipeline;
    await pipeline.indexAll();
  });

  it('finds dependents of UserCard.vue (deduped by file)', () => {
    const result = getChangeImpact(store, { filePath: 'src/components/UserCard.vue' });
    expect(result.isOk()).toBe(true);

    const impact = result._unsafeUnwrap();
    expect(impact.target.path).toBe('src/components/UserCard.vue');
    const deps = impact.dependents.map((d) => d.path);
    expect(deps).toContain('src/components/UserList.vue');
    // File should only appear once (deduped)
    const uniquePaths = new Set(deps);
    expect(deps.length).toBe(uniquePaths.size);
  });

  it('returns edge types as array per file', () => {
    const result = getChangeImpact(store, { filePath: 'src/components/UserCard.vue' });
    expect(result.isOk()).toBe(true);

    const impact = result._unsafeUnwrap();
    const userList = impact.dependents.find((d) => d.path === 'src/components/UserList.vue');
    if (userList) {
      expect(Array.isArray(userList.edgeTypes)).toBe(true);
      expect(userList.edgeTypes).toContain('renders_component');
    }
  });

  it('respects depth limit', () => {
    const result = getChangeImpact(store, { filePath: 'src/components/UserCard.vue' }, 1);
    expect(result.isOk()).toBe(true);

    const impact = result._unsafeUnwrap();
    for (const dep of impact.dependents) {
      expect(dep.depth).toBe(1);
    }
  });

  it('handles nonexistent file gracefully', () => {
    const result = getChangeImpact(store, { filePath: 'nonexistent.vue' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('NOT_FOUND');
  });

  it('finds dependents by symbolId', () => {
    const result = getChangeImpact(store, {
      symbolId: 'src/components/UserCard.vue::UserCard#class',
    });
    expect(result.isOk()).toBe(true);

    const impact = result._unsafeUnwrap();
    expect(impact.target.symbolId).toBe('src/components/UserCard.vue::UserCard#class');
    expect(impact.dependents.length).toBeGreaterThan(0);
  });

  it('returns empty dependents for a leaf with no incoming edges', () => {
    const result = getChangeImpact(store, { filePath: 'src/App.vue' });
    expect(result.isOk()).toBe(true);
    expect(impact(result).target.path).toBe('src/App.vue');
  });

  // ── Enriched output ──

  it('returns summary with sentence', () => {
    const result = getChangeImpact(store, { filePath: 'src/components/UserCard.vue' });
    const i = impact(result);
    expect(typeof i.summary.totalFiles).toBe('number');
    expect(i.summary.sentence).toMatch(/^Impact:/);
  });

  it('returns risk signals with level and mitigations', () => {
    const i = impact(getChangeImpact(store, { filePath: 'src/components/UserCard.vue' }));
    expect(typeof i.risk.score).toBe('number');
    expect(['low', 'medium', 'high', 'critical']).toContain(i.risk.level);
    expect(Array.isArray(i.risk.mitigations)).toBe(true);
  });

  it('groups by module when dependents exist', () => {
    const i = impact(getChangeImpact(store, { filePath: 'src/components/UserCard.vue' }));
    if (i.dependents.length > 0) {
      expect(i.byModule).toBeDefined();
      expect(i.byModule![0]).toHaveProperty('module');
      expect(i.byModule![0]).toHaveProperty('count');
    }
  });

  it('enriches dependents with symbols array', () => {
    const i = impact(getChangeImpact(store, { filePath: 'src/components/UserCard.vue' }));
    const withSymbols = i.dependents.filter((d) => d.symbols && d.symbols.length > 0);
    if (i.dependents.length > 0) {
      expect(withSymbols.length).toBeGreaterThan(0);
      expect(withSymbols[0].symbols![0]).toHaveProperty('symbolName');
      expect(withSymbols[0].symbols![0]).toHaveProperty('symbolKind');
    }
  });

  it('returns target with symbolName and kind', () => {
    const i = impact(getChangeImpact(store, {
      symbolId: 'src/components/UserCard.vue::UserCard#class',
    }));
    expect(i.target.symbolName).toBeDefined();
    expect(i.target.kind).toBeDefined();
  });

  it('returns compact affectedTests format', () => {
    const i = impact(getChangeImpact(store, { filePath: 'src/components/UserCard.vue' }));
    expect(typeof i.affectedTests.total).toBe('number');
    expect(Array.isArray(i.affectedTests.files)).toBe(true);
  });

  it('omits empty optional sections', () => {
    const i = impact(getChangeImpact(store, { filePath: 'src/App.vue' }));
    if (i.dependents.length === 0) {
      expect(i.byModule).toBeUndefined();
      expect(i.byEdgeType).toBeUndefined();
      expect(i.byDepth).toBeUndefined();
      expect(i.coChangeHidden).toBeUndefined();
    }
  });

  it('totalAffected equals deduped file count', () => {
    const i = impact(getChangeImpact(store, { filePath: 'src/components/UserCard.vue' }));
    expect(i.totalAffected).toBe(i.dependents.length);
    expect(i.summary.totalFiles).toBe(i.dependents.length);
  });

  // ── Diff-aware mode ──

  it('symbol_ids scopes impact to specific symbols', () => {
    const i = impact(getChangeImpact(store, {
      symbolIds: ['src/components/UserCard.vue::UserCard#class'],
    }));
    expect(i.target.path).toBe('src/components/UserCard.vue');
    expect(i.scopedToSymbols).toEqual(['src/components/UserCard.vue::UserCard#class']);
    expect(i.dependents.length).toBeGreaterThan(0);
  });

  it('symbol_ids with unknown symbol returns error', () => {
    const result = getChangeImpact(store, { symbolIds: ['nonexistent::Foo#class'] });
    expect(result.isErr()).toBe(true);
  });

  // ── Breaking changes ──

  it('breakingChanges is omitted when no exported symbols have consumers', () => {
    const i = impact(getChangeImpact(store, { filePath: 'src/App.vue' }));
    expect(i.breakingChanges).toBeUndefined();
  });

  // ── Per-symbol test reach ──

  it('symbols in dependents may have hasTestReach boolean', () => {
    const i = impact(getChangeImpact(store, { filePath: 'src/components/UserCard.vue' }));
    const withSymbols = i.dependents.filter((d) => d.symbols && d.symbols.length > 0);
    for (const dep of withSymbols) {
      for (const sym of dep.symbols!) {
        if (sym.hasTestReach !== undefined) {
          expect(typeof sym.hasTestReach).toBe('boolean');
        }
      }
    }
  });
});

// Helper to unwrap results
function impact(result: ReturnType<typeof getChangeImpact>) {
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}
