import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { initContentHasher } from '../../util/hash.js';
import { extractAndPersist } from '../extract-and-persist.js';
import { FileExtractor } from '../file-extractor.js';
import { IndexAbortedError } from '../index-abort.js';
import { buildProjectContext } from '../project-context.js';
import type * as poolMod from '../extract-pool.js';

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
