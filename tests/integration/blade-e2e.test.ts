/**
 * Integration: Blade @extends / @include edges through full pipeline.
 * Verifies that the BladePlugin.resolveEdges creates blade_extends and
 * blade_includes edges in the DB after a real pipeline run.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { LaravelPlugin } from '../../src/indexer/plugins/integration/laravel/index.js';
import { BladePlugin } from '../../src/indexer/plugins/integration/blade/index.js';

describe('Blade @extends / @include e2e', () => {
  let store: Store;

  beforeAll(async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/blade-laravel');
    const db = initializeDatabase(':memory:');
    store = new Store(db);
    const registry = new PluginRegistry();

    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerFrameworkPlugin(new LaravelPlugin());
    registry.registerFrameworkPlugin(new BladePlugin());

    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.php', '**/*.blade.php'],
      exclude: ['vendor/**'],
    });

    const pipeline = new IndexingPipeline(store, registry, config, fixturePath);
    await pipeline.indexAll();
  });

  it('indexes blade.php files', () => {
    const files = store.getAllFiles();
    const bladeFiles = files.filter((f) => f.path.endsWith('.blade.php'));
    // layouts/app, partials/header, partials/footer, users/index, components/user-card
    expect(bladeFiles.length).toBeGreaterThanOrEqual(5);
  });

  it('creates blade_extends edges', () => {
    // users/index.blade.php extends layouts/app
    const edges = store.getEdgesByType('blade_extends');
    expect(edges.length).toBeGreaterThan(0);
  });

  it('creates blade_includes edges', () => {
    // layouts/app.blade.php includes partials/header and partials/footer
    const edges = store.getEdgesByType('blade_includes');
    expect(edges.length).toBeGreaterThanOrEqual(2);
  });

  it('creates blade_component edges for <x-component>', () => {
    // users/index.blade.php uses <x-user-card>
    const edges = store.getEdgesByType('blade_component');
    expect(edges.length).toBeGreaterThan(0);
  });
});
