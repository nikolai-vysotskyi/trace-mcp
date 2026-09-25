/**
 * TRA-1923: the from-scratch bulk-load window (synchronous=OFF) assumes
 * exclusive DB access. Two indexers on the same DB file (overlapping daemon
 * restart, shared-DB roots) must not both enter it — the loser indexes with
 * crash-safe pragmas instead of tearing FTS5.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { LOCKS_DIR } from '../../src/global.js';
import { bulkIndexLockName, IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { acquireLock, releaseLock, type LockHandle } from '../../src/utils/pid-lock.js';

function makeFileBackedSetup(
  rootDir: string,
  dbPath: string,
): {
  store: Store;
  pipeline: IndexingPipeline;
} {
  const store = new Store(initializeDatabase(dbPath));
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  const config: TraceMcpConfig = {
    root: rootDir,
    include: ['src/**/*.ts'],
    exclude: [],
    plugins: [],
  };
  const pipeline = new IndexingPipeline(store, registry, config, rootDir, undefined, {
    coverageReconcileDebounceMs: 10 * 60_000,
    reconcileDebounceMs: 10 * 60_000,
  });
  return { store, pipeline };
}

describe('bulk-index cross-process guard (TRA-1923)', () => {
  let rootDir: string;
  let dbPath: string;
  let locksHeld: LockHandle[] = [];

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-bulk-'));
    fs.mkdirSync(path.join(rootDir, 'src'));
    fs.writeFileSync(path.join(rootDir, 'src', 'a.ts'), 'export function alpha() { return 1; }\n');
    dbPath = path.join(rootDir, 'index.db');
  });

  afterEach(() => {
    for (const h of locksHeld) releaseLock(h);
    locksHeld = [];
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('indexAll succeeds with crash-safe pragmas while another indexer holds the bulk lock', async () => {
    // Simulate the overlapping indexer: same DB file, lock already claimed
    // (same pid triggers the live-holder path in acquireLock, exactly like a
    // second daemon process would).
    locksHeld.push(
      acquireLock({ lockDir: LOCKS_DIR, name: bulkIndexLockName(dbPath), op: 'test-overlap' }),
    );
    const { store, pipeline } = makeFileBackedSetup(rootDir, dbPath);
    try {
      const result = await pipeline.indexAll();
      expect(result.totalFiles).toBe(1);
      expect(store.getStats().totalFiles).toBe(1);
    } finally {
      await pipeline.dispose();
      store.db.close();
    }
  });

  it('the bulk lock is released when indexAll settles', async () => {
    const { store, pipeline } = makeFileBackedSetup(rootDir, dbPath);
    try {
      await pipeline.indexAll();
    } finally {
      await pipeline.dispose();
      store.db.close();
    }
    // Acquirable afterwards proves the pipeline released it in its finally
    // (a leak would throw LockError here).
    const probe = acquireLock({
      lockDir: LOCKS_DIR,
      name: bulkIndexLockName(dbPath),
      op: 'test-probe',
    });
    locksHeld.push(probe);
  });
});
