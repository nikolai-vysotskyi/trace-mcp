/**
 * TRA-1768: the transit daemon of an update chain full-rebuilt a foreign
 * smoke tree (`<tmp>/multica-task-<id>/opencode/smoke/run`) because a legacy
 * registry row for that ephemeral root got stamped `pendingReindexForVersion`
 * by the post-update migration. Every doomed parse then logged an identical
 * L50 into the shared daemon.log. `markAllProjectsPendingReindex` must
 * withhold the forced-rebuild stamp from ephemeral one-shot roots (the row
 * itself is left for the missing-root sweeps to delete).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeTmpDir, tmpRootOutsideTaskDir } from '../../tests/test-utils.js';

describe('markAllProjectsPendingReindex skips ephemeral roots (TRA-1768)', () => {
  let tmpHome: string;
  let registry: typeof import('../registry.js');
  let REGISTRY_PATH: string;

  beforeEach(async () => {
    tmpHome = tmpRootOutsideTaskDir('trace-1768-');
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    registry = await import('../registry.js');
    ({ REGISTRY_PATH } = await import('../global.js'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    removeTmpDir(tmpHome);
  });

  /** Write registry rows directly (a legacy ephemeral row needs no live dir). */
  function seedRegistryRows(roots: string[]): void {
    fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
    const projects: Record<string, unknown> = {};
    for (const root of roots) {
      projects[root] = {
        name: path.basename(root),
        root,
        dbPath: path.join(tmpHome, 'index', `${path.basename(root)}.db`),
        addedAt: new Date().toISOString(),
      };
    }
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ version: 1, projects }));
  }

  it('stamps normal projects but withholds the forced rebuild from ephemeral tmp roots', () => {
    const normal = path.join(tmpHome, 'proj');
    const ephemeral = path.join(tmpHome, 'multica-task-2505017234', 'opencode', 'smoke', 'run');
    seedRegistryRows([normal, ephemeral]);

    const marked = registry.markAllProjectsPendingReindex('9.9.9');

    expect(marked).toBe(1);
    expect(registry.getProject(normal)?.pendingReindexForVersion).toBe('9.9.9');
    expect(registry.getProject(ephemeral)?.pendingReindexForVersion).toBeUndefined();
  });

  it('leaves the ephemeral row itself untouched (sweeps own its deletion)', () => {
    const ephemeral = path.join(tmpHome, 'multica-task-2505017234', 'opencode', 'smoke', 'run');
    seedRegistryRows([ephemeral]);

    expect(registry.markAllProjectsPendingReindex('9.9.9')).toBe(0);
    expect(registry.getProject(ephemeral)).toBeDefined();
    expect(registry.getProject(ephemeral)?.pendingReindexForVersion).toBeUndefined();
  });
});
