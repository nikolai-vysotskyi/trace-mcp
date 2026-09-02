/**
 * TRA-702: `.config.json` grew to 1 MB / 593 project sections on the reported
 * machine, 440 of them pointing at directories that no longer exist.
 *
 * `setupProject` writes one section per root it sets up, and every sweep that
 * existed worked on `registry.json` — a different file — so this map had no
 * collector at all. The section itself has to keep being written even for
 * one-shot workdirs, because the run that follows reads it back (see
 * tests/project-setup/ephemeral-config-section.test.ts); collecting them
 * afterwards, on softGcSweep's hourly timer, is what bounds the file.
 *
 * These cases pin what the sweep removes and — the part that matters — what it
 * must not: a registered root that is only transiently missing, comments a user
 * hand-wrote in a retained section, and a healthy config it should not rewrite.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'jsonc-parser';
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
    // jsonc, not JSON: the file is documented as comment-bearing, and one of
    // these cases deliberately writes comments into it.
    return (
      (
        parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')) as {
          projects?: Record<string, unknown>;
        }
      )?.projects ?? {}
    );
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

  it('preserves comments inside the project sections it keeps', () => {
    // Replacing the whole `projects` object in one edit is shorter, but it
    // reserialises the retained sections too and drops any comment a user
    // hand-wrote in them. `.config.json` is JSONC and documented as
    // hand-editable; #218 already protects this data on the write path.
    const live = fs.mkdtempSync(path.join(tmpHome, 'live-'));
    const dead = path.join(tmpHome, 'deleted-project');
    fs.mkdirSync(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      GLOBAL_CONFIG_PATH,
      `{
  // top-level note
  "projects": {
    ${JSON.stringify(live)}: {
      // keep the generated globs, we tuned these by hand
      "root": ".",
      "include": ["src/**"] // only source
    },
    ${JSON.stringify(dead)}: { "root": "." }
  }
}
`,
    );

    expect(configJsonc.pruneProjectConfigSections()).toEqual([dead]);

    const after = fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8');
    expect(after).toContain('// top-level note');
    expect(after).toContain('// keep the generated globs, we tuned these by hand');
    expect(after).toContain('// only source');
    expect(after).not.toContain('deleted-project');
    expect(Object.keys(readProjects())).toEqual([live]);
  });

  it('skips entirely while another process holds the config lock', () => {
    // The sweep reads the file, computes hundreds of edits, then writes the
    // whole thing back — ~2s wide on the first backlog drain, while other
    // agent processes keep registering projects. Its write would publish a
    // buffer that predates a peer's section, silently reverting it; if that
    // landed between a run's save and its immediate loadConfig(), the run
    // would index with schema defaults.
    //
    // Within one process this cannot happen — the sweep is synchronous, so
    // nothing else in that process runs during it. The real peer is another
    // process, which is what the cross-process lock serialises. Here that peer
    // is simulated by a lock file held by a live pid that is not us; the sweep
    // must decline to touch the file at all and retry on the next hourly pass.
    const dead = path.join(tmpHome, 'deleted-project');
    writeConfig({ [dead]: { root: '.' } });
    const before = fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8');

    const lockDir = path.join(tmpHome, 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, 'global-config.pid'),
      // pid 1 is always alive and is never this test process, so the lock
      // reads as genuinely held rather than stale.
      JSON.stringify({ pid: 1, started_at: Date.now(), hostname: os.hostname(), op: 'peer' }),
    );

    expect(configJsonc.pruneProjectConfigSections()).toEqual([]);
    expect(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')).toBe(before);
  });

  it('leaves a config with no dead sections untouched', () => {
    const live = fs.mkdtempSync(path.join(tmpHome, 'live-'));
    writeConfig({ [live]: { root: '.' } });
    const before = fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8');

    expect(configJsonc.pruneProjectConfigSections()).toEqual([]);
    expect(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')).toBe(before);
  });
});
