/**
 * TRA-1017: an indexing run handed an aborted `AbortSignal` must stop at its
 * next batch/phase boundary with `IndexAbortedError` — never ride a
 * minutes-long run to completion past the daemon's shutdown deadline — and a
 * non-aborted signal must leave the happy path untouched.
 *
 * Cancelling between persistence and edge resolution must also never leave a
 * permanently incomplete graph: hashes say "current" while edges are missing,
 * and the zero-change shortcuts would otherwise bless that state forever.
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceMcpConfigSchema } from '../../config.js';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { IndexAbortedError, throwIfIndexAborted } from '../index-abort.js';
import { IndexingPipeline } from '../pipeline.js';

let workDir: string;
let db: Database.Database;
let store: Store;
let pipeline: IndexingPipeline;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'index-abort-'));
  mkdirSync(join(workDir, 'src'), { recursive: true });
  for (let i = 0; i < 20; i++) {
    writeFileSync(
      join(workDir, 'src', `m${i}.ts`),
      `export function f${i}(): number { return ${i}; }\n`,
    );
  }

  db = initializeDatabase(join(workDir, 'index.db'));
  store = new Store(db);
  pipeline = new IndexingPipeline(
    store,
    PluginRegistry.createWithDefaults(),
    TraceMcpConfigSchema.parse({}),
    workDir,
  );
});

afterEach(async () => {
  await pipeline.dispose?.();
  try {
    db.close();
  } catch {
    /* best-effort */
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe('throwIfIndexAborted', () => {
  it('is a no-op without a signal', () => {
    expect(() => throwIfIndexAborted(undefined, workDir)).not.toThrow();
    expect(() => throwIfIndexAborted(new AbortController().signal, workDir)).not.toThrow();
  });

  it('throws IndexAbortedError once aborted', () => {
    const controller = new AbortController();
    controller.abort();
    let caught: unknown;
    try {
      throwIfIndexAborted(controller.signal, workDir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IndexAbortedError);
    expect((caught as Error).name).toBe('IndexAbortedError');
  });
});

describe('indexAll with AbortSignal (TRA-1017)', () => {
  it('rejects with IndexAbortedError on a pre-aborted signal without indexing', async () => {
    const controller = new AbortController();
    controller.abort();

    const attempted = pipeline.indexAll(false, { signal: controller.signal });
    await expect(attempted).rejects.toBeInstanceOf(IndexAbortedError);
    // Nothing was persisted: the abort lands before reconcile/extract.
    expect(store.getStats().totalSymbols).toBe(0);
  });

  it('completes normally with a non-aborted signal', async () => {
    const controller = new AbortController();
    const result = await pipeline.indexAll(false, { signal: controller.signal });
    expect(result.indexed).toBeGreaterThan(0);
    expect(result.errors).toBe(0);
    expect(store.getStats().totalSymbols).toBeGreaterThan(0);
  });

  it('stays usable after an aborted run (the lock recovers)', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(pipeline.indexAll(false, { signal: controller.signal })).rejects.toBeInstanceOf(
      IndexAbortedError,
    );
    // The aborted run must not wedge the pipeline lock for the next run.
    const result = await pipeline.indexAll(false);
    expect(result.errors).toBe(0);
    expect(store.getStats().totalSymbols).toBeGreaterThan(0);
  });

  it('rejects a pre-aborted warm run without applying discovered changes', async () => {
    // The warm-project startup path: a live index plus an injected discovery
    // answer naming a real change. A stop asked before the run must reject —
    // not persist the change past the stop.
    const root = mkdtempSync(join(tmpdir(), 'index-abort-warm-'));
    const warmDb = initializeDatabase(join(root, 'index.db'));
    const warmStore = new Store(warmDb);
    writeFileSync(join(root, 'a.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(
      join(root, 'b.ts'),
      "import { foo } from './a';\nexport function bar() { return foo(); }\n",
    );
    const warm = new IndexingPipeline(
      warmStore,
      PluginRegistry.createWithDefaults(),
      TraceMcpConfigSchema.parse({}),
      root,
      undefined,
      {
        incrementalDiscovery: {
          snapshotPath: null,
          discover: async () => ({ source: 'git-status', changed: ['b.ts'], deleted: [] }),
        },
      },
    );
    try {
      await warm.indexAll(true);
      writeFileSync(
        join(root, 'b.ts'),
        "import { foo } from './a';\nexport function changed() { return foo(); }\n",
      );
      const controller = new AbortController();
      controller.abort();
      await expect(warm.indexAll(false, { signal: controller.signal })).rejects.toBeInstanceOf(
        IndexAbortedError,
      );
      // The discovered change was not applied past the stop.
      expect(warmDb.prepare("SELECT name FROM symbols WHERE name = 'changed'").all()).toHaveLength(
        0,
      );
    } finally {
      await warm.dispose();
      warmDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repairs the graph on the run after an abort between extraction and resolution', async () => {
    // Persistence rewrites hashes and drops old edges BEFORE resolution. An
    // abort in between used to leave hashes saying "current" with edges
    // missing — and the next run's HEAD+content shortcuts blessed that state
    // forever. The interrupted run must leave a mark forcing re-resolution.
    const root = mkdtempSync(join(tmpdir(), 'index-abort-repair-'));
    const repairDb = initializeDatabase(join(root, 'index.db'));
    const repairStore = new Store(repairDb);
    writeFileSync(
      join(root, 'a.ts'),
      'export function foo() { return 1; }\nexport function baz() { return 2; }\n',
    );
    writeFileSync(
      join(root, 'b.ts'),
      "import { foo } from './a';\nexport function bar() { return foo(); }\n",
    );
    writeFileSync(
      join(root, 'c.ts'),
      "import { foo } from './a';\nexport function keep() { return foo(); }\n",
    );
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'add', 'a.ts', 'b.ts', 'c.ts']);
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=Abort Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    const first = new IndexingPipeline(
      repairStore,
      PluginRegistry.createWithDefaults(),
      TraceMcpConfigSchema.parse({}),
      root,
    );
    const readEdges = () => repairDb.prepare('SELECT * FROM edges').all();
    try {
      await first.indexAll(true);
      // Uncommitted edit: HEAD stays put so the next run takes its shortcuts.
      writeFileSync(
        join(root, 'b.ts'),
        "import { baz } from './a';\nexport function bar() { return baz(); }\n",
      );
      const controller = new AbortController();
      // biome-ignore lint/suspicious/noExplicitAny: spying on the private phase boundary
      const internal = first as any;
      const extract = internal.extractAndPersist.bind(first);
      const spy = vi
        .spyOn(internal, 'extractAndPersist')
        // biome-ignore lint/suspicious/noExplicitAny: passthrough args
        .mockImplementation(async (...args: any[]) => {
          await extract(...args);
          controller.abort();
        });
      await expect(
        first.indexAll(false, { discovery: 'full-walk', signal: controller.signal }),
      ).rejects.toBeInstanceOf(IndexAbortedError);
      spy.mockRestore();
    } finally {
      await first.dispose();
    }
    const resumed = new IndexingPipeline(
      repairStore,
      PluginRegistry.createWithDefaults(),
      TraceMcpConfigSchema.parse({}),
      root,
    );
    try {
      // No changes since the abort: hashes match, HEAD matches — the exact
      // input the old shortcuts misread as "already correct".
      const result = await resumed.indexAll(false, { discovery: 'full-walk' });
      expect(result.errors).toBe(0);
      const afterRetry = readEdges();
      await resumed.indexAll(true);
      // The plain retry must already hold the whole graph — a forced rebuild
      // must find nothing left to repair (in particular b.ts's import edge).
      expect(afterRetry.length).toBe(readEdges().length);
      expect(afterRetry.length).toBeGreaterThan(0);
    } finally {
      await resumed.dispose();
      repairDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
