/**
 * TRA-1105: a one-shot agent workdir that is already gone still got the full
 * 7-day `sweepMissingRoots` grace, and its registry row kept the matching
 * `.config.json` section alive for the same week (a registered root is what
 * `pruneProjectConfigSections` protects). On the reported machine that was
 * 17 of 47 sections — 46 KB of a 62 KB file that is parsed on every start.
 *
 * The grace exists for a root that can come back: an unmounted volume, a
 * detached external disk. An ephemeral run directory cannot — the run that
 * created it finished, and `registerProject` refuses to persist such a root at
 * all since TRA-396. Missing + ephemeral is therefore unambiguously dead.
 *
 * An explicit `add`/`init` of a workdir-shaped path is a deliberate act and
 * keeps its grace, which is the case the last test pins.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeTmpDir, tmpRootOutsideTaskDir } from '../../tests/test-utils.js';

describe('sweepMissingRoots: no grace for a dead ephemeral workdir (TRA-1105)', () => {
  let tmpHome: string;
  let registry: typeof import('../registry.js');
  let configJsonc: typeof import('../config-jsonc.js');
  let GLOBAL_CONFIG_PATH: string;
  let REGISTRY_PATH: string;

  beforeEach(async () => {
    tmpHome = tmpRootOutsideTaskDir('trace-ephemeral-sweep-');
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    registry = await import('../registry.js');
    configJsonc = await import('../config-jsonc.js');
    ({ GLOBAL_CONFIG_PATH, REGISTRY_PATH } = await import('../global.js'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    removeTmpDir(tmpHome);
  });

  /** Write a registry row for a root that does not exist on disk. */
  function seedRegistry(root: string, extra: Record<string, unknown> = {}): void {
    fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
    fs.writeFileSync(
      REGISTRY_PATH,
      JSON.stringify({
        version: 1,
        projects: {
          [root]: {
            name: path.basename(root),
            root,
            dbPath: path.join(tmpHome, 'index', `${path.basename(root)}.db`),
            addedAt: new Date().toISOString(),
            ...extra,
          },
        },
      }),
    );
  }

  function seedConfigSection(root: string): void {
    fs.mkdirSync(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      GLOBAL_CONFIG_PATH,
      JSON.stringify({ projects: { [root]: { root: '.', include: ['src/**'] } } }, null, 2),
    );
  }

  it('drops a missing multica-task scratch root on the first sighting', () => {
    const root = path.join(tmpHome, 'multica-task-3265850447', 'tmpl06qk62l');
    seedRegistry(root);

    const { removed, newlyMissing } = registry.sweepMissingRoots(7);

    expect(removed).toEqual([root]);
    expect(newlyMissing).toEqual([]);
    expect(registry.listProjects()).toEqual([]);
  });

  it('drops a missing repo-checkout workdir root on the first sighting', () => {
    const root = path.join(
      tmpHome,
      'multica_workspaces_host',
      'ws-id',
      'run-id',
      'workdir',
      'repo',
    );
    seedRegistry(root);

    expect(registry.sweepMissingRoots(7).removed).toEqual([root]);
  });

  it('lets the same pass collect the config section it was pinning', () => {
    const root = path.join(tmpHome, 'multica-task-3265850447', 'tmpust64rmw');
    seedRegistry(root);
    seedConfigSection(root);

    // The order softGcSweep runs them in.
    registry.sweepMissingRoots(7);
    expect(configJsonc.pruneProjectConfigSections()).toEqual([root]);
    expect(JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')).projects).toEqual({});
  });

  it('still grants the grace to a missing root that is not ephemeral', () => {
    const root = path.join(tmpHome, 'unmounted-volume', 'project');
    seedRegistry(root);

    const { removed, newlyMissing } = registry.sweepMissingRoots(7);

    expect(removed).toEqual([]);
    expect(newlyMissing).toEqual([root]);
  });

  it('still grants the grace to an explicitly added workdir-shaped root', () => {
    const root = path.join(tmpHome, 'multica-task-3265850447', 'deliberate');
    seedRegistry(root, { explicit: true });

    const { removed, newlyMissing } = registry.sweepMissingRoots(7);

    expect(removed).toEqual([]);
    expect(newlyMissing).toEqual([root]);
  });
});
