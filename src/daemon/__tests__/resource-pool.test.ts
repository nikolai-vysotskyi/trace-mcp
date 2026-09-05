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
const topologyDisabledConfig = { topology: { enabled: false } } as TraceMcpConfig;

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

    expect(viaGetShared.topoStore).toBe(acquired.topoStore);
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

  it('a topology-disabled project loading first does not permanently disable topology for later projects', async () => {
    const pool = await freshPool();

    // A topology-disabled project acquires first — nothing to backfill from,
    // so topoStore stays null for this call.
    const depsDisabled = pool.acquire('/project-disabled', topologyDisabledConfig);
    expect(depsDisabled.topoStore).toBeNull();

    // A topology-enabled project acquires next. Before the TRA-938 review fix,
    // ensureShared() short-circuited on the already-created `shared` object and
    // returned the cached `topoStore: null` forever, regardless of this
    // project's own config — silently deregistering topology tools daemon-wide.
    const depsEnabled = pool.acquire('/project-enabled', topologyEnabledConfig);
    expect(depsEnabled.topoStore).not.toBeNull();

    // The backfilled instance is the one every subsequent caller gets too —
    // including a later re-check from the disabled project.
    const depsDisabledAgain = pool.acquire('/project-disabled', topologyDisabledConfig);
    expect(depsDisabledAgain.topoStore).toBe(depsEnabled.topoStore);

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
