/**
 * TRA-702: the config sweep's "a registered root is protected" promise only
 * holds if the registry sweep that runs beside it is grace-aware.
 *
 * `softGcSweep` used to call `pruneStaleProjects()`, which deregisters a
 * missing root the first time it is seen missing. The startup path separately
 * called `sweepMissingRoots(7)`, which times the root and waits seven days.
 * Both ran against the same registry an hour apart, so the grace never held:
 * the hourly pass dropped the registry row immediately, and being unregistered
 * is half the condition `pruneProjectConfigSections` uses to delete a config
 * section. A volume that went offline for an hour came back to neither.
 *
 * This pins the ordering as a unit — the predicate tests alone cannot see it,
 * because each function is correct in isolation.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('soft GC ordering: registry grace protects the config section (TRA-702)', () => {
  let tmpHome: string;
  let registry: typeof import('../registry.js');
  let configJsonc: typeof import('../config-jsonc.js');
  let GLOBAL_CONFIG_PATH: string;
  let REGISTRY_PATH: string;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-softgc-order-'));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    registry = await import('../registry.js');
    configJsonc = await import('../config-jsonc.js');
    ({ GLOBAL_CONFIG_PATH, REGISTRY_PATH } = await import('../global.js'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('keeps registry row and config section for a root missing only briefly', () => {
    // A registered project on a volume that just went offline.
    const missing = path.join(tmpHome, 'unmounted-volume', 'project');
    fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
    fs.writeFileSync(
      REGISTRY_PATH,
      JSON.stringify({
        version: 1,
        projects: {
          [missing]: {
            name: 'project',
            root: missing,
            dbPath: path.join(tmpHome, 'project.db'),
            addedAt: new Date().toISOString(),
          },
        },
      }),
    );
    fs.mkdirSync(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      GLOBAL_CONFIG_PATH,
      JSON.stringify({ projects: { [missing]: { root: '.', include: ['src/**'] } } }, null, 2),
    );

    // The order softGcSweep runs them in: registry sweep, then config sweep.
    registry.sweepMissingRoots(7);
    const removedSections = configJsonc.pruneProjectConfigSections();

    // First sighting only timestamps the entry — nothing is deregistered yet,
    // so the config section still has a registry entry claiming it.
    expect(registry.listProjects().map((p) => p.root)).toContain(missing);
    expect(removedSections).toEqual([]);
    const after = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8'));
    expect(Object.keys(after.projects)).toEqual([missing]);
    expect(after.projects[missing].include).toEqual(['src/**']);
  });

  it('the grace-less registry prune is what used to break it', () => {
    // Guard on the mechanism, so a future edit that swaps softGcSweep back to
    // pruneStaleProjects has something that fails. pruneStaleProjects still
    // exists for `doctor` / `prune --apply`, where immediate removal is right.
    const missing = path.join(tmpHome, 'unmounted-volume', 'project');
    fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
    fs.writeFileSync(
      REGISTRY_PATH,
      JSON.stringify({
        version: 1,
        projects: {
          [missing]: {
            name: 'project',
            root: missing,
            dbPath: path.join(tmpHome, 'project.db'),
            addedAt: new Date().toISOString(),
          },
        },
      }),
    );
    fs.mkdirSync(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      GLOBAL_CONFIG_PATH,
      JSON.stringify({ projects: { [missing]: { root: '.' } } }, null, 2),
    );

    expect(registry.pruneStaleProjects()).toEqual([missing]);
    // Now unregistered and missing — the config sweep correctly eats it. This
    // is precisely the sequence softGcSweep must not produce.
    expect(configJsonc.pruneProjectConfigSections()).toEqual([missing]);
  });
});
