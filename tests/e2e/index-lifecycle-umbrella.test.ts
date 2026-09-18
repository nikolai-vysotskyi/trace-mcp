/**
 * Umbrella-project indexing lifecycle E2E (mirrors the real-world
 * Laravel + front layout, e.g. thewed/assetfeed): add → index → search →
 * incremental update → delete, across both children in ONE index run.
 *
 * Covers the critical user path QA-validated against the 3.27.1 installed
 * build: a fresh umbrella root becomes fully usable (PHP + Vue symbols,
 * cross-child client-call links) with zero pipeline errors.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { LaravelPlugin } from '../../src/indexer/plugins/integration/framework/laravel/index.js';
import { VueFrameworkPlugin } from '../../src/indexer/plugins/integration/view/vue/index.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { VueLanguagePlugin } from '../../src/indexer/plugins/language/vue/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { scanClientCalls } from '../../src/subproject/scanner.js';
import { getFileOutline, search } from '../../src/tools/navigation/navigation.js';
import {
  createTestStore,
  createTmpFixture,
  removeTmpDir,
  writeFixtureFile,
} from '../test-utils.js';

const CONTROLLER_V1 = `<?php
namespace App\\Http\\Controllers;
use App\\Models\\Probe;
class ProbeController {
  public function index() {
    return Probe::all();
  }
  public function show($id) {
    return Probe::find($id);
  }
}
`;

const CONTROLLER_V2 = `<?php
namespace App\\Http\\Controllers;
use App\\Models\\Probe;
class ProbeController {
  public function index() {
    return Probe::all();
  }
  public function show($id) {
    return Probe::find($id);
  }
  public function stats() {
    return Probe::count();
  }
}
`;

describe('index lifecycle E2E — umbrella (laravel + front)', () => {
  let root: string;
  let store: Store;
  let pipeline: IndexingPipeline;

  beforeAll(async () => {
    root = createTmpFixture(
      {
        'backend-laravel/routes/web.php': `<?php
use App\\Http\\Controllers\\ProbeController;
Route::get('/api/probes', [ProbeController::class, 'index']);
`,
        'backend-laravel/app/Http/Controllers/ProbeController.php': CONTROLLER_V1,
        'backend-laravel/app/Models/Probe.php': `<?php
namespace App\\Models;
class Probe {
}
`,
        'front/app/components/ProbeCard.vue': `<script setup lang="ts">
defineProps<{ title: string }>();
</script>
<template>
  <div class="probe-card">{{ title }}</div>
</template>
`,
        'front/app/composables/useProbeApi.ts': `export function useProbeApi() {
  return $api('/api/probes', { method: 'GET' });
}
`,
      },
      'trace-mcp-umbrella-',
    );
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerLanguagePlugin(new VueLanguagePlugin());
    registry.registerFrameworkPlugin(new LaravelPlugin());
    registry.registerFrameworkPlugin(new VueFrameworkPlugin());
    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.php', '**/*.vue', '**/*.ts'],
      exclude: ['vendor/**', 'node_modules/**'],
    });
    pipeline = new IndexingPipeline(store, registry, config, root);
    const result = await pipeline.indexAll();
    expect(result.errors, 'fresh umbrella index has no errors').toBe(0);
  }, 120_000);

  afterAll(() => removeTmpDir(root));

  it('indexes files from both children', () => {
    const paths = store.getAllFiles().map((f) => f.path);
    expect(paths.some((p) => p.includes('backend-laravel'))).toBe(true);
    expect(paths.some((p) => p.includes('front/'))).toBe(true);
    expect(paths.length).toBeGreaterThanOrEqual(5);
  });

  it('search: finds the Laravel controller class', async () => {
    const result = await search(store, 'ProbeController', { kind: 'class' }, 20, 0, {});
    const names = result.items.map((i) => i.symbol.name);
    expect(names).toContain('ProbeController');
    expect(result.items[0].file.path).toContain('ProbeController.php');
  });

  it('search: finds the Vue component', async () => {
    const result = await search(store, 'ProbeCard', {}, 20, 0, {});
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.some((i) => i.file.path.endsWith('ProbeCard.vue'))).toBe(true);
  });

  it('get_outline: controller exposes its actions', async () => {
    const result = await getFileOutline(
      store,
      'backend-laravel/app/Http/Controllers/ProbeController.php',
    );
    expect(result.isOk()).toBe(true);
    const names = result._unsafeUnwrap().symbols.map((s) => s.name);
    expect(names).toContain('ProbeController');
    expect(names).toContain('index');
    expect(names).toContain('show');
  });

  it('subproject scan: front client call links to the laravel route', async () => {
    const urls = [...new Set((await scanClientCalls(`${root}/front`)).map((c) => c.urlPattern))];
    expect(urls).toContain('/api/probes');
  });

  it('incremental indexFiles: picks up a new controller action', async () => {
    writeFixtureFile(
      root,
      'backend-laravel/app/Http/Controllers/ProbeController.php',
      CONTROLLER_V2,
    );
    const result = await pipeline.indexFiles([
      'backend-laravel/app/Http/Controllers/ProbeController.php',
    ]);
    expect(result.errors).toBe(0);
    const found = await search(store, 'stats', { kind: 'method' }, 20, 0, {});
    expect(found.items.map((i) => i.symbol.name)).toContain('stats');
  });

  it('deleteFiles: dropping the component removes its rows', () => {
    pipeline.deleteFiles(['front/app/components/ProbeCard.vue']);
    const paths = store.getAllFiles().map((f) => f.path);
    expect(paths.some((p) => p.endsWith('ProbeCard.vue'))).toBe(false);
  });
});
