/**
 * TRA-938 regression guard: TopologyStore/DecisionStore/StateEngine each back
 * a single fixed file under TRACE_MCP_HOME, the same file no matter which
 * project asks for it. Before this fix, ProjectResourcePool still kept one
 * SQLite connection per project root onto those files, so registering N
 * projects opened N redundant fds per shared file instead of 1 — the daemon
 * exhausted launchd's 256-fd soft limit and accept() started failing with
 * EMFILE. Object identity across different project roots is the deterministic
 * stand-in for "one connection, not N" — no real fd counting needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TraceMcpConfig } from '../../config.js';
import type { ProjectResourcePool as ProjectResourcePoolType } from '../resource-pool.js';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-resource-pool-'));
  vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(tmpHome, { recursive: true, force: true });
});

async function freshPool(): Promise<ProjectResourcePoolType> {
  const { ProjectResourcePool } = await import('../resource-pool.js');
  return new ProjectResourcePool();
}

const topologyEnabledConfig = { topology: { enabled: true } } as TraceMcpConfig;

describe('ProjectResourcePool — daemon-wide shared resources', () => {
  it('acquire() returns the same store instances for different project roots', async () => {
    const pool = await freshPool();
    const depsA = pool.acquire('/project-a', topologyEnabledConfig);
    const depsB = pool.acquire('/project-b', topologyEnabledConfig);

    expect(depsB.topoStore).toBe(depsA.topoStore);
    expect(depsB.decisionStore).toBe(depsA.decisionStore);
    expect(depsB.stateEngine).toBe(depsA.stateEngine);

    pool.disposeAll();
  });

  it('getSharedDeps() (addProject-style access) returns the same instances acquire() does, without bumping refcount', async () => {
    const pool = await freshPool();
    const acquired = pool.acquire('/project-a', topologyEnabledConfig);
    const viaGetShared = pool.getSharedDeps(topologyEnabledConfig);

    expect(viaGetShared.decisionStore).toBe(acquired.decisionStore);
    expect(viaGetShared.stateEngine).toBe(acquired.stateEngine);
    // getSharedDeps() must not count as a session — only acquire()/release() do.
    expect(pool.getRefCount('/project-a')).toBe(1);

    pool.disposeAll();
  });

  it('getRefCount() stays per-project even though the resources are shared', async () => {
    const pool = await freshPool();
    pool.acquire('/project-a', topologyEnabledConfig);
    pool.acquire('/project-a', topologyEnabledConfig);
    pool.acquire('/project-b', topologyEnabledConfig);

    expect(pool.getRefCount('/project-a')).toBe(2);
    expect(pool.getRefCount('/project-b')).toBe(1);
    expect(pool.getRefCount('/project-c')).toBe(0);

    pool.disposeAll();
  });

  it('release() and disposeProject() never close the shared resources — a later acquire() still returns live handles', async () => {
    const pool = await freshPool();
    const depsA = pool.acquire('/project-a', topologyEnabledConfig);
    pool.release('/project-a');
    pool.disposeProject('/project-a');
    expect(pool.getRefCount('/project-a')).toBe(0);

    // Still the same, still-open instances — not recreated, not closed.
    const depsB = pool.acquire('/project-b', topologyEnabledConfig);
    expect(depsB.decisionStore).toBe(depsA.decisionStore);
    expect(() => depsB.decisionStore!.getStats()).not.toThrow();

    pool.disposeAll();
  });

  it('disposeAll() closes the shared resources; a later acquire() opens fresh ones', async () => {
    const pool = await freshPool();
    const before = pool.acquire('/project-a', topologyEnabledConfig);
    pool.disposeAll();

    // The old handle is closed — using it now throws.
    expect(() => before.decisionStore!.getStats()).toThrow();

    const after = pool.acquire('/project-a', topologyEnabledConfig);
    expect(after.decisionStore).not.toBe(before.decisionStore);

    pool.disposeAll();
  });
});
