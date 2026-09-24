/**
 * GH#1371 / TRA-1881 integration: excluded roots are never persisted,
 * `mode: "never"` blocks implicit registration but not deliberate `add`,
 * and a shared dbPath is refcounted (TRA-1887).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceMcpConfigSchema, validateConfigUpdate } from '../config.js';

describe('auto_register config schema (TRA-1881)', () => {
  it('defaults to always + empty exclude', () => {
    const parsed = TraceMcpConfigSchema.parse({});
    expect(parsed.auto_register).toEqual({ mode: 'always', exclude: [] });
  });

  it('accepts never/ask with excludes', () => {
    const parsed = TraceMcpConfigSchema.parse({
      auto_register: { mode: 'never', exclude: ['/tmp/**'] },
    });
    expect(parsed.auto_register).toEqual({ mode: 'never', exclude: ['/tmp/**'] });
  });

  it('rejects unknown modes', () => {
    expect(() => TraceMcpConfigSchema.parse({ auto_register: { mode: 'sometimes' } })).toThrow();
  });

  it('validateConfigUpdate accepts auto_register', () => {
    expect(validateConfigUpdate({ auto_register: { mode: 'never' } })).toEqual([]);
    expect(validateConfigUpdate({ auto_register: { mode: 'sometimes' } }).length).toBeGreaterThan(
      0,
    );
  });
});

describe('auto_register persistence + mode gate (TRA-1881)', () => {
  let tmpHome: string;
  let registry: typeof import('../registry.js');
  let projectSetup: typeof import('../project-setup.js');
  let holders: typeof import('../db-holders.js');
  let globalMod: typeof import('../global.js');

  function writeConfig(obj: unknown): void {
    const { GLOBAL_CONFIG_PATH } = globalMod;
    fs.mkdirSync(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(obj, null, 2));
  }

  function makeProject(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture"}\n');
  }

  beforeEach(async () => {
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-autoreg-')));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.stubEnv('TRACE_MCP_AUTO_REGISTER_MODE', '');
    vi.stubEnv('TRACE_MCP_AUTO_REGISTER_EXCLUDE', '');
    vi.resetModules();
    globalMod = await import('../global.js');
    registry = await import('../registry.js');
    holders = await import('../db-holders.js');
    projectSetup = await import('../project-setup.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('an excluded root registers ephemerally: never persisted, DB in the ephemeral dir', () => {
    const scratch = path.join(tmpHome, 'gate', 'run-1');
    makeProject(scratch);
    writeConfig({ auto_register: { mode: 'always', exclude: [`${tmpHome}/gate/**`] } });

    const entry = registry.registerProject(scratch);
    expect(entry.dbPath.startsWith(`${globalMod.EPHEMERAL_INDEX_DIR}${path.sep}`)).toBe(true);
    // Not in registry.json on disk (an ephemeral-only home may not even have
    // the file — absence counts as "not persisted")…
    const raw = fs.existsSync(globalMod.REGISTRY_PATH)
      ? (JSON.parse(fs.readFileSync(globalMod.REGISTRY_PATH, 'utf8')) as {
          projects: Record<string, unknown>;
        })
      : { projects: {} };
    expect(raw.projects[path.resolve(scratch)]).toBeUndefined();
    // …and invisible to listProjects (persistent rows only)…
    expect(registry.listProjects().some((e) => e.root === path.resolve(scratch))).toBe(false);
    // …but resolvable in-process for the session that created it.
    expect(registry.getProject(scratch)?.root).toBe(path.resolve(scratch));
  });

  it('a non-excluded root still persists', () => {
    const stable = path.join(tmpHome, 'stable-app');
    makeProject(stable);
    writeConfig({ auto_register: { mode: 'always', exclude: [`${tmpHome}/gate/**`] } });

    const entry = registry.registerProject(stable);
    expect(entry.dbPath.startsWith(`${globalMod.INDEX_DIR}${path.sep}`)).toBe(true);
    expect(registry.listProjects().some((e) => e.root === path.resolve(stable))).toBe(true);
  });

  it('mode never blocks implicit setupProject but allows explicit add', () => {
    writeConfig({ auto_register: { mode: 'never', exclude: [] } });
    const implicit = path.join(tmpHome, 'implicit-app');
    makeProject(implicit);
    expect(() => projectSetup.setupProject(implicit)).toThrow(/Auto-registration is disabled/);

    const deliberate = path.join(tmpHome, 'deliberate-app');
    makeProject(deliberate);
    const result = projectSetup.setupProject(deliberate, { explicit: true });
    expect(result.entry.explicit).toBe(true);
    expect(registry.getProject(deliberate)?.explicit).toBe(true);
  });

  it('mode never still resolves an already-registered root implicitly (daemon boot)', () => {
    // Register first under "always", then flip to "never": boot, lazy reload
    // and POST re-add all call setupProject with no opts on a registered root
    // and must get the entry back, not a throw.
    writeConfig({ auto_register: { mode: 'always', exclude: [] } });
    const stable = path.join(tmpHome, 'stable-app');
    makeProject(stable);
    const first = projectSetup.setupProject(stable, { explicit: true });
    expect(first.isNew).toBe(true);

    writeConfig({ auto_register: { mode: 'never', exclude: [] } });
    const again = projectSetup.setupProject(stable);
    expect(again.isNew).toBe(false);
    expect(again.entry.root).toBe(path.resolve(stable));
  });

  it('isDbPathShared refcounts a same-remote sibling DB (TRA-1887)', () => {
    const remote = 'https://github.com/org/shared-remote.git';
    const canonical = path.join(tmpHome, 'canonical');
    const clone = path.join(tmpHome, 'clone');
    for (const dir of [canonical, clone]) {
      makeProject(dir);
      const gitDir = path.join(dir, '.git');
      fs.mkdirSync(gitDir, { recursive: true });
      fs.writeFileSync(
        path.join(gitDir, 'config'),
        ['[remote "origin"]', `\turl = ${remote}`, ''].join('\n'),
      );
    }
    writeConfig({ auto_register: { mode: 'always', exclude: [] } });

    const first = registry.registerProject(canonical);
    // Sequential checkouts: the first run is over, so drop its live holder —
    // otherwise TRA-304 isolation (correctly) refuses to share the DB and the
    // clone gets a fresh path (see git-remote-identity.test.ts `endRun`).
    holders.releaseDbHolder(first.dbPath, canonical);
    const second = registry.registerProject(clone);
    // Same remote → same DB (TRA-38 sharing).
    expect(second.dbPath).toBe(first.dbPath);
    // Drop the clone's holder too, so the assertion below exercises the
    // registry refcount (not the live-holder half of the guard).
    holders.releaseDbHolder(second.dbPath, clone);
    expect(registry.isDbPathShared(first.dbPath, clone)).toBe(true);

    registry.unregisterProject(clone);
    expect(registry.isDbPathShared(first.dbPath, canonical)).toBe(false);
  });
});
