/**
 * TRA-2249: `resolvePhpCallEdges` must not fail the whole reconcile with
 * `SQLITE_CONSTRAINT_FOREIGNKEY` when symbol nodes vanish mid-pass.
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
import { resolvePhpCallEdges } from '../../src/indexer/edge-resolvers/php-calls.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import type { PipelineState } from '../../src/indexer/pipeline-state.js';
import { RESOLVER_WRITE_CHUNK } from '../../src/indexer/resolver-budget.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

describe('php-calls stale node tolerance (TRA-2249)', () => {
  let rootDir: string;
  let pipeline: IndexingPipeline;

  // > RESOLVER_WRITE_CHUNK symbols with call/ref sites ⇒ ≥2 chunks ⇒ the
  // inter-chunk yield (a setImmediate macrotask) provably runs mid-pass.
  const FILE_COUNT = RESOLVER_WRITE_CHUNK + 50;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-php-stale-nodes-'));
    fs.mkdirSync(path.join(rootDir, 'src'));
    // Every file defines a callee class with a method, and a caller class whose
    // method calls the callee method and references the callee class in a param type.
    for (let i = 0; i < FILE_COUNT; i++) {
      fs.writeFileSync(
        path.join(rootDir, 'src', `f${i}.php`),
        `<?php
class Callee${i} {
  public static function run(): int { return ${i}; }
}
class Caller${i} {
  public function action(Callee${i} $x): int {
    return Callee${i}::run();
  }
}
`,
      );
    }
    const store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    const config: TraceMcpConfig = {
      root: rootDir,
      include: ['src/**/*.php'],
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

  /** Queue a node delete so it lands in the pass's inter-chunk yield. */
  function deleteCalleeNodesMidPass(where: string): void {
    const store = fakeState().store;
    setImmediate(() => {
      store.db
        .prepare(
          `DELETE FROM nodes WHERE node_type = 'symbol' AND ref_id IN (
            SELECT id FROM symbols WHERE ${where} OR parent_id IN (SELECT id FROM symbols WHERE ${where})
          )`,
        )
        .run();
    });
  }

  it('callee nodes deleted between chunks do not fail the pass — stale ref and call edges are skipped', async () => {
    await pipeline.indexAll();
    expect(edgeCount('calls')).toBe(FILE_COUNT);
    expect(edgeCount('references')).toBe(FILE_COUNT);

    // Every callee node vanishes mid-pass: each subsequent chunk's emitRef and
    // call insert references a deleted node id. Pre-fix this rejected with
    // SqliteError SQLITE_CONSTRAINT_FOREIGNKEY (the L50 in emitRef / resolvePhpCallEdges);
    // post-fix the stale edges are skipped and the pass completes.
    deleteCalleeNodesMidPass(`name GLOB 'Callee*'`);
    await resolvePhpCallEdges(fakeState(), undefined);

    // All targets are gone, so no `calls` or `references` edge can validly remain.
    expect(edgeCount('calls')).toBe(0);
    expect(edgeCount('references')).toBe(0);
  });

  it('edges whose endpoints still exist survive a partial mid-pass delete', async () => {
    await pipeline.indexAll();
    expect(edgeCount('calls')).toBe(FILE_COUNT);
    expect(edgeCount('references')).toBe(FILE_COUNT);

    // Only callees 0–49 vanish mid-pass; 50+ keep live targets.
    const names = Array.from({ length: 50 }, (_, i) => `'Callee${i}'`).join(',');
    deleteCalleeNodesMidPass(`name IN (${names})`);
    await resolvePhpCallEdges(fakeState(), undefined);

    expect(edgeCount('calls')).toBe(FILE_COUNT - 50);
    expect(edgeCount('references')).toBe(FILE_COUNT - 50);
  });

  it('caller nodes deleted mid-pass do not fail the pass', async () => {
    await pipeline.indexAll();
    expect(edgeCount('calls')).toBe(FILE_COUNT);
    expect(edgeCount('references')).toBe(FILE_COUNT);

    // Caller nodes vanish mid-pass: source_node_id becomes stale.
    const store = fakeState().store;
    setImmediate(() => {
      store.db
        .prepare(
          `DELETE FROM nodes WHERE node_type = 'symbol' AND ref_id IN (
            SELECT id FROM symbols WHERE name GLOB 'Caller*' OR parent_id IN (SELECT id FROM symbols WHERE name GLOB 'Caller*')
          )`,
        )
        .run();
    });
    await resolvePhpCallEdges(fakeState(), undefined);

    // All callers are gone, so edges can no longer attach to callers.
    expect(edgeCount('calls')).toBe(0);
    expect(edgeCount('references')).toBe(0);
  });
});
