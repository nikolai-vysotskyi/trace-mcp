/**
 * TRA-2257 regression test:
 * Initial post-update rebuild encounters transient SQLITE_BUSY / database lock.
 * Bounded retry must complete rebuild and clear pendingReindexForVersion.
 * Permanent lock must leave the project in error state with diagnostic error.
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

    // Now instantiate two pipelines referencing the same DB file
    const store1 = new Store(initializeDatabase(dbPath));
    const store2 = new Store(initializeDatabase(dbPath));
    const reg1 = new PluginRegistry();
    reg1.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const reg2 = new PluginRegistry();
    reg2.registerLanguagePlugin(new TypeScriptLanguagePlugin());

    const pipe1 = new IndexingPipeline(store1, reg1, config, testRoot);
    const pipe2 = new IndexingPipeline(store2, reg2, config, testRoot);

    try {
      const [r1, r2] = await Promise.all([pipe1.indexAll(true), pipe2.indexAll(true)]);
      expect(r1.errors).toBe(0);
      expect(r2.errors).toBe(0);
      expect(r1.totalFiles).toBeGreaterThanOrEqual(1);
      expect(r2.totalFiles).toBeGreaterThanOrEqual(1);
    } finally {
      await pipe1.dispose();
      await pipe2.dispose();
      store1.db.close();
      store2.db.close();
    }
  });
});
