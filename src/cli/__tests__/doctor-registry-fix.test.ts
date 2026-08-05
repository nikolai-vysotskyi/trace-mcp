import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TRA-50: `doctor --fix` already sweeps stale/overlapping registry entries
// non-interactively; `--fix-interactive` didn't touch the registry at all,
// leaving overlap cleanup to a manual `trace-mcp remove <path>` step. This
// pins the interactive counterpart: one confirm for the missing-root sweep,
// one per overlapping pair, and a decline leaves the entry registered.

const confirmMock = vi.fn();
vi.mock('@clack/prompts', () => ({
  confirm: (...args: unknown[]) => confirmMock(...args),
  isCancel: (v: unknown) => v === Symbol.for('clack:cancel'),
}));

describe('fixRegistryIssuesInteractive (TRA-50)', () => {
  let tmpHome: string;
  let registry: typeof import('../../registry.js');
  let doctor: typeof import('../doctor.js');

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-doctor-fix-'));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    confirmMock.mockReset();
    registry = await import('../../registry.js');
    doctor = await import('../doctor.js');
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

  it('removes the overlap container when confirmed, keeps it when declined', async () => {
    const umbrella = makeProjectDir('ws');
    const child = makeProjectDir('ws/child');
    registry.registerProject(umbrella);
    registry.registerProject(child);

    const health = doctor.diagnoseRegistry();
    expect(health.overlaps).toHaveLength(1);

    confirmMock.mockResolvedValueOnce(false);
    const declined = await doctor.fixRegistryIssuesInteractive(health);
    expect(declined.removedOverlapContainers).toEqual([]);
    expect(registry.listProjects().map((e) => e.root)).toContain(umbrella);

    confirmMock.mockResolvedValueOnce(true);
    const accepted = await doctor.fixRegistryIssuesInteractive(health);
    expect(accepted.removedOverlapContainers).toEqual([umbrella]);
    expect(registry.listProjects().map((e) => e.root)).not.toContain(umbrella);
  });

  it('prunes missing-root entries only on confirmation', async () => {
    const gone = makeProjectDir('gamma');
    registry.registerProject(gone);
    fs.rmSync(gone, { recursive: true, force: true });

    const health = doctor.diagnoseRegistry();
    expect(health.staleCount).toBe(1);

    confirmMock.mockResolvedValueOnce(true);
    const result = await doctor.fixRegistryIssuesInteractive(health);
    expect(result.removedMissingRoots).toEqual([gone]);
    expect(registry.listProjects()).toEqual([]);
  });
});
