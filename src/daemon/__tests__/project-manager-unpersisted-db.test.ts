/**
 * TRA-2898: Lifecycle for unpersisted (persist: false) and subproject index DBs.
 *
 * Verifies that a project added with persist: false (e.g. read-mostly subprojects
 * served on first MCP connect without registry.json rows) routes its database to
 * EPHEMERAL_INDEX_DIR instead of polluting INDEX_DIR with unregistered orphan DBs.
 * Also verifies cleanup via removeProject().
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeTmpDir, tmpRootOutsideTaskDir } from '../../../tests/test-utils.js';

vi.mock('../../indexer/pipeline.js', () => {
  class FakeIndexingPipeline {
    async indexAll() {
      return { totalFiles: 0, indexed: 0, skipped: 0, errors: 0, durationMs: 0 };
    }
    async indexFiles() {
      return { totalFiles: 0, indexed: 0, skipped: 0, errors: 0, durationMs: 0 };
    }
    deleteFiles() {}
    async dispose() {}
  }
  return { IndexingPipeline: FakeIndexingPipeline };
});

vi.mock('../../indexer/watcher.js', () => {
  class FakeWatcher {
    async start() {}
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

describe('ProjectManager unpersisted DB lifecycle (TRA-2898)', () => {
  let tmpHome: string;
  let tmpProjects: string;
  let pmRef: { shutdown(): Promise<void> } | undefined;

  beforeEach(() => {
    tmpHome = tmpRootOutsideTaskDir('tra2898-home-');
    tmpProjects = tmpRootOutsideTaskDir('tra2898-proj-');
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    pmRef = undefined;
  });

  afterEach(async () => {
    if (pmRef) {
      await pmRef.shutdown();
      pmRef = undefined;
    }
    vi.unstubAllEnvs();
    vi.resetModules();
    removeTmpDir(tmpHome);
    removeTmpDir(tmpProjects);
  });

  it('routes persist: false projects outside ephemeral patterns to EPHEMERAL_INDEX_DIR', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const { getProject } = await import('../../registry.js');
    const { INDEX_DIR, EPHEMERAL_INDEX_DIR, projectName, projectHash } = await import(
      '../../global.js'
    );
    const { scanIndexDir } = await import('../../cli/prune.js');

    const projectRoot = path.join(tmpProjects, 'empty');
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(path.join(projectRoot, 'package.json'), '{}');

    const pm = new ProjectManager();
    pmRef = pm;

    const managed = await pm.addProject(projectRoot, { watch: false, persist: false });

    // Not registered in registry.json
    expect(getProject(projectRoot)).toBeNull();

    // DB lives in EPHEMERAL_INDEX_DIR, not INDEX_DIR
    const expectedEphemeralDb = path.join(
      EPHEMERAL_INDEX_DIR,
      `${projectName(projectRoot)}-${projectHash(projectRoot)}.db`,
    );
    const topLevelDb = path.join(
      INDEX_DIR,
      `${projectName(projectRoot)}-${projectHash(projectRoot)}.db`,
    );

    expect(managed.db.name).toBe(expectedEphemeralDb);
    expect(existsSync(expectedEphemeralDb)).toBe(true);
    expect(existsSync(topLevelDb)).toBe(false);

    // Not categorized as orphan_unregistered by top-level scanIndexDir
    const candidates = scanIndexDir();
    const orphanMatch = candidates.find((c) => c.basename.includes('empty'));
    expect(orphanMatch).toBeUndefined();

    // removeProject cleans up the ephemeral DB
    await pm.removeProject(projectRoot);
    expect(existsSync(expectedEphemeralDb)).toBe(false);
  });

  it('honors explicit opts.dbPath when provided', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const customDb = path.join(tmpHome, 'custom.db');

    const projectRoot = path.join(tmpProjects, 'custom-root');
    mkdirSync(projectRoot, { recursive: true });

    const pm = new ProjectManager();
    pmRef = pm;

    const managed = await pm.addProject(projectRoot, {
      watch: false,
      persist: false,
      dbPath: customDb,
    });

    expect(managed.db.name).toBe(customDb);
    expect(existsSync(customDb)).toBe(true);
  });
});
