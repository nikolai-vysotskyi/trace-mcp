import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { initContentHasher } from '../../util/hash.js';
import * as eventLoop from '../../utils/event-loop.js';
import { extractAndPersist, type ExtractAndPersistResult } from '../extract-and-persist.js';
import { FileExtractor } from '../file-extractor.js';
import { FilePersister } from '../file-persister.js';
import { IndexAbortedError } from '../index-abort.js';
import { buildProjectContext } from '../project-context.js';
import type * as poolMod from '../extract-pool.js';

/** Mirrors the module-private key in extract-and-persist.ts — asserted here
 *  as a black-box behavioral contract (repo_metadata survives close/reopen). */
const FTS_REBUILD_PENDING_KEY = 'fts_rebuild_pending';

// TRA-3238: shutdown races the extract worker pool against the DB.
// ProjectManager.shutdown() aborts the pipeline's signal, then terminates
// the shared ExtractPool (rejecting every in-flight `pool.extract()` call
// with "Pool terminated"), then closes the DB — all while a deferred
// reconcile's repair extraction can still be running, orphaned past its
// drain timeout. Before the fix: the pool-error catch unconditionally fell
// back to in-process extraction, and the unconditional `finally` touched
// `store.db` to restore FTS triggers — throwing a raw TypeError once the DB
// had closed underneath it. Both are guarded now.
describe('extractAndPersist — pool terminate races a closing DB (TRA-3238)', () => {
  let workDir: string;
  let db: Database.Database;
  let store: Store;
  let registry: PluginRegistry;

  beforeEach(async () => {
    await initContentHasher();
    workDir = mkdtempSync(join(tmpdir(), 'extract-pool-terminate-'));
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(
      join(workDir, 'src', 'a.ts'),
      'export function alpha(): string { return "alpha"; }\n',
      'utf-8',
    );
    db = initializeDatabase(':memory:');
    store = new Store(db);
    registry = await PluginRegistry.createWithDefaults();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      db.close();
    } catch {
      /* ignore */
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it('propagates the abort instead of falling back, and never touches the closed DB', async () => {
    const extractSpy = vi.spyOn(FileExtractor.prototype, 'extract');
    const abortController = new AbortController();
    let rejectExtract!: (err: Error) => void;

    const terminatingPool = {
      size: 1,
      extract: vi.fn().mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectExtract = reject;
          }),
      ),
      dropProject: vi.fn(),
      terminate: vi.fn().mockResolvedValue(undefined),
    };

    const result: import('../extract-and-persist.js').ExtractAndPersistResult = {
      indexed: 0,
      skipped: 0,
      errors: 0,
    };

    const outcome = extractAndPersist(
      {
        rootPath: workDir,
        registry,
        store,
        gitignore: undefined,
        workspaces: [],
        fileContentCache: new Map(),
        buildProjectContext: () => buildProjectContext(workDir),
        getPipelineState: () => ({
          store,
          registry,
          config: {} as any,
          rootPath: workDir,
          workspaces: [],
          isIncremental: false,
          changedFileIds: new Set<number>(),
          pendingImports: new Map(),
          fileContentCache: new Map(),
          gitignore: undefined,
        }),
        maybeGetExtractPool: () => terminatingPool as unknown as poolMod.ExtractPool,
        // Force the bulk (trigger-drop) path so the finally block's
        // `enableFts5TriggersAsync` call is actually exercised below.
        ftsRebuildThreshold: 0,
        sortByExtension: (files) => files,
        signal: abortController.signal,
      },
      ['src/a.ts'],
      true,
      result,
    );

    // Wait for pool.extract() to be in flight, then mirror the real
    // shutdown ordering: abort the signal, close the DB, THEN let the
    // pool's termination rejection land.
    await vi.waitFor(() => expect(terminatingPool.extract).toHaveBeenCalled());
    abortController.abort();
    db.close();
    rejectExtract(new Error('Pool terminated'));

    await expect(outcome).rejects.toBeInstanceOf(IndexAbortedError);
    // No fallback to in-process extraction once the run was cancelled.
    expect(extractSpy).not.toHaveBeenCalled();
  });
});

// Reviewer F's follow-up on PR #1961 confirmed two gaps the above test didn't
// cover: (1) skipping the FTS rebuild on a closed DB silently drops symbols
// committed under the dropped-trigger window, with no recovery on reopen;
// (2) the DB can close *inside* enableFts5TriggersAsync's own internal yield
// (after the guard already passed), still throwing a raw TypeError. Both are
// fixed via a durable `repo_metadata` marker set before the triggers are
// dropped and cleared only once the restore fully succeeds — see
// FTS_REBUILD_PENDING_KEY in extract-and-persist.ts.
describe('extractAndPersist — FTS rebuild durability across a shutdown close (TRA-3238 follow-up)', () => {
  let workDir: string;
  let dbPath: string;
  let registry: PluginRegistry;

  function makeParams(store: Store, ftsRebuildThreshold: number) {
    return {
      rootPath: workDir,
      registry,
      store,
      gitignore: undefined,
      workspaces: [],
      fileContentCache: new Map<string, string>(),
      buildProjectContext: () => buildProjectContext(workDir),
      getPipelineState: () => ({
        store,
        registry,
        config: {} as any,
        rootPath: workDir,
        workspaces: [],
        isIncremental: false,
        changedFileIds: new Set<number>(),
        pendingImports: new Map(),
        fileContentCache: new Map(),
        gitignore: undefined,
      }),
      maybeGetExtractPool: () => null,
      ftsRebuildThreshold,
      sortByExtension: (files: string[]) => files,
    };
  }

  beforeEach(async () => {
    await initContentHasher();
    workDir = mkdtempSync(join(tmpdir(), 'extract-fts-durability-'));
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(
      join(workDir, 'src', 'a.ts'),
      'export function alpha(): string { return "alpha"; }\n',
      'utf-8',
    );
    dbPath = join(workDir, 'index.db');
    registry = await PluginRegistry.createWithDefaults();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('repairs the symbols_fts backlog on the next run when the DB closed right after a batch committed (finding #1)', async () => {
    const db = initializeDatabase(dbPath);
    const store = new Store(db);

    // Simulate the shutdown closing the DB the instant this run's batch
    // commits — the synchronous gap between persistBatch resolving and the
    // `finally` block's restore call, with no yield to hook into.
    const realPersistBatch = FilePersister.prototype.persistBatch;
    vi.spyOn(FilePersister.prototype, 'persistBatch').mockImplementation(async function (
      this: FilePersister,
      extractions,
    ) {
      const res = await realPersistBatch.call(this, extractions);
      db.close();
      return res;
    });

    const result: ExtractAndPersistResult = { indexed: 0, skipped: 0, errors: 0 };
    await extractAndPersist(makeParams(store, 0), ['src/a.ts'], true, result);
    expect(result.indexed).toBe(1);
    expect(db.open).toBe(false);

    // Reopen the same DB file fresh, mirroring a project reload after the
    // shutdown that closed it mid-rebuild.
    const db2 = initializeDatabase(dbPath);
    const store2 = new Store(db2);

    // The committed symbol is NOT yet searchable — the rebuild never ran —
    // but the durable marker survived the close, so a future run knows to repair it.
    expect(
      db2.prepare("SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH 'alpha'").all(),
    ).toHaveLength(0);
    expect(store2.getRepoMetadata(FTS_REBUILD_PENDING_KEY)).toBe('1');

    // The project's next run (even one touching no files, like a stray
    // register_edit) repairs the backlog via the leading check.
    const result2: ExtractAndPersistResult = { indexed: 0, skipped: 0, errors: 0 };
    await extractAndPersist(makeParams(store2, 1000), [], false, result2);

    expect(
      db2.prepare("SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH 'alpha'").all(),
    ).toHaveLength(1);
    expect(store2.getRepoMetadata(FTS_REBUILD_PENDING_KEY)).toBeNull();

    db2.close();
  });

  it('does not throw when the DB closes inside enableFts5TriggersAsync’s own internal yield (finding #2)', async () => {
    const db = initializeDatabase(dbPath);
    const store = new Store(db);

    // Exactly two real yields precede the rebuild's own yield for this
    // single-file, pool-less, single-chunk run: the per-file dispatch loop's
    // yield, then persistBatch's leading "own turn first" yield. Let both
    // pass through untouched, then close the DB on the third — the one
    // inside enableFts5TriggersAsync, between its `db.exec('...rebuild...')`
    // and the `db.prepare(...)` call right after.
    const realYield = eventLoop.yieldToEventLoopFair;
    const yieldSpy = vi.spyOn(eventLoop, 'yieldToEventLoopFair');
    yieldSpy.mockImplementationOnce(() => realYield());
    yieldSpy.mockImplementationOnce(() => realYield());
    yieldSpy.mockImplementationOnce(async () => {
      db.close();
    });

    const result: ExtractAndPersistResult = { indexed: 0, skipped: 0, errors: 0 };
    await expect(
      extractAndPersist(makeParams(store, 0), ['src/a.ts'], true, result),
    ).resolves.toBeDefined();

    expect(result.indexed).toBe(1);
    expect(db.open).toBe(false);
  });
});
