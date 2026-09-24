/**
 * TRA-1902: `resolveTypeScriptCallEdges` must not fail the whole reconcile
 * with `SQLITE_CONSTRAINT_FOREIGNKEY` when symbol nodes vanish mid-pass.
 *
 * The resolver snapshots symbol→node ids up front, then inserts edges in
 * chunks with an event-loop yield between transactions (`commitInChunks`,
 * TRA-1764). Any concurrent writer that commits a node delete inside that
 * window — a watcher batch landing mid-reconcile, a second pipeline on a
 * shared dbPath (TRA-1887), a dropped-events full-walk overlapping an
 * incremental run — leaves a stale id in the snapshot, and the next chunk's
 * `INSERT` violates `edges → nodes` FK. `INSERT OR IGNORE` does not suppress
 * FK violations, so one stale edge aborted the entire dropped-events
 * reconcile (L50 `Index reconcile after dropped events failed`).
 *
 * The contract pinned here: stale edges are skipped (with a warn), the pass
 * completes, edges whose endpoints still exist are intact.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { resolveTypeScriptCallEdges } from '../../src/indexer/edge-resolvers/typescript-calls.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import type { PipelineState } from '../../src/indexer/pipeline-state.js';
import { RESOLVER_WRITE_CHUNK } from '../../src/indexer/resolver-budget.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

describe('ts-calls stale node tolerance (TRA-1902)', () => {
  let rootDir: string;
  let pipeline: IndexingPipeline;

  // > RESOLVER_WRITE_CHUNK symbols with call sites ⇒ ≥2 chunks ⇒ the
  // inter-chunk yield (a setImmediate macrotask) provably runs mid-pass.
  const FILE_COUNT = RESOLVER_WRITE_CHUNK + 50;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-stale-nodes-'));
    fs.mkdirSync(path.join(rootDir, 'src'));
    // Every file defines a callee and a caller that calls it — one `calls`
    // edge per file once resolved.
    for (let i = 0; i < FILE_COUNT; i++) {
      fs.writeFileSync(
        path.join(rootDir, 'src', `f${i}.ts`),
        `export function callee${i}() { return ${i}; }\nexport function caller${i}() { return callee${i}(); }\n`,
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

  function callsEdgeCount(): number {
    const store = fakeState().store;
    return (
      store.db
        .prepare(
          `SELECT COUNT(*) AS c FROM edges e JOIN edge_types t ON t.id = e.edge_type_id WHERE t.name = 'calls'`,
        )
        .get() as { c: number }
    ).c;
  }

  /** Queue a node delete so it lands in the pass's inter-chunk yield. */
  function deleteCalleeNodesMidPass(where: string): void {
    const store = fakeState().store;
    // Queued BEFORE the pass starts; the pass runs chunk 1 synchronously,
    // then parks on its fair yield (a setImmediate macrotask queued after
    // this one — FIFO). The delete therefore commits strictly between the
    // upfront node-id snapshot and a later chunk's INSERT.
    setImmediate(() => {
      store.db
        .prepare(
          `DELETE FROM nodes WHERE node_type = 'symbol' AND ref_id IN (SELECT id FROM symbols WHERE ${where})`,
        )
        .run();
    });
  }

  it('nodes deleted between chunks do not fail the pass — stale edges are skipped', async () => {
    await pipeline.indexAll();
    expect(callsEdgeCount()).toBe(FILE_COUNT);

    // Every callee node vanishes mid-pass: each of the second chunk's 50
    // inserts references a deleted node id. Pre-fix this rejected with
    // SqliteError SQLITE_CONSTRAINT_FOREIGNKEY (the L50); post-fix the
    // stale edges are skipped and the pass completes.
    deleteCalleeNodesMidPass(`name GLOB 'callee[0-9]*'`);
    await resolveTypeScriptCallEdges(fakeState(), undefined);

    // All targets are gone, so no `calls` edge can validly remain — the
    // point is the pass completed instead of aborting the reconcile.
    expect(callsEdgeCount()).toBe(0);
  });

  it('edges whose endpoints still exist survive a partial mid-pass delete', async () => {
    await pipeline.indexAll();
    expect(callsEdgeCount()).toBe(FILE_COUNT);

    // Only callees 0–49 vanish mid-pass; callers 50+ keep live targets.
    // Chunk placement is an implementation detail, so this asserts the
    // end state, not which chunk skipped what: exactly the 250 edges with
    // live endpoints remain.
    const names = Array.from({ length: 50 }, (_, i) => `'callee${i}'`).join(',');
    deleteCalleeNodesMidPass(`name IN (${names})`);
    await resolveTypeScriptCallEdges(fakeState(), undefined);

    expect(callsEdgeCount()).toBe(FILE_COUNT - 50);
  });
});
