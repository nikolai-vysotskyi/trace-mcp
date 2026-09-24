/**
 * GH#1371 / TRA-1881: user-configurable `auto_register.exclude` for throwaway
 * checkouts (bare-mirror worktrees, /tmp clones, CI gates).
 *
 * Excluded roots extend the built-in ephemeral classification: never persisted
 * to registry.json, DB routed to the ephemeral index dir, age-collected.
 * `auto_register.mode: "never"` disables every implicit registration while
 * deliberate `trace add`/`init` keeps working.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EPHEMERAL_INDEX_DIR,
  getAutoRegisterMode,
  GLOBAL_CONFIG_PATH,
  INDEX_DIR,
  getDbPath,
  isEphemeralProjectRoot,
  isUserExcludedProjectRoot,
} from '../global.js';

let savedConfig: string | null;

function writeGlobalConfig(obj: unknown): void {
  fs.mkdirSync(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(obj, null, 2));
}

beforeEach(() => {
  savedConfig = fs.existsSync(GLOBAL_CONFIG_PATH)
    ? fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8')
    : null;
  vi.stubEnv('TRACE_MCP_AUTO_REGISTER_MODE', '');
  vi.stubEnv('TRACE_MCP_AUTO_REGISTER_EXCLUDE', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (savedConfig !== null) {
    fs.writeFileSync(GLOBAL_CONFIG_PATH, savedConfig);
  } else if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
    fs.rmSync(GLOBAL_CONFIG_PATH);
  }
});

describe('isUserExcludedProjectRoot (TRA-1881)', () => {
  it('matches nothing with no config', () => {
    writeGlobalConfig({});
    expect(isUserExcludedProjectRoot('/tmp/clone-1')).toBe(false);
    expect(isUserExcludedProjectRoot(path.join(os.homedir(), '.gate/worktrees/r/1'))).toBe(false);
  });

  it('matches the reporter shape: ~/.gate/worktrees/**', () => {
    writeGlobalConfig({ auto_register: { mode: 'always', exclude: ['~/.gate/worktrees/**'] } });
    const home = os.homedir();
    expect(isUserExcludedProjectRoot(path.join(home, '.gate/worktrees/repo/123'))).toBe(true);
    expect(isUserExcludedProjectRoot(path.join(home, '.gate/worktrees'))).toBe(true);
    expect(isUserExcludedProjectRoot(path.join(home, '.gate/repos/foo.git'))).toBe(false);
    expect(isUserExcludedProjectRoot(path.join(home, 'projects/app'))).toBe(false);
  });

  it('matches a trailing-/** exclude including the base itself, but not lookalikes', () => {
    // Portable core (runs everywhere): derive the base from os.tmpdir() — on
    // Windows path.resolve('/tmp/..') gains a drive letter that never matches
    // a drive-less POSIX pattern, so POSIX literals live in the gated block
    // below (TRA-1810).
    const base = path.join(os.tmpdir(), 'trace-1881-exclude-base');
    writeGlobalConfig({ auto_register: { exclude: [`${base}/**`] } });
    expect(isUserExcludedProjectRoot(path.join(base, 'clone-1'))).toBe(true);
    expect(isUserExcludedProjectRoot(base)).toBe(true);
    expect(isUserExcludedProjectRoot(`${base}-other/x`)).toBe(false);
    if (process.platform !== 'win32') {
      writeGlobalConfig({ auto_register: { exclude: ['/tmp/**', '/private/tmp/**'] } });
      expect(isUserExcludedProjectRoot('/tmp/clone-1')).toBe(true);
      expect(isUserExcludedProjectRoot('/tmp')).toBe(true);
      expect(isUserExcludedProjectRoot('/tmpfoo/x')).toBe(false);
      expect(isUserExcludedProjectRoot('/private/tmp/x')).toBe(true);
      expect(isUserExcludedProjectRoot('/private/tmp-backup/x')).toBe(false);
    }
  });

  it('expands $TMPDIR and ${TMPDIR}', () => {
    const fakeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-1881-tmpdir-'));
    try {
      vi.stubEnv('TMPDIR', `${fakeTmp}/`);
      writeGlobalConfig({ auto_register: { exclude: ['$TMPDIR/**'] } });
      expect(isUserExcludedProjectRoot(path.join(fakeTmp, 'gate-1'))).toBe(true);
      expect(isUserExcludedProjectRoot(path.join(os.homedir(), 'projects/app'))).toBe(false);
      writeGlobalConfig({ auto_register: { exclude: ['${TMPDIR}/gate-*/**'] } });
      expect(isUserExcludedProjectRoot(path.join(fakeTmp, 'gate-9'))).toBe(true);
    } finally {
      fs.rmSync(fakeTmp, { recursive: true, force: true });
    }
  });

  it('treats a bare directory (no glob magic) as the dir + subtree', () => {
    const base = path.join(os.tmpdir(), 'trace-1881-bare-gate');
    writeGlobalConfig({ auto_register: { exclude: [base] } });
    expect(isUserExcludedProjectRoot(base)).toBe(true);
    expect(isUserExcludedProjectRoot(path.join(base, 'a', 'b'))).toBe(true);
    expect(isUserExcludedProjectRoot(`${base}-other`)).toBe(false);
    if (process.platform !== 'win32') {
      writeGlobalConfig({ auto_register: { exclude: ['/data/gate'] } });
      expect(isUserExcludedProjectRoot('/data/gate')).toBe(true);
      expect(isUserExcludedProjectRoot('/data/gate/a/b')).toBe(true);
      expect(isUserExcludedProjectRoot('/data/gate-other')).toBe(false);
    }
  });

  it('honors TRACE_MCP_AUTO_REGISTER_EXCLUDE without a config file', () => {
    writeGlobalConfig({});
    const base = path.join(os.tmpdir(), 'trace-1881-env-gate');
    vi.stubEnv('TRACE_MCP_AUTO_REGISTER_EXCLUDE', `${base}/**`);
    expect(isUserExcludedProjectRoot(path.join(base, 'clone-9'))).toBe(true);
    expect(isUserExcludedProjectRoot(path.join(os.tmpdir(), 'trace-1881-other-app'))).toBe(false);
    if (process.platform !== 'win32') {
      vi.stubEnv('TRACE_MCP_AUTO_REGISTER_EXCLUDE', '/tmp/**');
      expect(isUserExcludedProjectRoot('/tmp/clone-9')).toBe(true);
      expect(isUserExcludedProjectRoot('/opt/app')).toBe(false);
    }
  });

  it('keeps the built-in ephemeral patterns working', () => {
    writeGlobalConfig({});
    expect(isEphemeralProjectRoot('/Users/n/agent_runs/task-1/scratch/repo')).toBe(false);
    expect(
      isEphemeralProjectRoot('/Users/n/multica_workspaces_h/ws-1/run-1/workdir/trace-mcp'),
    ).toBe(true);
  });

  it('routes an excluded root DB to the ephemeral index dir', () => {
    const base = path.join(os.tmpdir(), 'trace-1881-db-gate');
    const stable = path.join(os.tmpdir(), 'trace-1881-stable-app');
    writeGlobalConfig({ auto_register: { exclude: [`${base}/**`] } });
    expect(
      getDbPath(path.join(base, 'clone-1')).startsWith(`${EPHEMERAL_INDEX_DIR}${path.sep}`),
    ).toBe(true);
    expect(getDbPath(stable).startsWith(`${INDEX_DIR}${path.sep}`)).toBe(true);
    if (process.platform !== 'win32') {
      writeGlobalConfig({ auto_register: { exclude: ['/tmp/**'] } });
      expect(getDbPath('/tmp/clone-1').startsWith(`${EPHEMERAL_INDEX_DIR}${path.sep}`)).toBe(true);
      expect(getDbPath('/opt/stable-app').startsWith(`${INDEX_DIR}${path.sep}`)).toBe(true);
    }
  });
});

describe('getAutoRegisterMode (TRA-1881)', () => {
  it('defaults to always', () => {
    writeGlobalConfig({});
    expect(getAutoRegisterMode()).toBe('always');
  });

  it('reads mode from the config file', () => {
    writeGlobalConfig({ auto_register: { mode: 'never', exclude: [] } });
    expect(getAutoRegisterMode()).toBe('never');
    writeGlobalConfig({ auto_register: { mode: 'ask', exclude: [] } });
    expect(getAutoRegisterMode()).toBe('ask');
  });

  it('env override wins over the file', () => {
    writeGlobalConfig({ auto_register: { mode: 'never', exclude: [] } });
    vi.stubEnv('TRACE_MCP_AUTO_REGISTER_MODE', 'always');
    expect(getAutoRegisterMode()).toBe('always');
  });

  it('ignores invalid values', () => {
    writeGlobalConfig({ auto_register: { mode: 'sometimes', exclude: [] } });
    expect(getAutoRegisterMode()).toBe('always');
  });
});
