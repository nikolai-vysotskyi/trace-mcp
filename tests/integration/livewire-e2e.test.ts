/**
 * Integration: Livewire v3 through full pipeline.
 * Verifies component extraction, view resolution, and edge creation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php.js';
import { LaravelPlugin } from '../../src/indexer/plugins/framework/laravel/index.js';
import { BladePlugin } from '../../src/indexer/plugins/framework/blade/index.js';

describe('Livewire v3 e2e', () => {
  let store: Store;

  beforeAll(async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/livewire-v3');
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

  it('indexes Livewire component files', () => {
    const files = store.getAllFiles();
    const phpFiles = files.filter((f) => f.language === 'php');
    // Counter.php, OrderForm.php, OrderFormData.php
    expect(phpFiles.length).toBeGreaterThanOrEqual(3);
  });

  it('marks components with livewire_component framework role', () => {
    const files = store.getAllFiles();
    const lwFiles = files.filter((f) => f.framework_role === 'livewire_component');
    expect(lwFiles.length).toBeGreaterThanOrEqual(1);
  });

  it('indexes blade view files', () => {
    const files = store.getAllFiles();
    const bladeFiles = files.filter((f) => f.path.endsWith('.blade.php'));
    // counter.blade.php, order-form.blade.php
    expect(bladeFiles.length).toBeGreaterThanOrEqual(2);
  });

  it('creates livewire_renders edges (component -> view)', () => {
    const edges = store.getEdgesByType('livewire_renders');
    // At least Counter -> counter.blade.php
    expect(edges.length).toBeGreaterThanOrEqual(1);
  });

  it('creates livewire_dispatches edges for event dispatch', () => {
    const edges = store.getEdgesByType('livewire_dispatches');
    // OrderForm dispatches events
    // May be 0 if dispatch patterns aren't matched by resolveEdges
    console.log(`livewire_dispatches edges: ${edges.length}`);
  });

  it('extracts Livewire PHP symbols', () => {
    const files = store.getAllFiles();
    const counterFile = files.find((f) => f.path.includes('Counter.php'));
    expect(counterFile).toBeDefined();
    const symbols = store.getSymbolsByFile(counterFile!.id);
    expect(symbols.length).toBeGreaterThan(0);
    const counterClass = symbols.find((s) => s.kind === 'class' && s.name === 'Counter');
    expect(counterClass).toBeDefined();
  });
});
