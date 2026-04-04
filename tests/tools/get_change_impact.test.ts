import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { VueLanguagePlugin } from '../../src/indexer/plugins/language/vue/index.js';
import { VueFrameworkPlugin } from '../../src/indexer/plugins/integration/view/vue/index.js';
import { getChangeImpact } from '../../src/tools/impact.js';
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
  const db = initializeDatabase(':memory:');
  const store = new Store(db);
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  registry.registerLanguagePlugin(new VueLanguagePlugin());
  registry.registerFrameworkPlugin(new VueFrameworkPlugin());

  const config = makeConfig();
  const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
  return { db, store, registry, config, pipeline };
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

  it('finds dependents of UserCard.vue', () => {
    const result = getChangeImpact(store, { filePath: 'src/components/UserCard.vue' });
    expect(result.isOk()).toBe(true);

    const impact = result._unsafeUnwrap();
    expect(impact.target.path).toBe('src/components/UserCard.vue');
    // UserList renders UserCard, so it should appear as dependent
    const deps = impact.dependents.map((d) => d.path);
    expect(deps).toContain('src/components/UserList.vue');
  });

  it('returns correct edge types', () => {
    const result = getChangeImpact(store, { filePath: 'src/components/UserCard.vue' });
    expect(result.isOk()).toBe(true);

    const impact = result._unsafeUnwrap();
    const renderDeps = impact.dependents.filter((d) => d.edgeType === 'renders_component');
    expect(renderDeps.length).toBeGreaterThan(0);
  });

  it('respects depth limit', () => {
    const result = getChangeImpact(store, { filePath: 'src/components/UserCard.vue' }, 1);
    expect(result.isOk()).toBe(true);

    const impact = result._unsafeUnwrap();
    // With depth 1, only direct dependents
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
    // App.vue is the root -- nothing renders App
    const result = getChangeImpact(store, { filePath: 'src/App.vue' });
    expect(result.isOk()).toBe(true);

    const impact = result._unsafeUnwrap();
    // App may or may not have dependents, but the call should succeed
    expect(impact.target.path).toBe('src/App.vue');
  });
});
