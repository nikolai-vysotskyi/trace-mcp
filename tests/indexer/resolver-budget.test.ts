/**
 * TRA-1764: edge-resolution write passes must time-slice.
 *
 * Every resolver used to commit its whole pass in ONE synchronous
 * better-sqlite3 transaction. A full pass over a large repo held the
 * daemon's only thread for seconds — `sample(1)` put 3642/3642 main-thread
 * samples inside `sqlite3_step` while `/health` on the same thread answered
 * nothing. The converted passes commit in chunks with a fair event-loop
 * yield between transactions (`commitInChunks`).
 *
 * These tests pin the mechanism, not wall-clock timings (which flake under
 * full-suite load):
 *
 *  - `commitInChunks` splits N items into ceil(N/chunk) transactions and
 *    lets a queued `setImmediate` probe run mid-pass — impossible with a
 *    single synchronous transaction, where the probe can only run after.
 *  - A converted resolver (`resolveTypeScriptCallEdges`) over a fixture
 *    larger than one chunk shows the same interleaving AND resolves the
 *    identical edge set as the pre-chunking contract (INSERT OR IGNORE
 *    idempotence across chunk boundaries).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { resolveTypeScriptCallEdges } from '../../src/indexer/edge-resolvers/typescript-calls.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import type { PipelineState } from '../../src/indexer/pipeline-state.js';
import { _resetYieldCountForTests, getYieldCount } from '../../src/utils/event-loop.js';
import { commitInChunks, RESOLVER_WRITE_CHUNK } from '../../src/indexer/resolver-budget.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

describe('commitInChunks', () => {
  beforeEach(() => {
    _resetYieldCountForTests();
  });

  it('splits items into ceil(N/chunk) transactions', async () => {
    const db = initializeDatabase(':memory:');
    try {
      db.exec('CREATE TABLE t (v INTEGER)');
      const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
      const seen: number[][] = [];
      const items = Array.from({ length: 600 }, (_, i) => i);
      await commitInChunks(db, items, (chunk) => {
        seen.push(chunk);
        for (const v of chunk) insert.run(v);
      });
      expect(seen.map((c) => c.length)).toEqual([250, 250, 100]);
      expect((db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c).toBe(600);
    } finally {
      db.close();
    }
  });

  it('is a no-op for an empty list — no transaction, no yield', async () => {
    const db = initializeDatabase(':memory:');
    try {
      let called = false;
      await commitInChunks(db, [], () => {
        called = true;
      });
      expect(called).toBe(false);
      expect(getYieldCount()).toBe(0);
    } finally {
      db.close();
    }
  });

  it('a single chunk behaves like one transaction with no yield', async () => {
    const db = initializeDatabase(':memory:');
    try {
      await commitInChunks(db, [1, 2, 3], () => {});
      expect(getYieldCount()).toBe(0);
    } finally {
      db.close();
    }
  });

  it('lets a queued probe run mid-pass', async () => {
    const db = initializeDatabase(':memory:');
    try {
      const events: string[] = [];
      const probe = (async () => {
        await new Promise<void>((r) => setImmediate(r));
        events.push('probe');
      })();
      await commitInChunks(
        db,
        Array.from({ length: 600 }, (_, i) => i),
        () => {},
      );
      await probe;
      events.push('done');
      // Single-transaction code would give ['done', 'probe']: the async
      // function never yields to the macrotask queue, so the `done` push
      // (a microtask after the resolved promise) wins. Chunked yields flip
      // the order — the probe provably ran while work was still pending.
      expect(events).toEqual(['probe', 'done']);
      expect(getYieldCount()).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('rejects on a failing chunk, keeping earlier chunks committed', async () => {
    const db = initializeDatabase(':memory:');
    try {
      db.exec('CREATE TABLE t (v INTEGER)');
      const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
      const items = Array.from({ length: 600 }, (_, i) => i);
      await expect(
        commitInChunks(db, items, (chunk) => {
          for (const v of chunk) {
            if (v === 300) throw new Error('boom');
            insert.run(v);
          }
        }),
      ).rejects.toThrow('boom');
      // Same relaxation the stage boundary already had: a stage that throws
      // keeps the previously committed stages. Per-chunk atomicity still
      // holds — the failing chunk (items 250-499, aborted at v=300) rolls
      // back whole, so only chunk 1's 250 rows survive. Resolvers are
      // idempotent (INSERT OR IGNORE / ON CONFLICT DO UPDATE), so the next
      // run converges.
      expect((db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c).toBe(250);
    } finally {
      db.close();
    }
  });
});

describe('chunked resolver pass (TRA-1764)', () => {
  let rootDir: string;
  let pipeline: IndexingPipeline;

  const FILE_COUNT = RESOLVER_WRITE_CHUNK + 50;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-chunk-yield-'));
    fs.mkdirSync(path.join(rootDir, 'src'));
    // Every file defines a callee and a caller that calls it — one `calls`
    // edge per file once resolved. FILE_COUNT symbols with call sites
    // overflows a single 250-row transaction (plus per-file overhead the
    // pass does two chunks here).
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
    _resetYieldCountForTests();
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

  it('a full ts-calls pass over >1 chunk resolves every edge and yields mid-pass', async () => {
    await pipeline.indexAll();
    const afterIndex = callsEdgeCount();
    // One `calls` edge per caller — the fixture's whole point.
    expect(afterIndex).toBe(FILE_COUNT);

    // Re-run the converted pass standalone over the same store: idempotent
    // (INSERT OR IGNORE) and chunked. The probe interleaving proves the
    // pass yielded to the event loop mid-pass instead of holding it.
    _resetYieldCountForTests();
    const events: string[] = [];
    const probe = (async () => {
      await new Promise<void>((r) => setImmediate(r));
      events.push('probe');
    })();
    await resolveTypeScriptCallEdges(fakeState(), undefined);
    await probe;
    events.push('done');

    expect(events).toEqual(['probe', 'done']);
    expect(getYieldCount()).toBeGreaterThan(0);
    // Idempotent: the re-run resolved nothing new.
    expect(callsEdgeCount()).toBe(afterIndex);
  });
});
