/* The rules TRA-438 has to keep, expressed as the two things that can go
   wrong: the app never installs a daemon on a machine that has none, or the
   app fights the npm postinstall for the same files on every launch. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import {
  compareVersions,
  decideTakeover,
  bundledServerDir,
  ensureDaemonInstalled,
  type EnsureOptions,
  generatePlist,
  isPortHeld,
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

  /* TRA-614. The app rewrites launcher.env wholesale on takeover, but `init`
     owns the shim that reads it, and the two ship on their own schedules. Once
     TRA-610 renames the shim to read TRACE_*, an app still writing only
     TRACE_MCP_* would erase exactly the keys the shim it just selected needs,
     and launchd would start a shim with no Node and no CLI to exec. Writing
     both families removes the ordering dependency; a shim ignores keys it does
     not know. Found in review of PR #724. */
  it('writes both the TRACE_* and TRACE_MCP_* key families', () => {
    const content = launcherEnvContent('/bin/runtime', '/srv/dist/cli.js', '3.7.0');
    for (const key of ['TRACE_NODE', 'TRACE_CLI', 'TRACE_VERSION']) {
      expect(content, `${key} missing`).toContain(`${key}=`);
      expect(content, `${key.replace('TRACE_', 'TRACE_MCP_')} missing`).toContain(
        `${key.replace('TRACE_', 'TRACE_MCP_')}=`,
      );
    }
    // Same values in both, so whichever family a shim reads, it gets the same
    // runtime — the failure this guards against is a half-written file.
    const parse = (k: string) => content.match(new RegExp(`^${k}="(.*)"$`, 'm'))?.[1];
    expect(parse('TRACE_NODE')).toBe(parse('TRACE_MCP_NODE'));
    expect(parse('TRACE_CLI')).toBe(parse('TRACE_MCP_CLI'));
    expect(parse('TRACE_VERSION')).toBe(parse('TRACE_MCP_VERSION'));
  });

  it('reads a launcher.env that carries only the renamed TRACE_* keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-env-new-'));
    fs.writeFileSync(
      path.join(dir, 'launcher.env'),
      ['TRACE_NODE="/bin/runtime"', 'TRACE_CLI="/srv/dist/cli.js"', 'TRACE_VERSION="4.0.0"', ''].join(
        '\n',
      ),
    );
    expect(readLauncherEnv(dir)).toEqual({
      node: '/bin/runtime',
      cli: '/srv/dist/cli.js',
      version: '4.0.0',
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

  const run = (appVersion: string, extra: Partial<EnsureOptions> = {}) =>
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
      ...extra,
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

  // TRA-850: both branches below SIGTERM a running daemon. Without a record in
  // daemon.log the stop reads as an anonymous `reason: SIGTERM` — the app's own
  // log() goes to the Electron console, which nobody correlates with it.
  const stopRecords = () => {
    const log = path.join(home, 'daemon.log');
    if (!fs.existsSync(log)) return [];
    return fs
      .readFileSync(log, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  it.runIf(process.platform === 'darwin')(
    'records who booted out the daemon when the plist is replaced',
    async () => {
      // A plist from before the current marker: forces the bootout branch.
      fs.writeFileSync(launchAgent, '<plist><dict></dict></plist>');
      await run('3.7.0');

      expect(calls.some((c) => c[0] === 'bootout')).toBe(true);
      const record = stopRecords().find((r) => r.action === 'bootout');
      expect(record?.msg).toBe('Daemon bootout requested');
      expect(record?.via).toBe('desktop-app: plist refresh');
      expect(record?.managedBy).toBe('desktop-app');
      expect(record?.requesterPid).toBe(process.pid);
    },
  );

  it.runIf(process.platform === 'darwin')(
    'records who kickstarted the daemon on a bundled upgrade',
    async () => {
      await run('3.7.0');
      fs.writeFileSync(
        path.join(home, 'launcher.env'),
        launcherEnvContent(path.join(home, 'bin', 'node-runtime'), path.join(resources, 'server', 'dist', 'cli.js'), '3.2.0'),
      );
      await run('3.7.0');

      expect(calls.some((c) => c[0] === 'kickstart')).toBe(true);
      const record = stopRecords().find((r) => r.action === 'kickstart');
      expect(record?.msg).toBe('Daemon kickstart requested');
      expect(record?.via).toBe('desktop-app: bundled daemon upgrade');
      expect(record?.managedBy).toBe('desktop-app');
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

/* TRA-939: a daemon that holds the port and does not answer is a different
   state from a daemon that was never installed, and the app used to call both
   "Setup didn't finish" after spending 30 s finding out. */
describe('a live but unanswering daemon', () => {
  let home: string;
  let resources: string;
  let launchAgent: string;
  const previousHome = process.env.TRACE_MCP_HOME;
  const servers: net.Server[] = [];

  /** A socket that holds the port and never answers — the wedged daemon. */
  const wedgedListener = async (): Promise<number> => {
    const srv = net.createServer();
    servers.push(srv);
    await new Promise<void>((r) => srv.listen({ port: 0, host: '127.0.0.1', backlog: 1 }, r));
    srv.on('connection', () => {
      /* accepted, never answered */
    });
    return (srv.address() as net.AddressInfo).port;
  };

  const run = (port: number, extra: Partial<EnsureOptions> = {}) =>
    ensureDaemonInstalled({
      appVersion: '3.7.0',
      execPath: '/Applications/trace-mcp.app/Contents/MacOS/trace-mcp',
      resourcesPath: resources,
      launchAgentPath: launchAgent,
      port,
      runLaunchctl: () => ({ ok: false, stderr: '' }),
      log: () => {},
      ...extra,
    });

  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-wedge-'));
    home = path.join(tmp, 'home');
    resources = path.join(tmp, 'Resources');
    launchAgent = path.join(tmp, 'com.trace-mcp.server.plist');
    fs.mkdirSync(path.join(resources, 'server', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(resources, 'server', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(resources, 'server', 'dist', 'cli.js'), '');
    fs.writeFileSync(path.join(resources, 'server', 'hooks', 'trace-mcp-launcher.sh'), '#!/bin/bash\n');
    process.env.TRACE_MCP_HOME = home;
  });

  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    if (previousHome === undefined) delete process.env.TRACE_MCP_HOME;
    else process.env.TRACE_MCP_HOME = previousHome;
  });

  it('tells a held port from a free one by binding, not by connecting', async () => {
    const port = await wedgedListener();
    expect(await isPortHeld(port)).toBe(true);
    const free = net.createServer();
    await new Promise<void>((r) => free.listen({ port: 0, host: '127.0.0.1' }, r));
    const freePort = (free.address() as net.AddressInfo).port;
    await new Promise<void>((r) => free.close(() => r()));
    expect(await isPortHeld(freePort)).toBe(false);
  });

  it.runIf(process.platform === 'darwin')(
    'reports a busy daemon, not a failed install, and does not spend the cold-start budget',
    async () => {
      const port = await wedgedListener();
      // First run installs; the second changes nothing, so the daemon holding
      // the port on entry is one that was already there — busy, not starting.
      await run(port, { probeHealth: async () => true });
      const started = Date.now();
      const result = await run(port, { busyTimeoutMs: 300 });
      const elapsed = Date.now() - started;

      expect(result.state.phase).toBe('unresponsive');
      const message = (result.state as { message: string }).message;
      expect(message).toContain('busy');
      expect(message).not.toContain('never answered');
      // The regression this guards: 30 s of "Setting up trace-mcp" over an
      // index that was readable on disk the whole time. The ceiling is the
      // budget itself — a poll that outlives it is the bug next door.
      expect(elapsed).toBeLessThan(1_500);
    },
  );

  it.runIf(process.platform === 'darwin')(
    'still gives a daemon it just restarted the full cold-start budget',
    async () => {
      const port = await wedgedListener();
      const started = Date.now();
      // A first run: this one installs and starts the daemon, so a held port
      // means "coming up", and cutting the wait short would call a cold start
      // busy. The verdict is still "busy", never "install failed".
      const result = await run(port, { healthTimeoutMs: 600, busyTimeoutMs: 10 });
      expect(result.state.phase).toBe('unresponsive');
      expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    },
  );

  it.runIf(process.platform === 'darwin')(
    'calls a daemon that died during the wait missing, not busy',
    async () => {
      const port = await wedgedListener();
      await run(port, { probeHealth: async () => true });
      const result = await run(port, {
        busyTimeoutMs: 100,
        probeHealth: async () => {
          // The daemon exits while we wait: the port is free by the time the
          // verdict is written, and the verdict has to follow.
          for (const srv of servers.splice(0)) await new Promise<void>((r) => srv.close(() => r()));
          return false;
        },
      });
      expect(result.state.phase).toBe('failed');
    },
  );

  it.runIf(process.platform === 'darwin')('still calls it failed when nothing is listening', async () => {
    const free = net.createServer();
    await new Promise<void>((r) => free.listen({ port: 0, host: '127.0.0.1' }, r));
    const port = (free.address() as net.AddressInfo).port;
    await new Promise<void>((r) => free.close(() => r()));

    const result = await run(port, { healthTimeoutMs: 200 });
    expect(result.state.phase).toBe('failed');
    expect((result.state as { message: string }).message).toContain('nothing is listening');
  });
});
