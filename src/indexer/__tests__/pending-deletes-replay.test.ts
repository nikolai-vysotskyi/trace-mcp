/**
 * TRA-1998 — deleteFiles skipped on closed DB during graceful shutdown.
 *
 * When watcher-delete events arrive while (or after) the database is closed
 * during daemon shutdown, deleteFiles logs a warning and skips row deletion.
 * To prevent phantom rows from persisting indefinitely across restarts when
 * subsequent indexAll runs take the zero-change incremental fast path (which
 * never reconciles scope), the skipped paths are written to a co-located
 * `<db>.pending-deletes.json` sidecar and replayed before discovery on the
 * next run.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../config.js';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { TypeScriptLanguagePlugin } from '../plugins/language/typescript/index.js';
import { pendingDeletesPathForDb } from '../incremental-discovery.js';
import { IndexingPipeline } from '../pipeline.js';

describe('TRA-1998 pending deletes replay on closed DB', () => {
  let workDir: string;
  let dbPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'tra-1998-'));
    dbPath = join(workDir, 'index.db');
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(
      join(workDir, 'src', 'survivor.ts'),
      'export function survivor() { return "alive"; }\n',
    );
    writeFileSync(
      join(workDir, 'src', 'phantom.ts'),
      'export function phantom() { return "ghost"; }\n',
    );
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function makePipeline(
    store: Store,
    incrementalDiscovery?: {
      discover?: () => Promise<{ source: 'watcher-since'; changed: string[]; deleted: string[] }>;
      queryGit?: () => { changed: string[]; deleted: string[] } | null;
      pendingDeletesPath?: string | null;
    },
  ) {
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config = TraceMcpConfigSchema.parse({
      root: workDir,
      include: ['**/*.ts'],
      exclude: [],
    });
    return new IndexingPipeline(store, registry, config, workDir, undefined, {
      incrementalDiscovery: incrementalDiscovery as any,
    });
  }

  it('records skipped deletes to sidecar on closed DB and replays them on zero-change fast path', async () => {
    const rawDb = initializeDatabase(dbPath);
    const store = new Store(rawDb);
    const pipeline1 = makePipeline(store);

    const initResult = await pipeline1.indexAll(false);
    expect(initResult.totalFiles).toBe(2);
    expect(store.getFile('src/survivor.ts')).toBeDefined();
    expect(store.getFile('src/phantom.ts')).toBeDefined();
    expect(store.getStats().totalSymbols).toBeGreaterThan(0);

    // Simulate shutdown race: DB is closed when watcher-deletes arrive
    rawDb.close();
    expect(store.db.open).toBe(false);

    // Delete phantom file on disk, but survivor stays on disk
    rmSync(join(workDir, 'src', 'phantom.ts'));

    // Attempt deleteFiles on closed DB — includes both phantom (absent) and survivor (still on disk)
    pipeline1.deleteFiles([
      join(workDir, 'src', 'phantom.ts'),
      join(workDir, 'src', 'survivor.ts'),
    ]);

    const sidecarPath = pendingDeletesPathForDb(dbPath);
    expect(existsSync(sidecarPath)).toBe(true);
    const sidecarContent = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
    expect(sidecarContent).toContain('src/phantom.ts');
    expect(sidecarContent).toContain('src/survivor.ts');

    await pipeline1.dispose();

    // Next start / restart: reopen database
    const reopenedDb = initializeDatabase(dbPath);
    const reopenedStore = new Store(reopenedDb);

    // Inject incremental discovery returning zero changes (so scope reconcile is never called)
    const pipeline2 = makePipeline(reopenedStore, {
      discover: async () => ({
        source: 'watcher-since',
        changed: [],
        deleted: [],
      }),
      queryGit: () => ({ changed: [], deleted: [] }),
    });

    const fastResult = await pipeline2.indexAll(false);
    expect(fastResult.incremental).toBe(true);

    // Phantom row must be dropped from store, survivor preserved
    expect(reopenedStore.getFile('src/phantom.ts')).toBeUndefined();
    expect(reopenedStore.getFile('src/survivor.ts')).toBeDefined();

    // Sidecar must have been consumed
    expect(existsSync(sidecarPath)).toBe(false);

    await pipeline2.dispose();
    reopenedDb.close();
  });

  it('drops corrupted sidecar without throwing or aborting the run', async () => {
    const rawDb = initializeDatabase(dbPath);
    const store = new Store(rawDb);
    const pipeline = makePipeline(store);

    await pipeline.indexAll(false);
    expect(store.getFile('src/survivor.ts')).toBeDefined();

    // Write malformed JSON into the sidecar
    const sidecarPath = pendingDeletesPathForDb(dbPath);
    writeFileSync(sidecarPath, '{ corrupted json: not valid ...');
    expect(existsSync(sidecarPath)).toBe(true);

    // replayPendingDeletes should handle the corrupt sidecar safely
    expect(() => pipeline.replayPendingDeletes()).not.toThrow();
    expect(existsSync(sidecarPath)).toBe(false);

    // Next indexAll runs without failing
    const result = await pipeline.indexAll(false, { discovery: 'full-walk' });
    expect(result.errors).toBe(0);

    await pipeline.dispose();
    rawDb.close();
  });
});
