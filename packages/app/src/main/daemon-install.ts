/**
 * The app installs and repairs its own daemon (TRA-438).
 *
 * Until now the whole control plane — `~/.trace-mcp/launcher.env`, the
 * launcher shim, the LaunchAgent — was written by the npm package's
 * postinstall (`scripts/postinstall-control-plane.mjs`). Someone who installs
 * the DMG never runs npm, so they got none of it and met an empty dashboard
 * with a Start button that could not work: there was nothing to start.
 *
 * The app ships the server (`packages/app/scripts/stage-server.mjs` stages it
 * into `Contents/Resources/server`) and runs it through its own binary with
 * `ELECTRON_RUN_AS_NODE=1`, so a machine with no Node on it still gets a
 * daemon. This module is what puts it in place, on first launch and after
 * every version change.
 *
 * Two rules shape everything here:
 *
 *  - **Idempotent.** Running it twice changes nothing the second time. Every
 *    write is guarded by a read of what is already there.
 *  - **Adopt, never duplicate.** An npm-installed machine already has a
 *    working control plane. We reuse the same paths and the same LaunchAgent
 *    label, so there is only ever one agent, and we leave a current npm
 *    install pointing at itself — see `decideTakeover`.
 */

import {
  execFile,
  execFileSync,
  type ExecFileException,
  type ExecFileOptions,
} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_DAEMON_PORT,
  generatePlist,
  PLIST_LABEL,
  PLIST_MARKER,
} from './daemon-plist';

export { generatePlist, PLIST_LABEL, PLIST_MARKER, PLIST_VERSION } from './daemon-plist';

const IS_WINDOWS = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

import { getLauncherDir, getLauncherShimPath, SHIM_NAMES } from './trace-home';

export { getLauncherDir };


/** The wrapper that turns our own binary back into a Node runtime. */
const RUNTIME_SHIM_NAME = IS_WINDOWS ? 'node-runtime.cmd' : 'node-runtime';

// ── pure decision layer ──────────────────────────────────────────────

/** Numeric-dotted compare; prerelease suffixes are ignored, not ordered. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface ControlPlaneState {
  /** Path to the server the app ships, or null when this is a dev run. */
  bundledCli: string | null;
  /** Version of the shipped server (the app's own version). */
  bundledVersion: string;
  /** TRACE_MCP_VERSION from the installed launcher.env, if any. */
  installedVersion?: string;
  /** The installed launcher.env resolves to a runtime and a cli.js that exist. */
  installedRunnable: boolean;
  /** `~/.trace-mcp/daemon.disabled` — the user's own opt-out (#202). */
  daemonDisabled?: boolean;
}

export interface TakeoverDecision {
  takeover: boolean;
  reason: string;
}

/**
 * Should the app repoint the control plane at its own bundled server?
 *
 * The one case that must answer "no" is a healthy npm install at or beyond the
 * app's version: it already works, and rewriting `launcher.env` under it would
 * be the app fighting the postinstall for the same file on every launch.
 * Everything else — nothing installed, a broken pointer, an older daemon than
 * the app (the `daemon=3.2.0 app=3.3.0` case) — is ours to repair.
 */
export function decideTakeover(s: ControlPlaneState): TakeoverDecision {
  if (!s.bundledCli) {
    return { takeover: false, reason: 'no bundled server — dev build' };
  }
  if (s.daemonDisabled) {
    return { takeover: false, reason: 'daemon disabled by opt-out' };
  }
  if (!s.installedRunnable) {
    return { takeover: true, reason: 'no working daemon installed' };
  }
  if (!s.installedVersion) {
    return { takeover: true, reason: 'installed daemon version unknown' };
  }
  if (compareVersions(s.installedVersion, s.bundledVersion) < 0) {
    return {
      takeover: true,
      reason: `installed daemon ${s.installedVersion} is older than the app ${s.bundledVersion}`,
    };
  }
  return { takeover: false, reason: `installed daemon ${s.installedVersion} is current` };
}

/** What the renderer is told while this runs. */
export type DaemonSetupState =
  | { phase: 'idle' }
  | { phase: 'installing' }
  | { phase: 'ready' }
  /* The daemon exists, holds the port and did not answer in time — busy, not
     missing (TRA-939). A different cause and a different cure from `failed`:
     nothing here needs reinstalling, so this state offers no repair button. */
  | { phase: 'unresponsive'; message: string }
  | { phase: 'failed'; message: string };

// ── filesystem layer ─────────────────────────────────────────────────

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write only when the content differs — that is what makes this idempotent. */
function writeIfChanged(filePath: string, content: string, mode: number): boolean {
  try {
    if (fs.readFileSync(filePath, 'utf-8') === content) {
      if (!IS_WINDOWS) fs.chmodSync(filePath, mode);
      return false;
    }
  } catch {
    /* missing or unreadable — write it */
  }
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, filePath);
  if (!IS_WINDOWS) fs.chmodSync(filePath, mode);
  return true;
}

function isExecutable(p: string | undefined): boolean {
  if (!p) return false;
  try {
    const st = fs.statSync(p);
    return st.isFile() && (IS_WINDOWS || (st.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function isFile(p: string | undefined): boolean {
  if (!p) return false;
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Parse launcher.env with the same rules the shim uses. */
export function readLauncherEnv(dir = getLauncherDir()): {
  node?: string;
  cli?: string;
  version?: string;
} {
  const out: { node?: string; cli?: string; version?: string } = {};
  let content: string;
  try {
    content = fs.readFileSync(path.join(dir, 'launcher.env'), 'utf-8');
  } catch {
    return out;
  }
  for (const raw of content.split('\n')) {
    const line = raw.trimStart();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    // Both spellings: a launcher.env written by a CLI that has taken the
    // TRACE_* rename (TRA-610) has to stay readable by an app that predates it,
    // and vice versa. Reading is where tolerance is free; writing still emits
    // the legacy keys, below, because the installed shim reads those.
    if (key === 'TRACE_NODE' || key === 'TRACE_MCP_NODE') out.node = value;
    else if (key === 'TRACE_CLI' || key === 'TRACE_MCP_CLI') out.cli = value;
    else if (key === 'TRACE_VERSION' || key === 'TRACE_MCP_VERSION') out.version = value;
  }
  return out;
}

/**
 * The command the app should shell out to. A machine that only ever installed
 * the DMG has nothing on PATH — the shim this module wrote is the only one
 * there is — so a bare bin name fails with ENOENT and every client the setup
 * wizard tries to connect silently does nothing.
 *
 * The shim's own name is whichever one is installed (`trace` after TRA-610,
 * `trace-mcp` before it); the PATH fallback stays on the legacy name, which the
 * package ships as an alias and which therefore resolves on both sides of the
 * rename. An explicit TRACE_BIN / TRACE_MCP_BIN wins over both.
 */
export function resolveCliCommand(dir = getLauncherDir()): string {
  const override = process.env.TRACE_BIN?.trim() || process.env.TRACE_MCP_BIN?.trim();
  if (override && isExecutable(override)) return override;
  const shim = getLauncherShimPath(dir);
  return isExecutable(shim) ? shim : SHIM_NAMES[SHIM_NAMES.length - 1];
}

/** How to spawn the CLI with no shell: `execFile(file, [...prefixArgs, ...argv])`. */
export interface CliInvocation {
  file: string;
  prefixArgs: string[];
  /** Environment the runner needs, merged over `process.env` by `execCli`. */
  env?: Record<string, string>;
}

/**
 * The shim `resolveCliCommand` returns is a `.cmd` on Windows, and Node cannot
 * launch a `.bat`/`.cmd` at all without a shell — see
 * https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows.
 * Every no-shell `execFile` against it therefore failed, which is why the MCP
 * clients screen could not read a status, Connect or Update on Windows
 * (TRA-638). The PATH fallback does not rescue it either: there is no
 * extensionless `trace-mcp` on Windows.
 *
 * `shell: true` is not the fix. The argv these callers pass carries project
 * paths; it is passed as argv precisely so that spaces and `&` in them are
 * never interpreted, and turning on a shell would reopen that.
 *
 * So run the CLI the way the shim itself runs it: a real executable with
 * `cli.js` as its first argument. `launcher.env` already records that cli.js,
 * and our own binary is a Node runtime under `ELECTRON_RUN_AS_NODE` — which is
 * the whole job of `bin/node-runtime.cmd`. The caller's argv stays argv.
 */
export function resolveCliInvocation(
  opts: { dir?: string; execPath?: string; isWindows?: boolean } = {},
): CliInvocation {
  const dir = opts.dir ?? getLauncherDir();
  const viaShim: CliInvocation = { file: resolveCliCommand(dir), prefixArgs: [] };
  if (!(opts.isWindows ?? IS_WINDOWS)) return viaShim;

  // Nothing installed to point at: fall through and let the spawn fail with
  // the same ENOENT it would have anyway, rather than inventing a path.
  const { cli } = readLauncherEnv(dir);
  if (!cli || !isFile(cli)) return viaShim;

  return {
    file: opts.execPath ?? process.execPath,
    prefixArgs: [cli],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

/**
 * `execFile` against the CLI, with the Windows launcher problem solved once.
 * Callers go through here rather than `resolveCliCommand` so a fourth IPC
 * cannot quietly reintroduce the spawn that does not work.
 */
export function execCli(
  args: string[],
  options: Omit<ExecFileOptions, 'encoding'>,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
): void {
  const { file, prefixArgs, env } = resolveCliInvocation();
  execFile(
    file,
    [...prefixArgs, ...args],
    {
      windowsHide: true,
      ...options,
      encoding: 'utf-8',
      env: { ...process.env, ...options.env, ...env },
    },
    callback,
  );
}

/**
 * Where the staged server lives inside the packaged app, or null when running
 * from a checkout (`pnpm dev:electron`), where the developer's own npm install
 * owns the control plane and this module must keep its hands off.
 */
export function bundledServerDir(
  // `process.resourcesPath` is Electron's, and since daemon-lifecycle.ts reaches
  // this module for `resolveCliInvocation`, the root tsconfig compiles this file
  // too (src/daemon/__tests__ imports daemon-lifecycle) — with plain Node types.
  resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
): string | null {
  if (!resourcesPath) return null;
  const dir = path.join(resourcesPath, 'server');
  return isFile(path.join(dir, 'dist', 'cli.js')) ? dir : null;
}

/**
 * A one-line runtime wrapper, because the launcher shim execs
 * `$TRACE_MCP_NODE "$TRACE_MCP_CLI"` with no environment of its own and
 * Electron only behaves as Node when `ELECTRON_RUN_AS_NODE` is set. Writing
 * the wrapper here rather than teaching the shim about Electron keeps the shim
 * (which MCP clients also invoke) free of app-specific knowledge.
 */
export function runtimeShimContent(execPath: string): string {
  if (IS_WINDOWS) {
    return [
      '@echo off',
      'rem Managed by the trace-mcp app (TRA-438) — do not edit by hand.',
      'set ELECTRON_RUN_AS_NODE=1',
      `"${execPath}" %*`,
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/bash',
    '# Managed by the trace-mcp app (TRA-438) — do not edit by hand.',
    '# Runs the app binary as a plain Node runtime so the daemon needs no',
    '# Node installed on the machine.',
    'export ELECTRON_RUN_AS_NODE=1',
    `exec "${execPath}" "$@"`,
    '',
  ].join('\n');
}

export function launcherEnvContent(nodePath: string, cliPath: string, version: string): string {
  const quote = (v: string) => {
    if (v.includes('"')) throw new Error(`launcher config value contains a double quote: ${v}`);
    return `"${v}"`;
  };
  const cli = cliPath.replaceAll('\\', '/');
  return [
    '# Managed by the trace-mcp app — do not edit by hand.',
    '# Rewritten whenever the app installs or repairs its bundled daemon.',
    '#',
    // Both key families, because this file and the shim that reads it are
    // versioned independently: the app takes over an existing install and
    // rewrites launcher.env wholesale, while `init` owns the shim. Once
    // TRA-610 renames the shim to read TRACE_*, an app that still wrote only
    // TRACE_MCP_* would erase the keys the newly-selected `trace` shim needs —
    // launchd would then start a shim with no Node and no CLI to exec. A shim
    // ignores keys it does not know, so writing both costs three lines and
    // removes the ordering dependency between the two releases entirely.
    `TRACE_NODE=${quote(nodePath)}`,
    `TRACE_CLI=${quote(cli)}`,
    `TRACE_VERSION=${quote(version)}`,
    `TRACE_MCP_NODE=${quote(nodePath)}`,
    `TRACE_MCP_CLI=${quote(cli)}`,
    `TRACE_MCP_VERSION=${quote(version)}`,
    '',
  ].join('\n');
}

// ── launchd layer ────────────────────────────────────────────────────

function launchctl(args: string[]): { ok: boolean; stderr: string } {
  try {
    execFileSync('/bin/launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stderr: '' };
  } catch (err) {
    const e = err as { stderr?: Buffer };
    return { ok: false, stderr: e.stderr?.toString() ?? '' };
  }
}

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
}

/**
 * Is something already listening on this port?
 *
 * Asked by binding, not by connecting: a wedged daemon's accept queue is full,
 * so a connect attempt sits in SYN_SENT and answers nothing — which is exactly
 * the state we are trying to name. A bind that fails with EADDRINUSE proves a
 * LISTEN socket is held without adding one more connection to the queue.
 *
 * ponytail: this holds the port for the ~1 ms of a successful bind, so a daemon
 * binding in exactly that window would see EADDRINUSE and be restarted by
 * launchd. Called twice per launch at most; if that ever shows up in the logs,
 * the upgrade path is reading the LISTEN table (`lsof`/`netstat`) instead.
 */
export function isPortHeld(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      // Only EADDRINUSE proves a listener. Any other bind failure (EACCES on a
      // locked-down machine) is not evidence of one, and answering "held" on it
      // would call a machine with no daemon busy.
      resolve(err.code === 'EADDRINUSE');
    });
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      probe.close(() => resolve(false));
    });
  });
}

/**
 * Poll /health until it answers or the budget runs out.
 *
 * The wait between attempts doubles (TRA-939). A fixed 500 ms poll spent the
 * whole 30 s budget opening 60 connections into an accept queue that was
 * already full — the client's retries were part of what kept it full. Backing
 * off costs nothing when the daemon is coming up in a second or two, and stops
 * the app from making a busy daemon busier.
 */
async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let wait = 250;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(
        // Bounded by whatever is left of the budget as well as by its own
        // ceiling: a 2 s poll started at 4.9 s of a 5 s budget otherwise runs
        // the wait 35% past the number the caller asked for.
        { host: '127.0.0.1', port, path: '/health', timeout: Math.min(2000, Math.max(1, deadline - Date.now())) },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, Math.min(wait, Math.max(0, deadline - Date.now()))));
    wait = Math.min(wait * 2, 4000);
  }
  return false;
}

// ── orchestration ────────────────────────────────────────────────────

export interface EnsureOptions {
  appVersion: string;
  /** The app's own binary — used as the Node runtime for the daemon. */
  execPath?: string;
  resourcesPath?: string;
  port?: number;
  /** How long to wait for /health before calling the install failed. */
  healthTimeoutMs?: number;
  /** How long to wait when the port is already held — a daemon that exists is
      not being waited for, it is being given a moment. */
  busyTimeoutMs?: number;
  log?: (message: string) => void;
  /* Seams, so the idempotence and file-layout tests can run without touching
     the machine's real LaunchAgents directory or its launchd domain. */
  launchAgentPath?: string;
  runLaunchctl?: (args: string[]) => { ok: boolean; stderr: string };
  probeHealth?: (port: number, timeoutMs: number) => Promise<boolean>;
}

export interface EnsureResult {
  state: DaemonSetupState;
  /** Whether anything on disk actually changed — false on a repeat run. */
  changed: boolean;
  reason: string;
}

/**
 * Record in daemon.log that the app is about to stop the running daemon (TRA-850).
 *
 * `bootout` on a loaded job and `kickstart -k` both SIGTERM the daemon, and the
 * app's own `log()` goes to the Electron console — from daemon.log's side the
 * stop showed up as a bare `reason: SIGTERM` with no initiator. Writes the same
 * pino-shaped NDJSON record `src/daemon/lifecycle.ts` and the postinstall
 * scripts write, so the lines read alike whoever produced them. The three
 * copies of this shape exist because the daemon, the install scripts and the
 * Electron main process share no runtime.
 *
 * Best-effort: a failed append must never break the install.
 */
function logDaemonStopAttribution(home: string, action: 'bootout' | 'kickstart', via: string): void {
  try {
    fs.appendFileSync(
      path.join(home, 'daemon.log'),
      `${JSON.stringify({
        level: 30,
        time: Date.now(),
        pid: process.pid,
        name: 'trace-mcp',
        action,
        via,
        requesterPid: process.pid,
        requesterPpid: process.ppid,
        managedBy: 'desktop-app',
        msg: `Daemon ${action} requested`,
      })}\n`,
    );
  } catch {
    /* attribution is best-effort */
  }
}

/**
 * Install or repair the daemon. Safe to call on every launch; on a machine
 * that is already set up it reads four files, writes none, and returns.
 */
export async function ensureDaemonInstalled(opts: EnsureOptions): Promise<EnsureResult> {
  const log = opts.log ?? ((m: string) => console.log(`[trace-mcp] ${m}`));
  const port = opts.port ?? DEFAULT_DAEMON_PORT;
  const execPath = opts.execPath ?? process.execPath;
  const home = getLauncherDir();
  const binDir = path.join(home, 'bin');

  const serverDir = bundledServerDir(opts.resourcesPath);
  const env = readLauncherEnv(home);
  const daemonDisabled = fs.existsSync(path.join(home, 'daemon.disabled'));
  const decision = decideTakeover({
    bundledCli: serverDir ? path.join(serverDir, 'dist', 'cli.js') : null,
    bundledVersion: opts.appVersion,
    installedVersion: env.version,
    installedRunnable: isExecutable(env.node) && isFile(env.cli),
    daemonDisabled,
  });
  log(`daemon install: ${decision.reason}`);

  // The opt-out means "do not run a daemon on this machine". Honour it before
  // touching launchd — the app is not allowed to undo it (#202).
  if (daemonDisabled) {
    return { state: { phase: 'idle' }, changed: false, reason: decision.reason };
  }

  // A dev run has no payload to install and no business rewriting the
  // developer's own npm-managed control plane.
  if (!serverDir) {
    return { state: { phase: 'idle' }, changed: false, reason: decision.reason };
  }

  let changed = false;

  if (decision.takeover && serverDir) {
    try {
      ensureDir(binDir);
      const runtimeShim = path.join(binDir, RUNTIME_SHIM_NAME);
      changed = writeIfChanged(runtimeShim, runtimeShimContent(execPath), 0o755) || changed;

      // The launcher shim itself ships in the payload's hooks/, so a DMG-only
      // machine gets the same shim an npm install would have written.
      const shimSources = IS_WINDOWS
        ? [
            ['trace-mcp-launcher.cmd', 'trace-mcp.cmd'],
            ['trace-mcp-launcher.ps1', 'trace-mcp-launcher.ps1'],
          ]
        : [['trace-mcp-launcher.sh', 'trace-mcp']];
      for (const [src, dest] of shimSources) {
        const from = path.join(serverDir, 'hooks', src);
        changed = writeIfChanged(path.join(binDir, dest), fs.readFileSync(from, 'utf-8'), 0o755) || changed;
      }

      changed =
        writeIfChanged(
          path.join(home, 'launcher.env'),
          launcherEnvContent(
            runtimeShim,
            path.join(serverDir, 'dist', 'cli.js'),
            opts.appVersion,
          ),
          0o600,
        ) || changed;
    } catch (err) {
      const message = `could not install the bundled daemon: ${(err as Error).message}`;
      log(message);
      return { state: { phase: 'failed', message }, changed, reason: decision.reason };
    }
  }

  if (!IS_MAC) {
    // No launchd anywhere else; `trace-mcp daemon start` owns spawning there,
    // and it now has a runtime and a cli.js to spawn.
    return { state: { phase: 'ready' }, changed, reason: decision.reason };
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null) return { state: { phase: 'ready' }, changed, reason: decision.reason };
  const domain = `gui/${uid}`;
  const plist = opts.launchAgentPath ?? plistPath();
  const runLaunchctl = opts.runLaunchctl ?? launchctl;
  // Whichever shim name is actually on disk: the LaunchAgent must exec a file
  // that exists, and after the TRA-610 rename that is `trace` on a machine the
  // CLI has migrated and `trace-mcp` on one it has not.
  const shimPath = getLauncherShimPath(home);

  /* Was a daemon already answering for this port before we touched launchd?
     Asked here, not after the restart: a daemon we just kickstarted binds its
     socket in milliseconds and only becomes healthy once it has loaded its
     index, so "port held" after the restart says nothing about whether the
     wait is a cold start or a wedge. Before the restart it says exactly that. */
  const heldOnEntry = await isPortHeld(port);

  let plistCurrent = false;
  try {
    plistCurrent = fs.readFileSync(plist, 'utf-8').includes(PLIST_MARKER);
  } catch {
    /* absent */
  }

  if (!plistCurrent) {
    // Boot out whatever is there before replacing the file — launchd keeps
    // serving the loaded copy otherwise.
    if (fs.existsSync(plist)) {
      logDaemonStopAttribution(home, 'bootout', 'desktop-app: plist refresh');
      runLaunchctl(['bootout', domain, plist]);
      runLaunchctl(['unload', plist]);
    }
    try {
      writeIfChanged(plist, generatePlist(shimPath, home), 0o644);
      changed = true;
    } catch (err) {
      const message = `could not write the LaunchAgent at ${plist}: ${(err as Error).message}`;
      log(message);
      return { state: { phase: 'failed', message }, changed, reason: decision.reason };
    }
  }

  const loaded = runLaunchctl(['list', PLIST_LABEL]).ok;
  if (!loaded) {
    runLaunchctl(['enable', `${domain}/${PLIST_LABEL}`]);
    const boot = runLaunchctl(['bootstrap', domain, plist]);
    if (!boot.ok && !/already loaded|File exists/i.test(boot.stderr)) {
      runLaunchctl(['load', '-w', plist]);
    }
  } else if (changed) {
    // Same label, new binary underneath: restart so the running daemon is the
    // one we just installed. `-k` also resets launchd's throttle.
    logDaemonStopAttribution(home, 'kickstart', 'desktop-app: bundled daemon upgrade');
    runLaunchctl(['kickstart', '-k', `${domain}/${PLIST_LABEL}`]);
  }

  if (!changed && loaded) {
    return { state: { phase: 'ready' }, changed, reason: decision.reason };
  }

  /* A daemon that was already listening before we started is not being waited
     *for* — it is there, and busy. Give it a short grace period rather than the
     full cold-start budget: 30 s of "Setting up trace-mcp" on a screen whose
     data has been on disk the whole time is the defect, and the surfaces
     revalidate on their own once it answers (TRA-939). One we just started gets
     the whole 30 s, because loading an index legitimately takes that long. */
  const busy = heldOnEntry && !changed;
  const budget = busy ? (opts.busyTimeoutMs ?? 5_000) : (opts.healthTimeoutMs ?? 30_000);
  const healthy = await (opts.probeHealth ?? waitForHealth)(port, budget);
  if (healthy) {
    log('daemon install: /health responding');
    return { state: { phase: 'ready' }, changed, reason: decision.reason };
  }
  /* Ask again, always: the answer that matters is whether a daemon is holding
     the port *now*. One that came up during the wait is busy, and one that died
     during it is missing — neither is knowable from the state on entry. */
  if (await isPortHeld(port)) {
    const message = `The daemon is running and holding port ${port}, but it has not answered /health for ${Math.round(budget / 1000)}s — most likely busy indexing. Nothing needs reinstalling. See ${path.join(home, 'daemon.log')}.`;
    log(`daemon install: ${message}`);
    return { state: { phase: 'unresponsive', message }, changed, reason: decision.reason };
  }
  const message = `The daemon was installed but nothing is listening on port ${port}. See ${path.join(home, 'daemon.log')}.`;
  log(`daemon install: ${message}`);
  return { state: { phase: 'failed', message }, changed, reason: decision.reason };
}
