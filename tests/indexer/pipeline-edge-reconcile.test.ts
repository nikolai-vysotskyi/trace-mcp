/**
 * Tests for the deferred edge-reconcile pass.
 *
 * Background: incremental runs whose symbol names churn (new file, added or
 * deleted symbol) used to downgrade edge resolution to an inline full-pass —
 * 1-9s of synchronous CPU per watcher event on large repos. The pipeline now
 * runs the scoped pass inline and schedules ONE debounced full reconcile
 * pass instead, so an edit storm of N files costs N scoped passes + 1 full
 * pass.
 *
 * Real timers + an injected tiny debounce (the FileWatcher pattern): fake
 * timers stall the indexing pipeline itself.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { EdgeResolver } from '../../src/indexer/edge-resolver.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

const DEBOUNCE_MS = 40;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeSetup(rootDir: string) {
  const store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());

  const config: TraceMcpConfig = {
    root: rootDir,
    include: ['src/**/*.ts'],
    exclude: [],
    db: { path: ':memory:' },
    plugins: [],
  };

  const pipeline = new IndexingPipeline(store, registry, config, rootDir, undefined, {
    reconcileDebounceMs: DEBOUNCE_MS,
  });
  return { store, pipeline };
}

describe('deferred edge reconcile', () => {
  let rootDir: string;
  let pipeline: IndexingPipeline;
  let resolveSpy: ReturnType<typeof vi.spyOn>;

  /** Scope argument of every resolveEdges call (3rd positional arg). */
  const scopes = () => resolveSpy.mock.calls.map((c) => c[2]);
  const fullPasses = () => scopes().filter((s) => s === undefined).length;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-reconcile-'));
    fs.mkdirSync(path.join(rootDir, 'src'));
    fs.writeFileSync(path.join(rootDir, 'src', 'a.ts'), 'export function alpha() { return 1; }\n');
    ({ pipeline } = makeSetup(rootDir));
    resolveSpy = vi.spyOn(EdgeResolver.prototype, 'resolveEdges');
  });

  afterEach(async () => {
    await pipeline.dispose();
    resolveSpy.mockRestore();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('name churn runs a scoped pass inline and one deferred full pass', async () => {
    await pipeline.indexAll(); // initial full pass (scope undefined)
    resolveSpy.mockClear();

    // Brand-new file: every symbol counts as new → name churn.
    fs.writeFileSync(path.join(rootDir, 'src', 'b.ts'), 'export function beta() { return 2; }\n');
    await pipeline.indexFiles(['src/b.ts']);

    // Inline pass stayed scoped — no full-pass downgrade.
    expect(scopes()).toHaveLength(1);
    expect(scopes()[0]).toBeDefined();

    // Debounce elapses → exactly one full reconcile pass (scope undefined).
    await vi.waitFor(() => expect(fullPasses()).toBe(1), { timeout: 2_000 });
    expect(scopes()).toHaveLength(2);
  });

  it('coalesces an edit storm into a single reconcile pass', async () => {
    await pipeline.indexAll();
    resolveSpy.mockClear();

    for (const name of ['c', 'd', 'e']) {
      fs.writeFileSync(
        path.join(rootDir, 'src', `${name}.ts`),
        `export function fn_${name}() { return 1; }\n`,
      );
      await pipeline.indexFiles([`src/${name}.ts`]);
    }

    // 3 scoped passes so far, zero full passes (storm ran inside the window).
    expect(scopes()).toHaveLength(3);
    expect(fullPasses()).toBe(0);

    await vi.waitFor(() => expect(fullPasses()).toBe(1), { timeout: 2_000 });
    await sleep(DEBOUNCE_MS * 3); // no second pass shows up later
    expect(fullPasses()).toBe(1);
  });

  it('skips the reconcile when a full pass already ran after scheduling', async () => {
    await pipeline.indexAll();
    resolveSpy.mockClear();

    fs.writeFileSync(path.join(rootDir, 'src', 'f.ts'), 'export function fff() { return 1; }\n');
    await pipeline.indexFiles(['src/f.ts']); // schedules reconcile
    await pipeline.indexAll(true); // forced full pass — covers the reconcile

    expect(fullPasses()).toBe(1);
    await sleep(DEBOUNCE_MS * 3);
    expect(fullPasses()).toBe(1); // timer fired but reconcile no-oped
  });

  it('dispose() cancels a pending reconcile', async () => {
    await pipeline.indexAll();
    resolveSpy.mockClear();

    fs.writeFileSync(path.join(rootDir, 'src', 'g.ts'), 'export function ggg() { return 1; }\n');
    await pipeline.indexFiles(['src/g.ts']); // schedules reconcile

    await pipeline.dispose();
    await sleep(DEBOUNCE_MS * 3);

    // Only the inline scoped pass — nothing fired after dispose.
    expect(scopes()).toHaveLength(1);
    expect(scopes()[0]).toBeDefined();
  });

  it('content-only edits do not schedule a reconcile', async () => {
    await pipeline.indexAll();
    resolveSpy.mockClear();

    // Same symbol set, different body → no name churn.
    fs.writeFileSync(path.join(rootDir, 'src', 'a.ts'), 'export function alpha() { return 42; }\n');
    await pipeline.indexFiles(['src/a.ts']);

    await sleep(DEBOUNCE_MS * 3);
    expect(fullPasses()).toBe(0);
  });
});
