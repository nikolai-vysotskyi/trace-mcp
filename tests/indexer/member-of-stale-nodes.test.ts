/**
 * TRA-2649: `resolveMemberOfEdges` must not fail the whole reconcile with
 * `SQLITE_CONSTRAINT_FOREIGNKEY` when symbol nodes vanish mid-pass.
 *
 * The resolver snapshots symbol→node ids up front, then inserts edges in
 * chunks with an event-loop yield between transactions (`commitInChunks`,
 * TRA-1764). Any concurrent deletion inside that window — a watcher delete
 * batch landing mid-reconcile, or file churn — leaves a stale id in the
 * snapshot, and the next chunk's `INSERT` violates `edges → nodes` FK.
 * `INSERT OR IGNORE` does not suppress FK violations, so one stale edge
 * aborted the entire deferred edge reconcile.
 *
 * The contract pinned here: stale edges are skipped (with a warn), the pass
 * completes, and edges whose endpoints still exist are intact.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { resolveMemberOfEdges } from '../../src/indexer/edge-resolvers/member-of.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import type { PipelineState } from '../../src/indexer/pipeline-state.js';
import { RESOLVER_WRITE_CHUNK } from '../../src/indexer/resolver-budget.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

describe('member-of stale node tolerance (TRA-2649)', () => {
  let rootDir: string;
  let pipeline: IndexingPipeline;

  // > RESOLVER_WRITE_CHUNK symbols with parent_id => >= 2 chunks =>
  // the inter-chunk yield (a setImmediate macrotask) provably runs mid-pass.
  const FILE_COUNT = RESOLVER_WRITE_CHUNK + 50;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-member-of-stale-nodes-'));
    fs.mkdirSync(path.join(rootDir, 'src'));
    // Every file defines a class with a method (method has parent_id = class.id).
    for (let i = 0; i < FILE_COUNT; i++) {
      fs.writeFileSync(
        path.join(rootDir, 'src', `f${i}.ts`),
        `export class Service${i} {
  public execute(): number {
    return ${i};
  }
}
`,
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
    pipeline = new IndexingPipeline(store, registry, config, rootDir);
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

  it('parent or member nodes deleted mid-pass do not fail the pass — stale member_of edges are skipped', async () => {
    await pipeline.indexAll();
    expect(edgeCount('member_of')).toBe(FILE_COUNT);

    // Queue deletion of nodes for files in the second chunk (index >= 250)
    // to simulate a watcher delete landing during the inter-chunk yield.
    const store = fakeState().store;
    setImmediate(() => {
      // Delete nodes for classes 250..299
      const doomedNames = Array.from({ length: 50 }, (_, i) => `'Service${250 + i}'`).join(',');
      store.db
        .prepare(
          `DELETE FROM nodes WHERE node_type = 'symbol' AND ref_id IN (
            SELECT id FROM symbols WHERE name IN (${doomedNames})
          )`,
        )
        .run();
    });

    // Before fix, this rejects with SqliteError: FOREIGN KEY constraint failed.
    await expect(resolveMemberOfEdges(fakeState(), undefined)).resolves.not.toThrow();

    // The first 250 edges survive; the 50 stale edges whose target nodes were deleted are skipped.
    expect(edgeCount('member_of')).toBe(250);
  });

  it('member nodes (source) deleted mid-pass do not fail the pass', async () => {
    await pipeline.indexAll();
    expect(edgeCount('member_of')).toBe(FILE_COUNT);

    const store = fakeState().store;
    setImmediate(() => {
      // Delete nodes for methods in the second chunk
      const doomedNames = Array.from({ length: 50 }, (_, i) => `'Service${250 + i}'`).join(',');
      store.db
        .prepare(
          `DELETE FROM nodes WHERE node_type = 'symbol' AND ref_id IN (
            SELECT s.id FROM symbols s
            JOIN symbols p ON s.parent_id = p.id
            WHERE p.name IN (${doomedNames})
          )`,
        )
        .run();
    });

    await expect(resolveMemberOfEdges(fakeState(), undefined)).resolves.not.toThrow();
    expect(edgeCount('member_of')).toBe(250);
  });

  it('pipeline.deleteFiles during inter-chunk yield completes without throwing and reconciles cleanly', async () => {
    await pipeline.indexAll();
    expect(edgeCount('member_of')).toBe(FILE_COUNT);

    // Simulate pipeline.deleteFiles running mid-pass
    setImmediate(() => {
      const filesToDelete = Array.from({ length: 50 }, (_, i) => `src/f${250 + i}.ts`);
      pipeline.deleteFiles(filesToDelete);
    });

    await expect(resolveMemberOfEdges(fakeState(), undefined)).resolves.not.toThrow();

    // After deleting 50 files, 250 survive
    expect(edgeCount('member_of')).toBe(250);

    // A subsequent full resolve completes cleanly
    await expect(resolveMemberOfEdges(fakeState(), undefined)).resolves.not.toThrow();
    expect(edgeCount('member_of')).toBe(250);
  });
});
