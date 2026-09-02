import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getLauncherConfigPath,
  getLauncherDir,
  getLauncherPath,
  getPkgRootsPath,
  installLauncher,
  recordPkgRoot,
  readInstalledLauncherVersion,
  readLauncherConfig,
  resolveCurrentCliPath,
  setupLauncher,
  writeLauncherConfig,
} from '../../src/init/launcher.js';
import { LAUNCHER_VERSION } from '../../src/init/types.js';

function mkTmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-launcher-'));
  process.env.TRACE_MCP_HOME = dir;
  return dir;
}

describe('launcher config paths', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkTmpHome();
  });
  afterEach(() => {
    delete process.env.TRACE_MCP_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('honors $TRACE_MCP_HOME override', () => {
    // On Windows the launcher is a .cmd shim; on POSIX it's a bare bash script.
    const launcherName = process.platform === 'win32' ? 'trace.cmd' : 'trace';
    expect(getLauncherDir()).toBe(tmp);
    expect(getLauncherPath()).toBe(path.join(tmp, 'bin', launcherName));
    expect(getLauncherConfigPath()).toBe(path.join(tmp, 'launcher.env'));
  });

  it('falls back to ~/.trace when env var absent', () => {
    delete process.env.TRACE_MCP_HOME;
    expect(getLauncherDir()).toBe(path.join(os.homedir(), '.trace'));
  });
});

describe('writeLauncherConfig / readLauncherConfig', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmpHome();
  });
  afterEach(() => {
    delete process.env.TRACE_MCP_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes KV file and reads it back', () => {
    writeLauncherConfig({
      node: '/opt/homebrew/bin/node',
      cli: '/opt/homebrew/lib/node_modules/trace-mcp/dist/cli.js',
      version: '1.2.3',
    });
    const readBack = readLauncherConfig();
    expect(readBack).toEqual({
      node: '/opt/homebrew/bin/node',
      cli: '/opt/homebrew/lib/node_modules/trace-mcp/dist/cli.js',
      version: '1.2.3',
    });
  });

  // POSIX permission bits don't apply on Windows — fs.chmod's mode argument is
  // ignored there, files are stored with default 0o666. Skip rather than assert
  // a separate platform-specific value.
  it.skipIf(process.platform === 'win32')('writes file with 0600 perms', () => {
    writeLauncherConfig({ node: '/x', cli: '/y', version: '0.0.1' });
    const stat = fs.statSync(getLauncherConfigPath());
    // On macOS/Linux, mode includes file-type bits — mask to perms only.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('ignores comments, blank lines, unknown keys', () => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(
      getLauncherConfigPath(),
      ['# comment', '', 'TRACE_MCP_NODE="/n"', 'UNKNOWN_KEY="evil"', 'TRACE_MCP_CLI="/c"', ''].join(
        '\n',
      ),
    );
    const cfg = readLauncherConfig();
    expect(cfg.node).toBe('/n');
    expect(cfg.cli).toBe('/c');
    expect(cfg.version).toBeUndefined();
    expect((cfg as Record<string, unknown>).UNKNOWN_KEY).toBeUndefined();
  });

  it('rejects values containing double quotes', () => {
    expect(() => writeLauncherConfig({ node: '/a"b', cli: '/c', version: 'v1' })).toThrow(
      /unsupported character/,
    );
  });

  it('overwrites existing file atomically (no partial writes visible)', () => {
    writeLauncherConfig({ node: '/n1', cli: '/c1', version: '1.0.0' });
    writeLauncherConfig({ node: '/n2', cli: '/c2', version: '2.0.0' });
    const cfg = readLauncherConfig();
    expect(cfg).toEqual({ node: '/n2', cli: '/c2', version: '2.0.0' });
    // No tmpfiles left behind
    const binDir = path.dirname(getLauncherConfigPath());
    const tmpfiles = fs.readdirSync(binDir).filter((f) => f.includes('.tmp.'));
    expect(tmpfiles).toEqual([]);
  });
});

describe('installLauncher', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmpHome();
  });
  afterEach(() => {
    delete process.env.TRACE_MCP_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // The bash launcher script and the +x bit are POSIX-specific. Windows
  // installs a .cmd shim with different content; that path is exercised by
  // tests/init/launcher-integration-windows.test.ts.
  it.skipIf(process.platform === 'win32')(
    'creates launcher on first install, with correct version and +x',
    () => {
      const step = installLauncher({});
      expect(step.action).toBe('created');

      const p = getLauncherPath();
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).mode & 0o111).not.toBe(0); // any exec bit set
      expect(readInstalledLauncherVersion()).toBe(LAUNCHER_VERSION);

      const body = fs.readFileSync(p, 'utf-8');
      expect(body).toContain('#!/bin/bash');
      expect(body).toContain(`trace-mcp-launcher v${LAUNCHER_VERSION}`);
    },
  );

  it('skips reinstall when version matches', () => {
    installLauncher({});
    const second = installLauncher({});
    expect(second.action).toBe('already_configured');
  });

  it('reinstalls with force=true even when version matches', () => {
    installLauncher({});
    const forced = installLauncher({ force: true });
    expect(forced.action).toBe('updated');
  });

  it('dry-run does not create the file', () => {
    const step = installLauncher({ dryRun: true });
    expect(step.action).toBe('created');
    expect(fs.existsSync(getLauncherPath())).toBe(false);
  });
});

describe('setupLauncher (install + config)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmpHome();
  });
  afterEach(() => {
    delete process.env.TRACE_MCP_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('installs script and writes launcher.env', () => {
    const steps = setupLauncher({ pkgVersion: '9.9.9' });
    expect(steps[0].action).toBe('created'); // launcher script
    expect(steps[1].action).toBe('created'); // config file

    const cfg = readLauncherConfig();
    expect(cfg.node).toBe(process.execPath);
    expect(cfg.version).toBe('9.9.9');
    expect(cfg.cli).toBe(resolveCurrentCliPath());
  });

  it('reports already_configured on second run when unchanged', () => {
    setupLauncher({ pkgVersion: '9.9.9' });
    const second = setupLauncher({ pkgVersion: '9.9.9' });
    expect(second[0].action).toBe('already_configured');
    expect(second[1].action).toBe('already_configured');
  });

  it('refreshes config when pkgVersion changes', () => {
    setupLauncher({ pkgVersion: '1.0.0' });
    const second = setupLauncher({ pkgVersion: '2.0.0' });
    expect(second[1].action).toBe('updated');
    expect(readLauncherConfig().version).toBe('2.0.0');
  });
});

describe('recordPkgRoot', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmpHome();
  });
  afterEach(() => {
    delete process.env.TRACE_MCP_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const rootsOf = () =>
    fs
      .readFileSync(getPkgRootsPath(), 'utf-8')
      .split('\n')
      .filter((l) => l.trim());

  it('records the node_modules root the cli was installed into', () => {
    recordPkgRoot('/opt/homebrew/lib/node_modules/trace-mcp/dist/cli.js');
    expect(rootsOf()).toEqual(['/opt/homebrew/lib/node_modules']);
  });

  it('deduplicates and caps the list', () => {
    for (let i = 0; i < 14; i++) {
      recordPkgRoot(`/prefix${i}/lib/node_modules/trace-mcp/dist/cli.js`);
    }
    recordPkgRoot('/prefix13/lib/node_modules/trace-mcp/dist/cli.js');
    const roots = rootsOf();
    expect(roots).toHaveLength(10);
    expect(roots.at(-1)).toBe('/prefix13/lib/node_modules');
    expect(new Set(roots).size).toBe(10);
  });

  it('ignores a cli path that is not under a node_modules root', () => {
    recordPkgRoot('/somewhere/dist/cli.js');
    expect(fs.existsSync(getPkgRootsPath())).toBe(false);
  });
});

describe('Windows launcher .cmd template', () => {
  // Static content check — runs on every platform since it just reads the
  // template file, not a spawned process. The cmd->powershell hop does not
  // inherit windowsHide from the MCP client's spawn(), so -WindowStyle Hidden
  // is required to avoid a flashing console on first daemon start.
  it('invokes powershell.exe with -WindowStyle Hidden before -File', () => {
    const cmdPath = path.resolve(__dirname, '..', '..', 'hooks', 'trace-mcp-launcher.cmd');
    const body = fs.readFileSync(cmdPath, 'utf-8');
    expect(body).toContain(`trace-mcp-launcher v${LAUNCHER_VERSION}`);
    expect(body).toContain('powershell.exe');
    expect(body).toContain('-WindowStyle Hidden');
    expect(body.indexOf('-WindowStyle Hidden')).toBeLessThan(body.indexOf('-File'));
  });
});

describe('Windows launcher .ps1 package roots', () => {
  // Static content check: the .ps1 only runs on win32 runners, but the set of
  // roots it searches is the whole point of TRA-701 and must not silently
  // drift away from the POSIX shim's.
  const body = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'hooks', 'trace-mcp-launcher.ps1'),
    'utf-8',
  );

  it('searches the npm-global, Volta image and custom-prefix roots', () => {
    expect(body).toContain("Join-Path $env:APPDATA 'npm\\node_modules'");
    expect(body).toContain('Volta\\tools\\image\\packages\\trace-mcp\\lib\\node_modules');
    expect(body).toContain('$env:NPM_CONFIG_PREFIX');
    expect(body).toContain(".npmrc'");
    expect(body).toContain("'pkg-roots'");
  });

  it('resolves the custom prefix from config, never by spawning npm', () => {
    // Same reason as the POSIX shim: the launcher inherits the MCP client's
    // PATH, which in a project directory can carry a repo-controlled npm.
    expect(body).not.toMatch(/npm\s+root\s+-g/);
  });

  it('does not pin launcher.env to a swap-window backup directory', () => {
    expect(body).toContain('tmcp-bak-');
  });
});
