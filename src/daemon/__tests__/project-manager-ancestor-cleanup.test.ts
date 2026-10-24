/**
 * TRA-2558: Immediate cleanup of descendant subtree from ancestor SQLite DB
 *
 * Verifies that when a nested project B is registered inside an already-indexed
 * ancestor A (A/B), files belonging to B are immediately deleted from A's SQLite
 * database (files, symbols, caches) to prevent double-indexing.
 *
 * Also verifies that when B is removed, coverage reconcile is requested on A so
 * files return to A's index.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../indexer/watcher.js', () => {
  class FakeWatcher {
    root = '';
    async start(rootPath: string) {
      this.root = rootPath;
    }
    async restartWithExcludes() {}
    async stop() {}
    async unsubscribe() {}
    async drain() {}
  }
  return { FileWatcher: FakeWatcher };
});

vi.mock('../../server/server.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    createServer: () => ({
      server: { close: async () => undefined },
      dispose: () => undefined,
    }),
  };
});

let tmpHome: string;
let umbrella: string;
let child: string;
let pmRef: { shutdown(): Promise<void> } | undefined;

function makeProjectDir(...segments: string[]): string {
  const dir = join(tmpHome, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-ancestor-cleanup-'));
  vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
  vi.resetModules();
  umbrella = makeProjectDir('ws');
  child = makeProjectDir('ws', 'child-repo');
  pmRef = undefined;
});

afterEach(async () => {
  if (pmRef) {
    try {
      await pmRef.shutdown();
    } catch {
      /* non-fatal teardown */
    }
    pmRef = undefined;
  }
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(tmpHome, { recursive: true, force: true });
}, 30_000);

describe('ProjectManager ancestor subtree DB cleanup (TRA-2558)', () => {
  it('immediately cleans descendant subtree files from ancestor DB upon registration', async () => {
    // 1. Create files in ancestor and in descendant subfolder
    writeFileSync(join(umbrella, 'root.ts'), 'export const root = 1;\n');
    writeFileSync(join(child, 'nested.ts'), 'export const nested = 2;\n');

    const { ProjectManager } = await import('../project-manager.js');
    const pm = new ProjectManager();
    pmRef = pm;

    // 2. Add and index the ancestor project first
    const managedUmbrella = await pm.addProject(umbrella);
    await managedUmbrella.initialIndexPromise;

    // Both files are indexed in ancestor DB before child registration
    const initialAncestorFiles = managedUmbrella.store.getAllFiles().map((f) => f.path);
    expect(initialAncestorFiles).toContain('root.ts');
    expect(initialAncestorFiles).toContain('child-repo/nested.ts');

    // 3. Register the nested descendant project
    const managedChild = await pm.addProject(child);
    await managedChild.initialIndexPromise;

    // 4. Ancestor DB must immediately no longer contain the child's files
    const cleanedAncestorFiles = managedUmbrella.store.getAllFiles().map((f) => f.path);
    expect(cleanedAncestorFiles).toContain('root.ts');
    expect(cleanedAncestorFiles).not.toContain('child-repo/nested.ts');

    // Child DB contains its own file
    const childFiles = managedChild.store.getAllFiles().map((f) => f.path);
    expect(childFiles).toContain('nested.ts');

    // 5. Unregister the descendant project
    await pm.removeProject(child, { keepDbFiles: true });

    // Flush coverage reconcile on ancestor
    await managedUmbrella.pipeline.__flushCoverageReconcileForTests();

    // Ancestor picks child's files back up
    const restoredAncestorFiles = managedUmbrella.store.getAllFiles().map((f) => f.path);
    expect(restoredAncestorFiles).toContain('root.ts');
    expect(restoredAncestorFiles).toContain('child-repo/nested.ts');
  }, 60_000);

  it('does not re-insert descendant files when ancestor indexing is in-flight during descendant registration (TRA-2558 P1)', async () => {
    writeFileSync(join(umbrella, 'root.ts'), 'export const root = 1;\n');
    writeFileSync(join(child, 'nested.ts'), 'export const nested = 2;\n');

    const { ProjectManager } = await import('../project-manager.js');
    const pm = new ProjectManager();
    pmRef = pm;

    const managedUmbrella = await pm.addProject(umbrella);
    await managedUmbrella.initialIndexPromise;

    // Queue an indexFiles batch on umbrella for child/nested.ts and umbrella/root.ts,
    // while concurrently registering child repo
    const lateBatch = [join(child, 'nested.ts'), join(umbrella, 'root.ts')];

    // Hold umbrella lock briefly to simulate batch in flight
    let releaseHold: () => void;
    const holdPromise = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    const pipelineAny = managedUmbrella.pipeline as unknown as { _lock: Promise<unknown> };
    pipelineAny._lock = pipelineAny._lock.then(async () => {
      await holdPromise;
    });

    // Enqueue the indexFiles call: it passes the initial filterIndexablePaths check before child is registered!
    const indexFilesPromise = managedUmbrella.pipeline.indexFiles(lateBatch);

    // Register child while indexFiles is waiting on lock
    const addDescendantPromise = pm.addProject(child);

    // Now release the hold so both indexFiles and cleanManagedAncestorSubtrees can proceed
    releaseHold!();

    await Promise.all([indexFilesPromise, addDescendantPromise]);
    await (await pm.getProject(child))?.initialIndexPromise;

    // Ancestor DB must NOT contain child files even though indexFiles was queued with them!
    const ancestorFiles = managedUmbrella.store.getAllFiles().map((f) => f.path);
    expect(ancestorFiles).toContain('root.ts');
    expect(ancestorFiles).not.toContain('child-repo/nested.ts');
  }, 60_000);

  it('restores descendant files into ancestor index even if onDisk and indexed file counts match (TRA-2558 P3)', async () => {
    writeFileSync(join(umbrella, 'root.ts'), 'export const root = 1;\n');
    writeFileSync(join(child, 'nested.ts'), 'export const nested = 2;\n');

    const { ProjectManager } = await import('../project-manager.js');
    const pm = new ProjectManager();
    pmRef = pm;

    const managedUmbrella = await pm.addProject(umbrella);
    await managedUmbrella.initialIndexPromise;

    // Register child
    const managedChild = await pm.addProject(child);
    await managedChild.initialIndexPromise;

    // In umbrella store, cleanedAncestorFiles has only 'root.ts' (1 file).
    expect(managedUmbrella.store.getAllFiles().map((f) => f.path)).toEqual(['root.ts']);

    // Now on disk, umbrella has 2 files: root.ts and child-repo/nested.ts.
    // If we insert another dummy file into umbrella's DB so indexed == 2 (e.g. non-disk or mock row),
    // gap = onDisk (2) - indexed (2) = 0.
    // Under unforced logic (gap < COVERAGE_DRIFT_MIN_FILES), reconcile would bail out.
    // But with force: true, reconcile must run and re-index child-repo/nested.ts!
    managedUmbrella.store.insertFile('dummy.ts', 'typescript', 'hash', 10, null, null);
    expect(managedUmbrella.store.getAllFiles().length).toBe(2);

    // Remove child
    await pm.removeProject(child, { keepDbFiles: true });

    // Flush coverage reconcile
    await managedUmbrella.pipeline.__flushCoverageReconcileForTests();

    // Verify child-repo/nested.ts was re-indexed into umbrella
    const restoredFiles = managedUmbrella.store.getAllFiles().map((f) => f.path);
    expect(restoredFiles).toContain('root.ts');
    expect(restoredFiles).toContain('child-repo/nested.ts');
  }, 60_000);
});
