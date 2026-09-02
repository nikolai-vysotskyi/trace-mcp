/**
 * TRA-702: `.config.json` grew to 1 MB / 593 project sections on the reported
 * machine, 440 of them pointing at directories that no longer exist.
 *
 * TRA-396 stopped one-shot agent workdirs from reaching `registry.json`, but
 * `setupProject` writes the per-project *config* section before
 * `registerProject` ever applies that check — so every agent run still left a
 * permanent section behind, and nothing swept them. This covers both halves:
 * not writing new ones, and draining the backlog.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('pruneProjectConfigSections (TRA-702)', () => {
  let tmpHome: string;
  let configJsonc: typeof import('../config-jsonc.js');
  let GLOBAL_CONFIG_PATH: string;
  let REGISTRY_PATH: string;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-cfg-sweep-'));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    configJsonc = await import('../config-jsonc.js');
    ({ GLOBAL_CONFIG_PATH, REGISTRY_PATH } = await import('../global.js'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeConfig(projects: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify({ projects }, null, 2));
  }

  function readProjects(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')).projects ?? {};
  }

  function registerRoot(root: string): void {
    fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
    fs.writeFileSync(
      REGISTRY_PATH,
      JSON.stringify({
        version: 1,
        projects: {
          [root]: { name: 'x', root, dbPath: '/tmp/x.db', addedAt: '2026-01-01T00:00:00.000Z' },
        },
      }),
    );
  }

  it('drops sections whose root is gone and that no registry entry claims', () => {
    const live = fs.mkdtempSync(path.join(tmpHome, 'live-'));
    const dead = path.join(tmpHome, 'deleted-project');
    writeConfig({ [live]: { root: '.' }, [dead]: { root: '.' } });

    expect(configJsonc.pruneProjectConfigSections()).toEqual([dead]);
    expect(Object.keys(readProjects())).toEqual([live]);
  });

  it('drops one-shot agent workdir sections even while the checkout is still on disk', () => {
    // The Multica runtime abandons its workdir in place, so an existence check
    // alone never reaches these — which is how the live-but-dead sections
    // survived every sweep that shipped before this one.
    const workdir = path.join(
      tmpHome,
      'multica_workspaces_acme',
      'proj-123',
      'tra-1-abc',
      'workdir',
      'trace-mcp',
    );
    fs.mkdirSync(workdir, { recursive: true });
    const real = fs.mkdtempSync(path.join(tmpHome, 'real-'));
    writeConfig({ [workdir]: { root: '.' }, [real]: { root: '.' } });

    expect(configJsonc.pruneProjectConfigSections()).toEqual([workdir]);
    expect(Object.keys(readProjects())).toEqual([real]);
  });

  it('keeps a registered project whose root is only transiently missing', () => {
    // An unmounted drive must not cost the user their config. registry.json is
    // the authority, and it already runs its own 7-day grace period.
    const missing = path.join(tmpHome, 'on-an-unmounted-volume');
    writeConfig({ [missing]: { root: '.', include: ['src/**'] } });
    registerRoot(missing);

    expect(configJsonc.pruneProjectConfigSections()).toEqual([]);
    expect(Object.keys(readProjects())).toEqual([missing]);
  });

  it('rewrites the file once, not once per removed section', () => {
    // Hundreds of dead sections × a 1 MB rewrite each is why this is a bulk
    // operation rather than a loop over removeProjectConfigJsonc.
    const projects: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) projects[path.join(tmpHome, `gone-${i}`)] = { root: '.' };
    writeConfig(projects);

    const spy = vi.spyOn(fs, 'renameSync');
    const removed = configJsonc.pruneProjectConfigSections();

    expect(removed).toHaveLength(50);
    const writesToConfig = spy.mock.calls.filter(([, dest]) => dest === GLOBAL_CONFIG_PATH);
    expect(writesToConfig).toHaveLength(1);
    spy.mockRestore();
  });

  it('leaves a config with no dead sections untouched', () => {
    const live = fs.mkdtempSync(path.join(tmpHome, 'live-'));
    writeConfig({ [live]: { root: '.' } });
    const before = fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8');

    expect(configJsonc.pruneProjectConfigSections()).toEqual([]);
    expect(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')).toBe(before);
  });
});
