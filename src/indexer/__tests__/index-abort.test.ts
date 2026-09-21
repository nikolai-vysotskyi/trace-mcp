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
import { FileExtractor } from '../file-extractor.js';
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
    // Composition, not just counts: the ESM import pass reads only
    // `pendingImports` (rebuilt by extraction, not resolution), so a retry
    // that merely reaches the same total through other edge kinds is still
    // broken. Pin the per-kind shape, import edges included.
    const edgeKindCounts = (): Record<string, number> => {
      const rows = repairDb
        .prepare(
          `SELECT t.name AS kind, COUNT(*) AS n FROM edges e
           JOIN edge_types t ON t.id = e.edge_type_id GROUP BY t.name`,
        )
        .all() as Array<{ kind: string; n: number }>;
      return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
    };
    try {
      await first.indexAll(true);
      expect(edgeKindCounts()['imports']).toBeGreaterThan(0);
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
      const retryKinds = edgeKindCounts();
      await resumed.indexAll(true);
      // The plain retry must already hold the whole graph — a forced rebuild
      // must find nothing left to repair (in particular b.ts's import edge).
      expect(afterRetry.length).toBe(readEdges().length);
      expect(afterRetry.length).toBeGreaterThan(0);
      expect(retryKinds['imports']).toBe(edgeKindCounts()['imports']);
    } finally {
      await resumed.dispose();
      repairDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects abort during discovery before applying changes or deletes', async () => {
    // A stop asked while the discovery answer is being computed must reject
    // before the answer is applied — no discovered change persisted, no
    // reported delete applied.
    const root = mkdtempSync(join(tmpdir(), 'index-abort-discovery-'));
    const discoveryDb = initializeDatabase(join(root, 'index.db'));
    const discoveryStore = new Store(discoveryDb);
    writeFileSync(join(root, 'a.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(
      join(root, 'b.ts'),
      "import { foo } from './a';\nexport function bar() { return foo(); }\n",
    );
    writeFileSync(
      join(root, 'c.ts'),
      "import { foo } from './a';\nexport function keep() { return foo(); }\n",
    );
    const p = new IndexingPipeline(
      discoveryStore,
      PluginRegistry.createWithDefaults(),
      TraceMcpConfigSchema.parse({}),
      root,
    );
    try {
      await p.indexAll(true);
      const controller = new AbortController();
      writeFileSync(join(root, 'c.ts'), 'export function changedName() { return 5; }\n');
      // biome-ignore lint/suspicious/noExplicitAny: injecting a discovery answer
      (p as any)._incrementalDiscovery = {
        snapshotPath: null,
        discover: async () => {
          controller.abort();
          return { source: 'git-status', changed: ['c.ts'], deleted: ['a.ts'] };
        },
      };
      await expect(p.indexAll(false, { signal: controller.signal })).rejects.toBeInstanceOf(
        IndexAbortedError,
      );
      expect(discoveryStore.getFile('a.ts')).toBeTruthy();
      expect(
        discoveryDb.prepare("SELECT id FROM symbols WHERE name = 'changedName'").all(),
      ).toHaveLength(0);
    } finally {
      await p.dispose();
      discoveryDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a pre-aborted indexFiles batch before persistence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'index-abort-indexfiles-'));
    const filesDb = initializeDatabase(join(root, 'index.db'));
    const filesStore = new Store(filesDb);
    writeFileSync(join(root, 'a.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(
      join(root, 'c.ts'),
      "import { foo } from './a';\nexport function keep() { return foo(); }\n",
    );
    const p = new IndexingPipeline(
      filesStore,
      PluginRegistry.createWithDefaults(),
      TraceMcpConfigSchema.parse({}),
      root,
    );
    try {
      await p.indexAll(true);
      const controller = new AbortController();
      controller.abort();
      writeFileSync(join(root, 'c.ts'), 'export function changedName() { return 5; }\n');
      await expect(p.indexFiles(['c.ts'], { signal: controller.signal })).rejects.toBeInstanceOf(
        IndexAbortedError,
      );
      expect(
        filesDb.prepare("SELECT id FROM symbols WHERE name = 'changedName'").all(),
      ).toHaveLength(0);
    } finally {
      await p.dispose();
      filesDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the no-op full-walk postprocess skip on a clean index', async () => {
    // The incomplete marker belongs to interrupted runs only. A healthy full
    // walk with nothing changed must still take the HEAD+content shortcut
    // instead of re-resolving — periodic verification and dropped-event
    // walks would otherwise pay full resolution on every pass.
    const root = mkdtempSync(join(tmpdir(), 'index-abort-skip-'));
    const skipDb = initializeDatabase(join(root, 'index.db'));
    const skipStore = new Store(skipDb);
    writeFileSync(join(root, 'a.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(
      join(root, 'b.ts'),
      "import { foo } from './a';\nexport function bar() { return foo(); }\n",
    );
    // The HEAD+content shortcut needs a HEAD to compare against.
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'add', 'a.ts', 'b.ts']);
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=Skip Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    const p = new IndexingPipeline(
      skipStore,
      PluginRegistry.createWithDefaults(),
      TraceMcpConfigSchema.parse({}),
      root,
    );
    try {
      await p.indexAll(true);
      expect(skipStore.getRepoMetadata('postprocess_incomplete')).toBeFalsy();
      // biome-ignore lint/suspicious/noExplicitAny: spying on the private resolve entry
      const resolve = vi.spyOn(p as any, 'resolveAllEdges');
      const result = await p.indexAll(false, { discovery: 'full-walk' });
      expect(result.indexed).toBe(0);
      expect(result.errors).toBe(0);
      expect(resolve).not.toHaveBeenCalled();
      expect(skipStore.getRepoMetadata('postprocess_incomplete')).toBeFalsy();
    } finally {
      await p.dispose();
      skipDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores interrupted imports through the deferred reconcile, not around it', async () => {
    // The hardest repair shape: a side-effect import (`import './a'`, no
    // specifiers) persisted by an aborted indexFiles run, then an unrelated
    // edit scheduling the deferred full pass. The deferred pass must
    // reconstruct the extraction state first and clear the mark only after
    // the graph is whole — clearing it on a bare re-resolution blesses the
    // missing import forever.
    const root = mkdtempSync(join(tmpdir(), 'index-abort-deferred-'));
    const deferredDb = initializeDatabase(join(root, 'index.db'));
    const deferredStore = new Store(deferredDb);
    writeFileSync(join(root, 'a.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(
      join(root, 'b.ts'),
      "import { foo } from './a';\nexport function bar() { return foo(); }\n",
    );
    writeFileSync(
      join(root, 'c.ts'),
      "import { foo } from './a';\nexport function keep() { return foo(); }\n",
    );
    const p = new IndexingPipeline(
      deferredStore,
      PluginRegistry.createWithDefaults(),
      TraceMcpConfigSchema.parse({}),
      root,
    );
    const esmImportCount = (): number =>
      (
        deferredDb
          .prepare(
            `SELECT COUNT(*) AS n FROM edges
             WHERE edge_type_id = (SELECT id FROM edge_types WHERE name = 'imports')`,
          )
          .get() as { n: number }
      ).n;
    try {
      await p.indexAll(true);
      const healthyImports = esmImportCount();
      expect(healthyImports).toBeGreaterThan(0);
      writeFileSync(join(root, 'b.ts'), "import './a';\nexport function bar() { return 2; }\n");
      const controller = new AbortController();
      // biome-ignore lint/suspicious/noExplicitAny: spying on the private phase boundary
      const internal = p as any;
      const extract = internal.extractAndPersist.bind(p);
      const spy = vi
        .spyOn(internal, 'extractAndPersist')
        // biome-ignore lint/suspicious/noExplicitAny: passthrough args
        .mockImplementation(async (...args: any[]) => {
          await extract(...args);
          controller.abort();
        });
      await expect(p.indexFiles(['b.ts'], { signal: controller.signal })).rejects.toBeInstanceOf(
        IndexAbortedError,
      );
      spy.mockRestore();
      expect(deferredStore.getRepoMetadata('postprocess_incomplete')).toBe('1');
      // An unrelated incremental edit naturally schedules the deferred full
      // pass; it must repair, not just clear.
      writeFileSync(
        join(root, 'c.ts'),
        "import { foo } from './a';\nexport function keep() { return foo(); }\nexport function newName() { return 7; }\n",
      );
      await p.indexFiles(['c.ts']);
      expect(deferredStore.getRepoMetadata('postprocess_incomplete')).toBe('1');
      await p.__flushEdgeReconcileForTests();
      expect(deferredStore.getRepoMetadata('postprocess_incomplete')).toBeFalsy();
      expect(esmImportCount()).toBe(healthyImports);
    } finally {
      await p.dispose();
      deferredDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('clears extraction state after deferred repair so a later removed import stays removed', async () => {
    // The deferred repair extract populates the same per-run maps the normal
    // pipeline clears in its finally. Without that cleanup, a file whose
    // last import was later removed keeps its stale pending-import entry
    // (the persister only replaces entries for files that HAVE imports) and
    // the resolver resurrects the deleted edge.
    const root = mkdtempSync(join(tmpdir(), 'index-abort-stale-'));
    const staleDb = initializeDatabase(join(root, 'index.db'));
    const staleStore = new Store(staleDb);
    writeFileSync(join(root, 'a.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(
      join(root, 'b.ts'),
      "import { foo } from './a';\nexport function bar() { return foo(); }\n",
    );
    writeFileSync(
      join(root, 'c.ts'),
      "import { foo } from './a';\nexport function keep() { return foo(); }\n",
    );
    const p = new IndexingPipeline(
      staleStore,
      PluginRegistry.createWithDefaults(),
      TraceMcpConfigSchema.parse({}),
      root,
    );
    const importCount = (): number =>
      (
        staleDb
          .prepare(
            `SELECT COUNT(*) AS n FROM edges
             WHERE edge_type_id = (SELECT id FROM edge_types WHERE name = 'imports')`,
          )
          .get() as { n: number }
      ).n;
    try {
      await p.indexAll(true);
      expect(importCount()).toBe(2);
      writeFileSync(join(root, 'b.ts'), "import './a';\nexport function bar() { return 2; }\n");
      const controller = new AbortController();
      // biome-ignore lint/suspicious/noExplicitAny: spying on the private phase boundary
      const internal = p as any;
      const extract = internal.extractAndPersist.bind(p);
      const spy = vi
        .spyOn(internal, 'extractAndPersist')
        // biome-ignore lint/suspicious/noExplicitAny: passthrough args
        .mockImplementation(async (...args: any[]) => {
          await extract(...args);
          controller.abort();
        });
      await expect(p.indexFiles(['b.ts'], { signal: controller.signal })).rejects.toBeInstanceOf(
        IndexAbortedError,
      );
      spy.mockRestore();
      writeFileSync(
        join(root, 'c.ts'),
        "import { foo } from './a';\nexport function keep() { return foo(); }\nexport function added() { return 7; }\n",
      );
      await p.indexFiles(['c.ts']);
      await p.__flushEdgeReconcileForTests();
      expect(importCount()).toBe(2);
      // Now remove b.ts's last import: incremental and forced rebuild must
      // converge to the same graph.
      writeFileSync(join(root, 'b.ts'), 'export function bar() { return 2; }\n');
      await p.indexFiles(['b.ts']);
      const afterEdit = importCount();
      await p.indexAll(true);
      expect(afterEdit).toBe(importCount());
    } finally {
      await p.dispose();
      staleDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['full-walk', 'deferred'])(
    'keeps the repair scope when a %s repair cannot read a dirty file',
    async (mode) => {
      // A repair that fails to re-extract (here an unreadable file, injected
      // portably instead of chmod so Windows/root CI behaves identically)
      // must retain marker + scope — clearing would bless the still-missing
      // edges, and the hash gate would skip the file on every later run.
      const root = mkdtempSync(join(tmpdir(), `index-abort-unreadable-${mode}-`));
      const unreadDb = initializeDatabase(join(root, 'index.db'));
      const unreadStore = new Store(unreadDb);
      writeFileSync(join(root, 'a.ts'), 'export function foo() { return 1; }\n');
      writeFileSync(
        join(root, 'b.ts'),
        "import { foo } from './a';\nexport function bar() { return foo(); }\n",
      );
      writeFileSync(
        join(root, 'c.ts'),
        "import { foo } from './a';\nexport function keep() { return foo(); }\n",
      );
      const p = new IndexingPipeline(
        unreadStore,
        PluginRegistry.createWithDefaults(),
        TraceMcpConfigSchema.parse({}),
        root,
      );
      const importCount = (): number =>
        (
          unreadDb
            .prepare(
              `SELECT COUNT(*) AS n FROM edges
               WHERE edge_type_id = (SELECT id FROM edge_types WHERE name = 'imports')`,
            )
            .get() as { n: number }
        ).n;
      // Portable EACCES: fail reads of b.ts inside the in-process extractor
      // (3-file fixtures never reach the worker-pool threshold). Installed
      // only for the repair phase — the baseline index must be healthy.
      const realExtract = FileExtractor.prototype.extract;
      // biome-ignore lint/suspicious/noExplicitAny: mock handle type
      let readFailureSpy: any = null;
      const armReadFailure = (): void => {
        readFailureSpy = vi.spyOn(FileExtractor.prototype, 'extract').mockImplementation(
          // biome-ignore lint/suspicious/noExplicitAny: passthrough args
          async function (this: unknown, ...args: any[]) {
            if (typeof args[0] === 'string' && args[0].endsWith('b.ts')) return { kind: 'error' };
            return realExtract.apply(this, args as never as Parameters<typeof realExtract>);
          },
        );
      };
      const disarmReadFailure = (): void => {
        readFailureSpy?.mockRestore();
        readFailureSpy = null;
      };
      try {
        await p.indexAll(true);
        expect(importCount()).toBe(2);
        writeFileSync(join(root, 'b.ts'), "import './a';\nexport function bar() { return 2; }\n");
        const controller = new AbortController();
        // biome-ignore lint/suspicious/noExplicitAny: spying on the private phase boundary
        const internal = p as any;
        const extract = internal.extractAndPersist.bind(p);
        const abortSpy = vi
          .spyOn(internal, 'extractAndPersist')
          // biome-ignore lint/suspicious/noExplicitAny: passthrough args
          .mockImplementation(async (...args: any[]) => {
            await extract(...args);
            controller.abort();
          });
        await expect(p.indexFiles(['b.ts'], { signal: controller.signal })).rejects.toBeInstanceOf(
          IndexAbortedError,
        );
        abortSpy.mockRestore();
        expect(unreadStore.getRepoMetadata('postprocess_incomplete')).toBe('1');
        armReadFailure();
        if (mode === 'full-walk') {
          const r = await p.indexAll(false, { discovery: 'full-walk' });
          expect(r.errors).toBe(1);
        } else {
          writeFileSync(
            join(root, 'c.ts'),
            "import { foo } from './a';\nexport function keep() { return foo(); }\nexport function added() { return 7; }\n",
          );
          await p.indexFiles(['c.ts']);
          await p.__flushEdgeReconcileForTests();
        }
        // The failed repair must not have cleared the scope...
        const marker = unreadStore.getRepoMetadata('postprocess_incomplete');
        // ...so once the file is readable again, a normal walk repairs and
        // converges with a forced rebuild.
        disarmReadFailure();
        await p.indexAll(false, { discovery: 'full-walk' });
        const afterRetry = importCount();
        await p.indexAll(true);
        expect({ marker, afterRetry }).toEqual({ marker: '1', afterRetry: importCount() });
      } finally {
        disarmReadFailure();
        await p.dispose();
        unreadDb.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
