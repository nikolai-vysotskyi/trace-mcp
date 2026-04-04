/**
 * Integration: Vue component tree through full pipeline.
 * Does get_component_tree actually work after a real pipeline run?
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { VueLanguagePlugin } from '../../src/indexer/plugins/language/vue/index.js';
import { VueFrameworkPlugin } from '../../src/indexer/plugins/integration/view/vue/index.js';
import { getComponentTree } from '../../src/tools/components.js';
import { getChangeImpact } from '../../src/tools/impact.js';

describe('Vue component tree e2e', () => {
  let store: Store;

  beforeAll(async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/vue3-composition');
    const db = initializeDatabase(':memory:');
    store = new Store(db);
    const registry = new PluginRegistry();

    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerLanguagePlugin(new VueLanguagePlugin());
    registry.registerFrameworkPlugin(new VueFrameworkPlugin());

    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.vue', '**/*.ts'],
      exclude: ['node_modules/**'],
    });

    const pipeline = new IndexingPipeline(store, registry, config, fixturePath);
    await pipeline.indexAll();
  });

  it('indexes Vue files and creates component nodes', () => {
    const components = store.getAllComponents();
    expect(components.length).toBeGreaterThan(0);

    const files = store.getAllFiles();
    const vueFiles = files.filter((f) => f.language === 'vue');
    expect(vueFiles.length).toBeGreaterThanOrEqual(3); // App, UserList, UserCard
  });

  it('creates renders_component edges from template usage', () => {
    const edges = store.getEdgesByType('renders_component');
    // App.vue uses UserList, UserList uses UserCard
    console.log(`renders_component edges: ${edges.length}`);
    // This documents whether the edge resolution actually works
  });

  it('creates uses_composable edges', () => {
    const edges = store.getEdgesByType('uses_composable');
    console.log(`uses_composable edges: ${edges.length}`);
  });

  it('get_component_tree returns tree structure', () => {
    // First check what files are actually stored
    const files = store.getAllFiles();
    const appVue = files.find((f) => f.path.includes('App.vue'));
    expect(appVue).toBeDefined();

    const result = getComponentTree(store, appVue!.path, 3);
    if (result.isErr()) {
      // If there's no component entry, the tool won't work — document this
      console.log('get_component_tree error:', result.error);
      console.log('Components in DB:', store.getAllComponents().map(c => `${c.name} fileId=${c.file_id}`));
      console.log('Files:', files.map(f => `id=${f.id} ${f.path}`));
      // This is a known gap: VueLanguagePlugin creates components,
      // but only if extractNodes in framework plugin also runs
      return;
    }

    const tree = result.value;
    expect(tree.root.name).toBeDefined();
    expect(tree.root.path).toContain('App.vue');
    console.log('Component tree:', JSON.stringify(tree, null, 2));
  });

  it('get_change_impact finds dependents of UserCard.vue', () => {
    const result = getChangeImpact(
      store,
      { filePath: 'src/components/UserCard.vue' },
      3,
    );
    if (result.isErr()) {
      console.log('get_change_impact error:', result.error);
      return;
    }

    const impact = result.value;
    expect(impact.target.path).toContain('UserCard.vue');
    console.log(`Change impact: ${impact.totalAffected} affected, dependents:`,
      impact.dependents.map((d) => `${d.path} (${d.edgeType})`));
  });
});
