/**
 * TRA-18: `doctor --fix`/`--dry-run` should be able to clean up the registry
 * itself (missing-root entries, overlap containers), not just report on it.
 * Isolated via TRACE_MCP_DATA_DIR, same pattern as registry-health.test.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('doctor registry fix (TRA-18)', () => {
  let tmpHome: string;
  let registry: typeof import('../../src/registry.js');
  let doctor: typeof import('../../src/cli/doctor.js');

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-doctor-'));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    registry = await import('../../src/registry.js');
    doctor = await import('../../src/cli/doctor.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function makeProjectDir(name: string): string {
    const dir = path.join(tmpHome, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('dry-run previews removal without touching the registry', () => {
    const alive = makeProjectDir('alive');
    const gone = makeProjectDir('gone');
    registry.registerProject(alive);
    registry.registerProject(gone);
    fs.rmSync(gone, { recursive: true, force: true });

    const report = doctor.diagnoseRegistry();
    const fix = doctor.fixRegistryIssues(report, { dryRun: true });

    expect(fix.removedMissingRoots).toEqual([gone]);
    expect(
      registry
        .listProjects()
        .map((e) => e.root)
        .sort(),
    ).toEqual([alive, gone].sort());
  });

  it('--fix removes entries whose folder is gone', () => {
    const alive = makeProjectDir('alive');
    const gone = makeProjectDir('gone');
    registry.registerProject(alive);
    registry.registerProject(gone);
    fs.rmSync(gone, { recursive: true, force: true });

    const report = doctor.diagnoseRegistry();
    const fix = doctor.fixRegistryIssues(report, { dryRun: false });

    expect(fix.removedMissingRoots).toEqual([gone]);
    expect(registry.listProjects().map((e) => e.root)).toEqual([alive]);
  });

  it('--fix removes the ancestor of an overlapping pair, keeps the descendant', () => {
    const umbrella = makeProjectDir('ws');
    const child = makeProjectDir('ws/app');
    registry.registerProject(umbrella);
    registry.registerProject(child);

    const report = doctor.diagnoseRegistry();
    expect(report.overlaps).toHaveLength(1);

    const fix = doctor.fixRegistryIssues(report, { dryRun: false });
    expect(fix.removedOverlapContainers).toEqual([umbrella]);
    expect(registry.listProjects().map((e) => e.root)).toEqual([child]);
  });

  it('is a no-op when the registry is healthy', () => {
    const alive = makeProjectDir('alive');
    registry.registerProject(alive);

    const report = doctor.diagnoseRegistry();
    const fix = doctor.fixRegistryIssues(report, { dryRun: false });

    expect(fix.removedMissingRoots).toEqual([]);
    expect(fix.removedOverlapContainers).toEqual([]);
    expect(registry.listProjects()).toHaveLength(1);
  });
});
