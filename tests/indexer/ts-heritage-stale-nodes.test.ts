/**
 * TRA-2756: `resolveTypeScriptHeritageEdges` must not fail coverage reconcile
 * or bulk indexing with `SQLITE_CONSTRAINT_FOREIGNKEY` when symbol nodes vanish mid-pass.
 *
 * Parallel to TRA-1902 (`resolveTypeScriptCallEdges`) and TRA-2649 (`resolveMemberOfEdges`):
 * `resolveTypeScriptHeritageEdges` snapshots symbol→node IDs up front, then commits
 * heritage (`ts_extends`, `ts_implements`, phantom external) edges in chunks with an
 * event-loop yield between transactions (`commitInChunks`, TRA-1764).
 *
 * When a watcher batch, dropped-events full walk, deferred coverage reconcile, or
 * concurrent file deletion removes symbols/nodes during that yield, the upfront snapshot
 * contains stale node IDs. `INSERT OR IGNORE` does not suppress foreign key constraint
 * violations, so inserting an edge referencing a deleted node causes
 * `SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed` and aborts the entire
 * deferred coverage reconcile pass (L40 `Deferred coverage reconcile failed`).
 *
 * Fix: catch `isForeignKeyViolation(e)` during edge insert, skip the stale edge,
 * increment `skippedStale`, log a warning, and allow the remaining valid edges to commit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { resolveTypeScriptHeritageEdges } from '../../src/indexer/edge-resolvers/heritage.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import type { PipelineState } from '../../src/indexer/pipeline-state.js';
import { RESOLVER_WRITE_CHUNK } from '../../src/indexer/resolver-budget.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

describe('ts-heritage stale node tolerance (TRA-2756)', () => {
  let rootDir: string;
  let pipeline: IndexingPipeline;

  // > RESOLVER_WRITE_CHUNK symbols with heritage => >= 2 chunks =>
  // the inter-chunk yield (a setImmediate macrotask) provably runs mid-pass.
  const FILE_COUNT = RESOLVER_WRITE_CHUNK + 50;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-heritage-stale-nodes-'));
    fs.mkdirSync(path.join(rootDir, 'src'));
    // Every file defines a base class and a derived class that extends it.
    for (let i = 0; i < FILE_COUNT; i++) {
      fs.writeFileSync(
        path.join(rootDir, 'src', `f${i}.ts`),
        `export interface IContract${i} { run(): number; }\nexport class Base${i} { id = ${i}; }\nexport class Derived${i} extends Base${i} implements IContract${i} { run() { return ${i}; } }\n`,
      );
    }
    const store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config: TraceMcpConfig = {
      root: rootDir,
      include: ['src/**/*.ts'],
      exclude: [],
      plugins: [],
    };
    pipeline = new IndexingPipeline(store, registry, config, rootDir, undefined, {
      coverageReconcileDebounceMs: 10 * 60_000,
    });
  });

  afterEach(async () => {
    await pipeline.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function fakeState(): PipelineState {
    const internals = pipeline as unknown as {
      store: PipelineState['store'];
      registry: PipelineState['registry'];
      config: PipelineState['config'];
    };
    return {
      store: internals.store,
      registry: internals.registry,
      config: internals.config,
      rootPath: rootDir,
      workspaces: [],
      isIncremental: false,
      changedFileIds: new Set(),
      pendingImports: new Map(),
      fileContentCache: new Map(),
      gitignore: undefined,
    };
  }

  function edgeCount(typeName: string): number {
    const store = fakeState().store;
    return (
      store.db
        .prepare(
          `SELECT COUNT(*) AS c FROM edges e JOIN edge_types t ON t.id = e.edge_type_id WHERE t.name = ?`,
        )
        .get(typeName) as { c: number }
    ).c;
  }

  it('target base class nodes deleted mid-pass do not fail the pass — stale extends edges are skipped', async () => {
    await pipeline.indexAll();
    expect(edgeCount('ts_extends')).toBe(FILE_COUNT);
    expect(edgeCount('ts_implements')).toBe(FILE_COUNT);

    // Queue deletion of Base nodes for the second chunk (index >= 250)
    // to simulate a watcher or background worker deleting symbols during the inter-chunk yield.
    const store = fakeState().store;
    setImmediate(() => {
      const doomedNames = Array.from({ length: 50 }, (_, i) => `'Base${250 + i}'`).join(',');
      store.db
        .prepare(
          `DELETE FROM nodes WHERE node_type = 'symbol' AND ref_id IN (
            SELECT id FROM symbols WHERE name IN (${doomedNames})
          )`,
        )
        .run();
    });

    // Before fix, this rejects with SqliteError: FOREIGN KEY constraint failed.
    await expect(resolveTypeScriptHeritageEdges(fakeState(), undefined)).resolves.not.toThrow();

    // The first 250 ts_extends edges survive; the 50 stale edges whose target nodes were deleted are skipped.
    expect(edgeCount('ts_extends')).toBe(250);
  });

  it('source derived class nodes deleted mid-pass do not fail the pass', async () => {
    await pipeline.indexAll();
    expect(edgeCount('ts_extends')).toBe(FILE_COUNT);
    expect(edgeCount('ts_implements')).toBe(FILE_COUNT);

    const store = fakeState().store;
    setImmediate(() => {
      // Delete derived class nodes in the second chunk (index >= 250)
      const doomedNames = Array.from({ length: 50 }, (_, i) => `'Derived${250 + i}'`).join(',');
      store.db
        .prepare(
          `DELETE FROM nodes WHERE node_type = 'symbol' AND ref_id IN (
            SELECT id FROM symbols WHERE name IN (${doomedNames})
          )`,
        )
        .run();
    });

    await expect(resolveTypeScriptHeritageEdges(fakeState(), undefined)).resolves.not.toThrow();
    expect(edgeCount('ts_extends')).toBe(250);
    expect(edgeCount('ts_implements')).toBe(250);
  });

  it('target interface nodes deleted mid-pass do not fail the pass — stale implements edges are skipped', async () => {
    await pipeline.indexAll();
    expect(edgeCount('ts_implements')).toBe(FILE_COUNT);

    const store = fakeState().store;
    setImmediate(() => {
      const doomedNames = Array.from({ length: 50 }, (_, i) => `'IContract${250 + i}'`).join(',');
      store.db
        .prepare(
          `DELETE FROM nodes WHERE node_type = 'symbol' AND ref_id IN (
            SELECT id FROM symbols WHERE name IN (${doomedNames})
          )`,
        )
        .run();
    });

    await expect(resolveTypeScriptHeritageEdges(fakeState(), undefined)).resolves.not.toThrow();
    expect(edgeCount('ts_implements')).toBe(250);
  });

  it('source nodes deleted mid-pass for phantom external extends do not fail the pass', async () => {
    // Add external extends across files
    for (let i = 0; i < FILE_COUNT; i++) {
      fs.writeFileSync(
        path.join(rootDir, 'src', `f${i}.ts`),
        `export class ExtWidget${i} extends ExternalVendorWidget { render() { return ${i}; } }\n`,
      );
    }
    await pipeline.indexAll();
    expect(edgeCount('ts_extends')).toBe(FILE_COUNT);

    const store = fakeState().store;
    setImmediate(() => {
      const doomedNames = Array.from({ length: 50 }, (_, i) => `'ExtWidget${250 + i}'`).join(',');
      store.db
        .prepare(
          `DELETE FROM nodes WHERE node_type = 'symbol' AND ref_id IN (
            SELECT id FROM symbols WHERE name IN (${doomedNames})
          )`,
        )
        .run();
    });

    await expect(resolveTypeScriptHeritageEdges(fakeState(), undefined)).resolves.not.toThrow();
    expect(edgeCount('ts_extends')).toBe(250);
  });

  it('coverage reconcile recovers cleanly when files/nodes are deleted mid-pass', async () => {
    await pipeline.indexAll();
    expect(edgeCount('ts_extends')).toBe(FILE_COUNT);

    // Simulate coverage drift: write 20 unannounced files to trigger coverage reconcile threshold
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(
        path.join(rootDir, 'src', `extra${i}.ts`),
        `export class ExtraBase${i} {}\nexport class ExtraDerived${i} extends ExtraBase${i} {}\n`,
      );
    }

    // Touch one file to schedule coverage reconcile
    await pipeline.indexFiles(['src/f0.ts']);

    // Delete 50 files from disk and delete their symbol nodes mid-reconcile
    setImmediate(() => {
      const doomedFiles = Array.from({ length: 50 }, (_, i) => `src/f${250 + i}.ts`);
      pipeline.deleteFiles(doomedFiles);
    });

    // Coverage reconcile must complete without unhandled SQLITE_CONSTRAINT_FOREIGNKEY rejection
    await expect(pipeline.__flushCoverageReconcileForTests()).resolves.not.toThrow();

    // Verify subsequent reindex succeeds cleanly
    await expect(pipeline.indexAll(false, { discovery: 'full-walk' })).resolves.not.toThrow();
  });
});
