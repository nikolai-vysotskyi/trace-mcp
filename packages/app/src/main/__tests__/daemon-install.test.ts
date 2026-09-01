/* The rules TRA-438 has to keep, expressed as the two things that can go
   wrong: the app never installs a daemon on a machine that has none, or the
   app fights the npm postinstall for the same files on every launch. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compareVersions,
  decideTakeover,
  bundledServerDir,
  ensureDaemonInstalled,
  generatePlist,
  launcherEnvContent,
  PLIST_MARKER,
  readLauncherEnv,
  resolveCliCommand,
  runtimeShimContent,
} from '../daemon-install';

const BUNDLED = '/Applications/trace-mcp.app/Contents/Resources/server/dist/cli.js';

describe('compareVersions', () => {
  it('orders releases numerically, not lexically', () => {
    expect(compareVersions('3.2.0', '3.10.0')).toBe(-1);
    expect(compareVersions('3.10.0', '3.2.0')).toBe(1);
    expect(compareVersions('v3.7.0', '3.7.0')).toBe(0);
    // Prereleases are not ordered against their release; they compare equal.
    expect(compareVersions('3.7.0-rc.1', '3.7.0')).toBe(0);
  });
});

describe('resolveCliCommand', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-cli-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('prefers the installed shim — a DMG-only machine has no trace-mcp on PATH', () => {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const shim = path.join(bin, process.platform === 'win32' ? 'trace-mcp.cmd' : 'trace-mcp');
    fs.writeFileSync(shim, '#!/bin/bash\n', { mode: 0o755 });

    expect(resolveCliCommand(home)).toBe(shim);
  });

  it('falls back to PATH when no shim was installed', () => {
    expect(resolveCliCommand(home)).toBe('trace-mcp');
  });
});

describe('decideTakeover', () => {
  it('installs when nothing is set up — the DMG-only machine', () => {
    const d = decideTakeover({
      bundledCli: BUNDLED,
      bundledVersion: '3.7.0',
      installedRunnable: false,
    });
    expect(d.takeover).toBe(true);
  });

  it('repairs a launcher.env that points at files which are gone', () => {
    const d = decideTakeover({
      bundledCli: BUNDLED,
      bundledVersion: '3.7.0',
      installedVersion: '3.7.0',
      installedRunnable: false,
    });
    expect(d.takeover).toBe(true);
  });

  it('leaves a current npm install alone — no second control plane', () => {
    const d = decideTakeover({
      bundledCli: BUNDLED,
      bundledVersion: '3.7.0',
      installedVersion: '3.7.0',
      installedRunnable: true,
    });
    expect(d.takeover).toBe(false);
  });

  it('leaves a NEWER npm install alone', () => {
    const d = decideTakeover({
      bundledCli: BUNDLED,
      bundledVersion: '3.7.0',
      installedVersion: '3.8.0',
      installedRunnable: true,
    });
    expect(d.takeover).toBe(false);
  });

  it('upgrades a daemon older than the app — the daemon=3.2.0 app=3.3.0 case', () => {
    const d = decideTakeover({
      bundledCli: BUNDLED,
      bundledVersion: '3.3.0',
      installedVersion: '3.2.0',
      installedRunnable: true,
    });
    expect(d.takeover).toBe(true);
    expect(d.reason).toContain('older');
  });

  it('never touches anything in a dev run, where there is no payload', () => {
    const d = decideTakeover({
      bundledCli: null,
      bundledVersion: '0.0.0-dev',
      installedRunnable: false,
    });
    expect(d.takeover).toBe(false);
  });

  it('honours the daemon opt-out sentinel', () => {
    const d = decideTakeover({
      bundledCli: BUNDLED,
      bundledVersion: '3.7.0',
      installedRunnable: false,
      daemonDisabled: true,
    });
    expect(d.takeover).toBe(false);
    expect(d.reason).toContain('opt-out');
  });
});

describe('generated control-plane files', () => {
  it('runs the app binary as a Node runtime', () => {
    const shim = runtimeShimContent('/Applications/trace-mcp.app/Contents/MacOS/trace-mcp');
    expect(shim).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(shim).toContain('/Applications/trace-mcp.app/Contents/MacOS/trace-mcp');
  });

  it('writes a launcher.env the shim can parse back', () => {
    const content = launcherEnvContent('/bin/runtime', '/srv/dist/cli.js', '3.7.0');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-env-'));
    fs.writeFileSync(path.join(dir, 'launcher.env'), content);
    expect(readLauncherEnv(dir)).toEqual({
      node: '/bin/runtime',
      cli: '/srv/dist/cli.js',
      version: '3.7.0',
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('carries the same plist marker the npm postinstall writes', () => {
    // If these ever diverge, an npm-installed machine gets its LaunchAgent
    // booted out and rewritten on every single app launch.
    // vitest runs with packages/app as its root, as the other main-process
    // tests assume.
    const script = fs.readFileSync(
      path.resolve(process.cwd(), '../../scripts/postinstall-control-plane.mjs'),
      'utf-8',
    );
    const version = script.match(/const PLIST_VERSION = (\d+)/)?.[1];
    expect(PLIST_MARKER).toBe(`trace-mcp plist v${version}`);
  });

  it('points launchd at the stable shim, not at a versioned path', () => {
    const plist = generatePlist('/Users/x/.trace-mcp/bin/trace-mcp', '/Users/x/.trace-mcp');
    expect(plist).toContain('<string>/Users/x/.trace-mcp/bin/trace-mcp</string>');
    expect(plist).toContain('<string>serve-http</string>');
    expect(plist).toContain('com.trace-mcp.server');
  });
});

describe('bundledServerDir', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('is null when the payload is absent — a dev run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-res-'));
    made.push(dir);
    expect(bundledServerDir(dir)).toBeNull();
  });

  it('finds the staged server inside Resources', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-res-'));
    made.push(dir);
    fs.mkdirSync(path.join(dir, 'server', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server', 'dist', 'cli.js'), '');
    expect(bundledServerDir(dir)).toBe(path.join(dir, 'server'));
  });
});

describe('ensureDaemonInstalled', () => {
  let home: string;
  let resources: string;
  let launchAgent: string;
  let calls: string[][];
  /** Stands in for launchd's own memory: once bootstrapped, `list` answers ok. */
  let bootstrapped: boolean;
  const previousHome = process.env.TRACE_MCP_HOME;

  const run = (appVersion: string) =>
    ensureDaemonInstalled({
      appVersion,
      execPath: '/Applications/trace-mcp.app/Contents/MacOS/trace-mcp',
      resourcesPath: resources,
      launchAgentPath: launchAgent,
      runLaunchctl: (args) => {
        calls.push(args);
        if (args[0] === 'bootstrap') bootstrapped = true;
        if (args[0] === 'bootout') bootstrapped = false;
        return { ok: args[0] === 'list' ? bootstrapped : true, stderr: '' };
      },
      probeHealth: async () => true,
      log: () => {},
    });

  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-install-'));
    home = path.join(tmp, 'home');
    resources = path.join(tmp, 'Resources');
    launchAgent = path.join(tmp, 'com.trace-mcp.server.plist');
    fs.mkdirSync(path.join(resources, 'server', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(resources, 'server', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(resources, 'server', 'dist', 'cli.js'), '');
    fs.writeFileSync(path.join(resources, 'server', 'hooks', 'trace-mcp-launcher.sh'), '#!/bin/bash\n');
    process.env.TRACE_MCP_HOME = home;
    calls = [];
    bootstrapped = false;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.TRACE_MCP_HOME;
    else process.env.TRACE_MCP_HOME = previousHome;
  });

  it.runIf(process.platform === 'darwin')(
    'installs a whole control plane on a machine that has none',
    async () => {
      const result = await run('3.7.0');
      expect(result.state.phase).toBe('ready');
      expect(result.changed).toBe(true);
      expect(readLauncherEnv(home)).toEqual({
        node: path.join(home, 'bin', 'node-runtime'),
        cli: path.join(resources, 'server', 'dist', 'cli.js'),
        version: '3.7.0',
      });
      expect(fs.existsSync(path.join(home, 'bin', 'trace-mcp'))).toBe(true);
      expect(fs.readFileSync(launchAgent, 'utf-8')).toContain(PLIST_MARKER);
      expect(calls.some((c) => c[0] === 'bootstrap')).toBe(true);
    },
  );

  it.runIf(process.platform === 'darwin')('changes nothing on a second run', async () => {
    await run('3.7.0');
    calls.length = 0;
    const again = await run('3.7.0');
    expect(again.changed).toBe(false);
    expect(again.state.phase).toBe('ready');
    // No bootstrap, no kickstart — just the liveness question.
    expect(calls.map((c) => c[0])).toEqual(['list']);
  });

  it.runIf(process.platform === 'darwin')(
    'repoints an older daemon at the app version, without a second LaunchAgent',
    async () => {
      await run('3.7.0');
      fs.writeFileSync(
        path.join(home, 'launcher.env'),
        launcherEnvContent(path.join(home, 'bin', 'node-runtime'), path.join(resources, 'server', 'dist', 'cli.js'), '3.2.0'),
      );
      calls.length = 0;
      const upgraded = await run('3.7.0');
      expect(upgraded.reason).toContain('older');
      expect(readLauncherEnv(home).version).toBe('3.7.0');
      // The plist is untouched: same label, same shim path, so launchd is
      // kickstarted rather than rewritten.
      expect(calls.some((c) => c[0] === 'bootout')).toBe(false);
      expect(calls.some((c) => c[0] === 'kickstart')).toBe(true);
    },
  );

  it.runIf(process.platform === 'darwin')('does nothing at all when the daemon is opted out', async () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'daemon.disabled'), '{}');
    const result = await run('3.7.0');
    expect(result.state.phase).toBe('idle');
    expect(result.changed).toBe(false);
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(home, 'launcher.env'))).toBe(false);
  });
});
