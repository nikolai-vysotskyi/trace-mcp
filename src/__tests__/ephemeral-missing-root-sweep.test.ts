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

  /** Write registry rows for roots that do not exist on disk. */
  function seedRegistry(root: string, extra: Record<string, unknown> = {}): void {
    seedRegistryRows([{ root, ...extra }]);
  }

  function seedRegistryRows(rows: Array<{ root: string } & Record<string, unknown>>): void {
    fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
    const projects: Record<string, unknown> = {};
    for (const { root, ...extra } of rows) {
      projects[root] = {
        name: path.basename(root),
        root,
        dbPath: path.join(tmpHome, 'index', `${path.basename(root)}.db`),
        addedAt: new Date().toISOString(),
        ...extra,
      };
    }
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ version: 1, projects }));
  }

  /** Create the DB file + sidecars the sweep would unlink. */
  function seedDbFiles(dbPath: string): void {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) fs.writeFileSync(dbPath + suffix, 'x');
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

  // TRA-1105 review finding: `dbPath` is shared with a sibling whose git
  // remote matches (`registerProject`), and the choice is persisted. A legacy
  // ephemeral row can therefore name a live canonical project's index — and
  // the sweep deletes the DB *and its WAL/SHM* along with the row.
  it('does not delete an index another registered project still shares', () => {
    const dead = path.join(tmpHome, 'multica-task-3265850447', 'checkout');
    const live = path.join(tmpHome, 'real-project');
    fs.mkdirSync(live, { recursive: true });
    const shared = path.join(tmpHome, 'index', 'shared.db');
    seedRegistryRows([
      { root: dead, dbPath: shared },
      { root: live, dbPath: shared },
    ]);
    seedDbFiles(shared);

    expect(registry.sweepMissingRoots(7).removed).toEqual([dead]);

    // Row gone, index intact — the live project keeps its DB and its WAL.
    expect(registry.listProjects().map((p) => p.root)).toEqual([live]);
    expect(fs.existsSync(shared)).toBe(true);
    expect(fs.existsSync(`${shared}-wal`)).toBe(true);
  });

  it('does delete the index when the dead row is its only owner', () => {
    const dead = path.join(tmpHome, 'multica-task-3265850447', 'solo');
    const dbPath = path.join(tmpHome, 'index', 'solo.db');
    seedRegistry(dead);
    seedDbFiles(dbPath);

    expect(registry.sweepMissingRoots(7).removed).toEqual([dead]);
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
  });

  it('leaves the index alone while a live holder marker names another root', async () => {
    const dead = path.join(tmpHome, 'multica-task-3265850447', 'held');
    const dbPath = path.join(tmpHome, 'index', 'held.db');
    seedRegistry(dead);
    seedDbFiles(dbPath);
    const { announceDbHolder } = await import('../db-holders.js');
    announceDbHolder(dbPath, path.join(tmpHome, 'some-other-live-root'));

    expect(registry.sweepMissingRoots(7).removed).toEqual([dead]);
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});
