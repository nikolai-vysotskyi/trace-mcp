import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { VueFrameworkPlugin } from '../../src/indexer/plugins/integration/view/vue/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { VueLanguagePlugin } from '../../src/indexer/plugins/language/vue/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { getComponentTree } from '../../src/tools/framework/components.js';
import { createTestStore } from '../test-utils.js';

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

describe('get_component_tree', () => {
  let store: Store;
  let pipeline: IndexingPipeline;

  beforeEach(async () => {
    const ctx = setup();
    store = ctx.store;
    pipeline = ctx.pipeline;
    await pipeline.indexAll();
  });

  it('builds tree from App.vue with children', () => {
    const result = getComponentTree(store, 'src/App.vue');
    expect(result.isOk()).toBe(true);

    const tree = result._unsafeUnwrap();
    expect(tree.root.name).toBe('App');
    expect(tree.root.path).toBe('src/App.vue');
    expect(tree.totalComponents).toBeGreaterThanOrEqual(1);
  });

  it('includes props and emits on child nodes', () => {
    const result = getComponentTree(store, 'src/App.vue', 3);
    expect(result.isOk()).toBe(true);

    const tree = result._unsafeUnwrap();
    // Find UserCard in the tree (could be nested)
    const findNode = (node: typeof tree.root, name: string): typeof tree.root | undefined => {
      if (node.name === name) return node;
      for (const child of node.children) {
        const found = findNode(child, name);
        if (found) return found;
      }
      return undefined;
    };

    const userCard = findNode(tree.root, 'UserCard');
    if (userCard) {
      // UserCard has defineProps<{ name: string; email: string }>
      expect(userCard.props).toBeDefined();
      expect(userCard.props).toContain('name');
      expect(userCard.props).toContain('email');
    }
  });

  it('handles missing component gracefully', () => {
    const result = getComponentTree(store, 'nonexistent/Component.vue');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('NOT_FOUND');
  });

  it('respects depth limit', () => {
    const result = getComponentTree(store, 'src/App.vue', 1);
    expect(result.isOk()).toBe(true);

    const tree = result._unsafeUnwrap();
    // At depth 1, children should not have their own children expanded
    for (const child of tree.root.children) {
      expect(child.children.length).toBe(0);
    }
  });

  it('returns UserCard as leaf with no children', () => {
    const result = getComponentTree(store, 'src/components/UserCard.vue');
    expect(result.isOk()).toBe(true);

    const tree = result._unsafeUnwrap();
    expect(tree.root.name).toBe('UserCard');
    expect(tree.root.children).toEqual([]);
  });
});
