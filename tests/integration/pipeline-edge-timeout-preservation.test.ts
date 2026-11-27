/**
 * TRA-3159 regression: a framework resolveEdges() failure (timeout or thrown
 * exception) must not cause previously persisted cross-file framework edges
 * to be lost. Before this fix, FilePersister unconditionally wiped a
 * changed file's outgoing edges in Pass 1, and executeFrameworkResolveEdges
 * collapsed both "legitimately empty" and "timed out / threw" into the same
 * ok([]) — so Pass 2 never restored what Pass 1 already deleted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { LaravelPlugin } from '../../src/indexer/plugins/integration/framework/laravel/index.js';
import { InertiaPlugin } from '../../src/indexer/plugins/integration/view/inertia/index.js';
import { VueFrameworkPlugin } from '../../src/indexer/plugins/integration/view/vue/index.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { VueLanguagePlugin } from '../../src/indexer/plugins/language/vue/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';
import type { Store } from '../../src/db/store.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/inertia-laravel-vue');

function setupPipeline(fixturePath: string) {
  const store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new PhpLanguagePlugin());
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  registry.registerLanguagePlugin(new VueLanguagePlugin());
  registry.registerFrameworkPlugin(new LaravelPlugin());
  registry.registerFrameworkPlugin(new VueFrameworkPlugin());
  const inertia = new InertiaPlugin();
  registry.registerFrameworkPlugin(inertia);
  const config = TraceMcpConfigSchema.parse({
    include: ['**/*.php', '**/*.ts', '**/*.vue'],
    exclude: ['vendor/**', 'node_modules/**'],
  });
  const pipeline = new IndexingPipeline(store, registry, config, fixturePath);
  return { store, pipeline, inertia };
}

describe('TRA-3159: framework edges survive a resolver failure', () => {
  let tmpRoot: string;
  let store: Store;
  let pipeline: ReturnType<typeof setupPipeline>['pipeline'];
  let inertia: InertiaPlugin;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-tra3159-'));
    fs.cpSync(FIXTURE, tmpRoot, { recursive: true });
    const setup = setupPipeline(tmpRoot);
    store = setup.store;
    pipeline = setup.pipeline;
    inertia = setup.inertia;
    await pipeline.indexAll();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('keeps the inertia_renders edge when the resolver throws on an unrelated, structure-preserving edit', async () => {
    const before = store.getEdgesByType('inertia_renders');
    expect(before.length).toBeGreaterThan(0);

    // Touch the controller WITHOUT changing the Inertia::render call or
    // symbol structure (hits FilePersister's fast symbol-update path).
    const controllerPath = path.join(tmpRoot, 'app/Http/Controllers/UserController.php');
    fs.appendFileSync(controllerPath, '\n// trivial touch, TRA-3159 regression\n');

    // Simulate a real resolver failure (timeout or exception both land here
    // via executeFrameworkResolveEdges' catch block).
    inertia.resolveEdges = async () => {
      throw new Error('TRA-3159 simulated resolver failure');
    };

    await pipeline.indexAll();

    const after = store.getEdgesByType('inertia_renders');
    expect(after.length).toBe(before.length);
    expect(after.map((e) => [e.source_node_id, e.target_node_id]).sort()).toEqual(
      before.map((e) => [e.source_node_id, e.target_node_id]).sort(),
    );
  });

  it('still updates passes_props once the resolver succeeds again (not permanently stuck)', async () => {
    const controllerPath = path.join(tmpRoot, 'app/Http/Controllers/UserController.php');
    const original = fs.readFileSync(controllerPath, 'utf-8');

    // First: a real failure on a structure-preserving edit — edge survives.
    fs.appendFileSync(controllerPath, '\n// trivial touch\n');
    inertia.resolveEdges = async () => {
      throw new Error('TRA-3159 simulated resolver failure');
    };
    await pipeline.indexAll();
    expect(store.getEdgesByType('inertia_renders').length).toBeGreaterThan(0);

    // Then: a real content change (a new prop passed to the view) + a
    // resolver that succeeds again — passes_props must pick up the new
    // prop, proving the fix didn't make these edges permanently sticky.
    const changed = original.replace(
      "'filters' => request()->only('search'),",
      "'filters' => request()->only('search'),\n            'extraProp' => true,",
    );
    expect(changed).not.toBe(original);
    fs.writeFileSync(controllerPath, changed);
    const freshInertia = new InertiaPlugin();
    inertia.resolveEdges = freshInertia.resolveEdges.bind(freshInertia);
    await pipeline.indexAll();

    const propsEdges = store.getEdgesByType('passes_props');
    const allPropNames = propsEdges.flatMap((e) => {
      const meta = JSON.parse(e.metadata ?? '{}');
      return (meta.propNames ?? []) as string[];
    });
    expect(allPropNames).toContain('extraProp');
  });
});
