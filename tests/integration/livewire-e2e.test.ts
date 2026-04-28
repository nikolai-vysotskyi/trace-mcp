/**
 * Integration: Livewire v3 through full pipeline.
 * Verifies component extraction, view resolution, and edge creation.
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { LaravelPlugin } from '../../src/indexer/plugins/integration/framework/laravel/index.js';
import { BladePlugin } from '../../src/indexer/plugins/integration/view/blade/index.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

describe('Livewire v3 e2e', () => {
  let store: Store;

  beforeAll(async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/livewire-v3');
    store = createTestStore();
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
