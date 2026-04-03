/**
 * Integration: Error resilience.
 * Does the pipeline handle broken files, missing references, mixed valid/invalid?
 */
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript.js';
import { VueLanguagePlugin } from '../../src/indexer/plugins/language/vue.js';
import { LaravelPlugin } from '../../src/indexer/plugins/framework/laravel/index.js';

function createTmpFixture(files: Record<string, string>): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-err-'));
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
  }
  return tmpDir;
}

describe('error resilience', () => {
  let cleanup: (() => void)[] = [];

  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  function setupPipeline(files: Record<string, string>) {
    const tmpDir = createTmpFixture(files);
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerLanguagePlugin(new VueLanguagePlugin());
    registry.registerFrameworkPlugin(new LaravelPlugin());

    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.php', '**/*.ts', '**/*.vue'],
      exclude: ['vendor/**', 'node_modules/**'],
    });

    const pipeline = new IndexingPipeline(store, registry, config, tmpDir);
    return { store, pipeline };
  }

  it('survives completely broken PHP', async () => {
    const { store, pipeline } = setupPipeline({
      'app/Broken.php': '<?php this is not valid php at all }{}{}{',
    });

    const result = await pipeline.indexAll();
    expect(result.errors).toBe(0); // should not crash
    expect(result.indexed).toBe(1);

    const files = store.getAllFiles();
    expect(files.length).toBe(1);
    // File should be marked as partial
    expect(files[0].status).toBe('partial');
  });

  it('survives broken Vue SFC', async () => {
    const { store, pipeline } = setupPipeline({
      'Component.vue': '<script>\nthis is not valid {{ js\n</script>\n<template><div></template>',
    });

    const result = await pipeline.indexAll();
    expect(result.errors).toBe(0);
    expect(result.indexed).toBe(1);
  });

  it('survives broken TypeScript', async () => {
    const { store, pipeline } = setupPipeline({
      'broken.ts': 'export function { missing name and everything is wrong',
    });

    const result = await pipeline.indexAll();
    expect(result.errors).toBe(0);
    expect(result.indexed).toBe(1);

    const files = store.getAllFiles();
    expect(files[0].status).toBe('partial');
  });

  it('indexes valid files even when some are broken', async () => {
    const { store, pipeline } = setupPipeline({
      'app/Good.php': `<?php
namespace App;
class GoodClass {
    public function hello(): string { return 'hi'; }
}`,
      'app/Bad.php': '<?php class { broken }}}{{',
      'good.ts': 'export function add(a: number, b: number): number { return a + b; }',
      'bad.ts': 'export const { broken',
    });

    const result = await pipeline.indexAll();
    expect(result.indexed).toBe(4);
    expect(result.errors).toBe(0);

    // Good files should have symbols extracted
    const goodFile = store.getFile('app/Good.php');
    expect(goodFile).toBeDefined();
    const goodSymbols = store.getSymbolsByFile(goodFile!.id);
    expect(goodSymbols.length).toBeGreaterThan(0);
    expect(goodSymbols.find((s) => s.name === 'GoodClass')).toBeDefined();

    const goodTs = store.getFile('good.ts');
    expect(goodTs).toBeDefined();
    const tsSymbols = store.getSymbolsByFile(goodTs!.id);
    expect(tsSymbols.find((s) => s.name === 'add')).toBeDefined();
  });

  it('handles Laravel route file referencing non-existent controller', async () => {
    const { store, pipeline } = setupPipeline({
      'composer.json': JSON.stringify({
        require: { 'laravel/framework': '^10.0' },
        autoload: { 'psr-4': { 'App\\': 'app/' } },
      }),
      'routes/web.php': `<?php
use App\\Http\\Controllers\\NonExistentController;
use Illuminate\\Support\\Facades\\Route;
Route::get('/test', [NonExistentController::class, 'index']);`,
    });

    const result = await pipeline.indexAll();
    expect(result.errors).toBe(0);
    expect(result.indexed).toBeGreaterThan(0);

    // Route should still be created even if controller doesn't exist
    const routes = store.getAllRoutes();
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0].uri).toBe('/test');
  });

  it('handles empty project', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-empty-'));
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());

    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.php'],
      exclude: [],
    });

    const pipeline = new IndexingPipeline(store, registry, config, tmpDir);
    const result = await pipeline.indexAll();

    expect(result.totalFiles).toBe(0);
    expect(result.errors).toBe(0);
    expect(store.getStats().totalFiles).toBe(0);
  });

  it('handles files with no matching language plugin', async () => {
    const { store, pipeline } = setupPipeline({
      'readme.md': '# Hello',
      'config.yaml': 'key: value',
      'app.py': 'print("hello")',
    });

    const result = await pipeline.indexAll();
    // fast-glob doesn't match .md/.yaml/.py with our include patterns
    // so totalFiles=0, not skipped=3
    expect(result.totalFiles).toBe(0);
    expect(result.errors).toBe(0);
  });
});
