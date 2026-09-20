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
 * Determinism: the debounce is injected ABSURDLY large so it never fires on
 * its own; tests trigger it explicitly via __flushEdgeReconcileForTests().
 * Wall-clock debounce windows flake under full-suite load (an indexFiles
 * call can take longer than the window), so no test here sleeps.
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

/** Never fires by itself — tests flush explicitly. */
const DEBOUNCE_MS = 10 * 60_000;

function makeSetup(rootDir: string) {
  const store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());

  const config: TraceMcpConfig = {
    root: rootDir,
    include: ['src/**/*.ts'],
    exclude: [],
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
    await pipeline.__flushEdgeReconcileForTests();
    expect(scopes()).toHaveLength(2);
    expect(scopes()[1]).toBeUndefined();
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

    // 3 scoped passes so far, zero full passes (debounce still pending).
    expect(scopes()).toHaveLength(3);
    expect(fullPasses()).toBe(0);

    await pipeline.__flushEdgeReconcileForTests();
    expect(fullPasses()).toBe(1);

    // Nothing left pending — a second flush is a no-op.
    await pipeline.__flushEdgeReconcileForTests();
    expect(fullPasses()).toBe(1);
  });

  it('skips the reconcile when a full pass already ran after scheduling', async () => {
    await pipeline.indexAll();
    resolveSpy.mockClear();

    fs.writeFileSync(path.join(rootDir, 'src', 'f.ts'), 'export function fff() { return 1; }\n');
    await pipeline.indexFiles(['src/f.ts']); // schedules reconcile
    await pipeline.indexAll(true); // forced full pass — covers the reconcile

    expect(fullPasses()).toBe(1);
    await pipeline.__flushEdgeReconcileForTests();
    expect(fullPasses()).toBe(1); // timer fired but reconcile no-oped
  });

  it('dispose() cancels a pending reconcile', async () => {
    await pipeline.indexAll();
    resolveSpy.mockClear();

    fs.writeFileSync(path.join(rootDir, 'src', 'g.ts'), 'export function ggg() { return 1; }\n');
    await pipeline.indexFiles(['src/g.ts']); // schedules reconcile

    await pipeline.dispose();
    await pipeline.__flushEdgeReconcileForTests(); // timer cleared — no-op

    // Only the inline scoped pass — nothing fired after dispose.
    expect(scopes()).toHaveLength(1);
    expect(scopes()[0]).toBeDefined();
  });

  it('dispose() drains in-flight pipeline work before returning (TRA-1752)', async () => {
    // stopProject() closes the project DB the moment dispose() returns — if
    // dispose() does not wait out the lock chain, the run's next statement
    // throws "The database connection is not open" from an async continuation.
    await pipeline.indexAll();

    fs.writeFileSync(path.join(rootDir, 'src', 'h.ts'), 'export function hhh() { return 1; }\n');
    let finished = false;
    const run = pipeline.indexFiles(['src/h.ts']).then((r) => {
      finished = true;
      return r;
    });
    await pipeline.dispose();
    // The .then above was registered before dispose()'s lock wait, so this
    // is only true when dispose() actually awaited the in-flight run.
    expect(finished).toBe(true);
    await run;
  });

  it('dispose() waits for an already-fired reconcile instead of closing under it (TRA-1752)', async () => {
    await pipeline.indexAll();
    resolveSpy.mockClear();

    fs.writeFileSync(path.join(rootDir, 'src', 'i.ts'), 'export function iii() { return 1; }\n');
    await pipeline.indexFiles(['src/i.ts']); // schedules reconcile

    // Hold the full pass open so it is provably still running when dispose()
    // lands — without the gate the tiny test DB could finish first and the
    // test would pass vacuously.
    resolveSpy.mockRestore();
    const origResolveEdges = EdgeResolver.prototype.resolveEdges;
    let releaseFull!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFull = r;
    });
    let fullEntered = false;
    resolveSpy = vi
      .spyOn(EdgeResolver.prototype, 'resolveEdges')
      .mockImplementation(async function (this: EdgeResolver, ...args: never[]) {
        if ((args as unknown[])[2] === undefined) {
          fullEntered = true;
          await gate;
        }
        return (origResolveEdges as (...a: never[]) => Promise<void>).apply(this, args);
      });

    // Fire without awaiting: the full pass is now in flight, held at the gate.
    const flushP = pipeline.__flushEdgeReconcileForTests();
    await vi.waitFor(() => expect(fullEntered).toBe(true));

    let disposeReturned = false;
    const disposeP = pipeline.dispose().then(() => {
      disposeReturned = true;
    });
    // The gate is still closed — dispose() must still be draining.
    await new Promise((r) => setTimeout(r, 50));
    expect(disposeReturned).toBe(false);

    releaseFull();
    await disposeP;
    await flushP;
    expect(disposeReturned).toBe(true);
    expect(fullPasses()).toBe(1);
  });

  it('scheduling reconciles after dispose() arms no timer (TRA-1752)', async () => {
    await pipeline.indexAll();
    resolveSpy.mockClear();
    await pipeline.dispose();

    // An in-flight run reaching its tail after dispose() must not arm a timer
    // that later fires against the closed DB.
    const internals = pipeline as unknown as {
      scheduleEdgeReconcile(): void;
      scheduleCoverageReconcile(): void;
      _reconcileTimer: unknown;
      _coverageTimer: unknown;
    };
    internals.scheduleEdgeReconcile();
    internals.scheduleCoverageReconcile();
    expect(internals._reconcileTimer).toBeNull();
    expect(internals._coverageTimer).toBeNull();

    await pipeline.__flushEdgeReconcileForTests(); // nothing pending — no-op
    expect(fullPasses()).toBe(0);
  });

  it('content-only edits do not schedule a reconcile', async () => {
    await pipeline.indexAll();
    resolveSpy.mockClear();

    // Same symbol set, different body → no name churn.
    fs.writeFileSync(path.join(rootDir, 'src', 'a.ts'), 'export function alpha() { return 42; }\n');
    await pipeline.indexFiles(['src/a.ts']);

    await pipeline.__flushEdgeReconcileForTests(); // nothing pending — no-op
    expect(fullPasses()).toBe(0);
  });
});
