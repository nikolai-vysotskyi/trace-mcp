/**
 * TRA-2257 regression test:
 * Initial post-update rebuild encounters transient SQLITE_BUSY / database lock.
 * Bounded retry must complete rebuild and clear pendingReindexForVersion.
 * Permanent lock must leave the project in error state with diagnostic error.
 * Immediate transaction mode prevents SQLITE_BUSY_SNAPSHOT during concurrent indexing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as registry from '../../src/registry.js';
import { ProjectManager } from '../../src/daemon/project-manager.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { FilePersister } from '../../src/indexer/file-persister.js';
import type { FileExtraction, PipelineState } from '../../src/indexer/pipeline-state.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';

describe('TRA-2257: SQLITE_BUSY initial rebuild recovery', () => {
  let tmpHome: string;
  let testRoot: string;
  let pm: ProjectManager;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-tra2257-home-'));
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-tra2257-proj-'));
    process.env.TRACE_MCP_DATA_DIR = tmpHome;
    fs.mkdirSync(path.join(testRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(testRoot, 'src', 'index.ts'),
      'export function hello(): string { return "world"; }\n',
    );
    registry.registerProject(testRoot);
  });

  afterEach(async () => {
    if (pm) {
      await pm.shutdown();
    }
    delete process.env.TRACE_MCP_DATA_DIR;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(testRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('completes rebuild and clears pendingReindexForVersion after transient database lock', async () => {
    registry.markAllProjectsPendingReindex('3.34.7');
    expect(registry.getProject(testRoot)?.pendingReindexForVersion).toBe('3.34.7');

    pm = new ProjectManager();

    // Spy on IndexingPipeline.prototype.indexAll to simulate transient lock on first call
    let attempts = 0;
    const origIndexAll = IndexingPipeline.prototype.indexAll;
    vi.spyOn(IndexingPipeline.prototype, 'indexAll').mockImplementation(async function (
      this: IndexingPipeline,
      ...args: unknown[]
    ) {
      attempts++;
      if (attempts === 1) {
        const busyErr = Object.assign(new Error('SqliteError: database is locked'), {
          code: 'SQLITE_BUSY',
          codeName: 'SQLITE_BUSY',
        });
        throw busyErr;
      }
      return origIndexAll.apply(this, args as [boolean?, unknown?]);
    });

    const managed = await pm.addProject(testRoot, { watch: false, persist: true });
    await managed.initialIndexPromise;

    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(managed.status).toBe('ready');
    expect(managed.error).toBeUndefined();

    // pendingReindexForVersion must be cleared on successful recovery
    const projectEntry = registry.getProject(testRoot);
    expect(projectEntry?.pendingReindexForVersion).toBeUndefined();
  });

  it('leaves project in error status with diagnosable message on permanent database lock', async () => {
    registry.markAllProjectsPendingReindex('3.34.7');
    expect(registry.getProject(testRoot)?.pendingReindexForVersion).toBe('3.34.7');

    pm = new ProjectManager();

    vi.spyOn(IndexingPipeline.prototype, 'indexAll').mockImplementation(async function () {
      throw Object.assign(new Error('SqliteError: database is locked'), {
        code: 'SQLITE_BUSY',
        codeName: 'SQLITE_BUSY',
      });
    });

    const managed = await pm.addProject(testRoot, { watch: false, persist: true });
    await managed.initialIndexPromise;

    expect(managed.status).toBe('error');
    expect(managed.error).toContain('database is locked');

    // pendingReindexForVersion remains in registry because the rebuild never finished
    const projectEntry = registry.getProject(testRoot);
    expect(projectEntry?.pendingReindexForVersion).toBe('3.34.7');
  });

  it('concurrent indexing on existing populated database succeeds without SQLITE_BUSY_SNAPSHOT', async () => {
    const dbPath = path.join(testRoot, 'shared.db');

    // Seed database
    const storeSeed = new Store(initializeDatabase(dbPath));
    const regSeed = new PluginRegistry();
    regSeed.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config = { root: testRoot, include: ['src/**/*.ts'], exclude: [], plugins: [] };
    const seedPipe = new IndexingPipeline(storeSeed, regSeed, config, testRoot);
    await seedPipe.indexAll();
    await seedPipe.dispose();
    storeSeed.db.close();

    // Now instantiate two stores referencing the same DB file
    const store1 = new Store(initializeDatabase(dbPath));
    const store2 = new Store(initializeDatabase(dbPath));
    const reg1 = new PluginRegistry();
    reg1.registerLanguagePlugin(new TypeScriptLanguagePlugin());

    // Interleave concurrent write between read and write in persistBatch.
    // When store1 reads symbols during persistBatch (tryFastSymbolUpdate),
    // connection 2 attempts a write.
    // Under pre-fix deferred transaction, connection 2's commit invalidates store1's WAL read snapshot,
    // causing store1 to crash with SQLITE_BUSY_SNAPSHOT ("database is locked").
    // Under immediate transaction, store1 holds the RESERVED lock up front, so connection 2 cannot commit
    // during store1's transaction, preventing snapshot divergence.
    let concurrentWriteAttempted = false;
    let writeBlockedByImmediateLock = false;
    const origGetSymbols = store1.getSymbolsByFile.bind(store1);
    store1.getSymbolsByFile = (fileId: number) => {
      const syms = origGetSymbols(fileId);
      if (!concurrentWriteAttempted) {
        concurrentWriteAttempted = true;
        try {
          store2.db.pragma('busy_timeout = 50');
          store2.db.prepare('UPDATE files SET byte_length = 999 WHERE id = ?').run(fileId);
        } catch {
          writeBlockedByImmediateLock = true;
        }
      }
      return syms;
    };

    // Modify file so it is not skipped and enters persistBatch with existingId (exercising tryFastSymbolUpdate)
    fs.writeFileSync(
      path.join(testRoot, 'src', 'index.ts'),
      'export function hello(): string { return "world-updated"; }\n',
    );

    const pipe1 = new IndexingPipeline(store1, reg1, config, testRoot);

    try {
      const r1 = await pipe1.indexAll(true);
      expect(r1.errors).toBe(0);
      expect(r1.totalFiles).toBeGreaterThanOrEqual(1);
      expect(writeBlockedByImmediateLock).toBe(true);
    } finally {
      await pipe1.dispose();
      store1.db.close();
      store2.db.close();
    }
  });

  it('FilePersister.persistBatch retries and succeeds when another connection temporarily holds write lock', async () => {
    const dbPath = path.join(testRoot, 'shared-retry.db');
    const db1 = initializeDatabase(dbPath);
    const db2 = initializeDatabase(dbPath);
    db1.pragma('busy_timeout = 20');
    db2.pragma('busy_timeout = 20');

    const store1 = new Store(db1);
    const state: PipelineState = {
      store: store1,
      fileIdMap: new Map(),
      changedFileIds: new Set(),
      pendingImports: new Map(),
      isIncremental: false,
    };
    const persister = new FilePersister(state, () => {});

    // Hold write lock on connection 2 for 80ms
    let lockReleased = false;
    const timer = setTimeout(() => {
      lockReleased = true;
      db2.prepare('COMMIT').run();
    }, 80);
    db2.prepare('BEGIN IMMEDIATE').run();

    const extraction: FileExtraction = {
      relPath: 'src/index.ts',
      existingId: null,
      hash: 'h1',
      contentSize: 100,
      language: 'typescript',
      symbols: [],
      otherEdges: [],
      importEdges: [],
      routes: [],
      components: [],
      migrations: [],
      frameworkExtracts: [],
    };

    try {
      await persister.persistBatch([extraction]);
      expect(lockReleased).toBe(true);
    } finally {
      clearTimeout(timer);
      db1.close();
      db2.close();
    }
  });
});
