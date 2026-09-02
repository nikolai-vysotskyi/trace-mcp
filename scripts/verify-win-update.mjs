#!/usr/bin/env node
/**
 * End-to-end check of the Windows self-update path, on a real install (TRA-368).
 *
 * The failure this exists for is silent and total: a Windows install that cannot
 * update polls forever and simply never offers a new version — indistinguishable
 * from "no new release yet". Nobody reports it, because nothing visibly breaks.
 * It has already happened once (TRA-592: `latest.yml` named an installer that was
 * not on the release), and no unit test can catch that class of bug, because it
 * is a property of the published release rather than of the code.
 *
 * **The installed app performs the update.** This script installs the previous
 * release and then drives that build's own IPC — `applyUpdate()` and
 * `restartApp()`, the two calls the Update and Restart buttons make — over the
 * DevTools protocol, with the window created but never mapped. So the run
 * exercises the real channel guard, the real `electron-updater` import out of
 * the packaged asar, the real feed URL from the bundle's `app-update.yml`, the
 * real sha512 check, and the real `quitAndInstall()`. A regression in any of
 * them fails here. An earlier revision re-implemented that sequence and ran the
 * installer itself; it would have passed while every user stayed stuck.
 *
 *   1. install the PREVIOUS release's NSIS installer silently
 *   2. sanity-check the feed directly, for a precise error when IT is the fault
 *   3. the installed app checks and downloads through its own update IPC
 *   4. the installed app restarts itself into the new build
 *   5. assert the registry shows one install at the new version, and that
 *      update.log records the electron-updater path with no npm calls
 *
 * Windows only. Usage:
 *   node scripts/verify-win-update.mjs [from-tag]     (or FROM_TAG=v3.10.0)
 * With no argument the previous stable release carrying an installer is used.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, waitForPage } from '../packages/app/scripts/electron-cdp.mjs';

const REPO = 'nikolai-vysotskyi/trace-mcp';
const PRODUCT = 'trace-mcp';
const CDP_PORT = 9333;
const LATEST = `https://github.com/${REPO}/releases/latest/download`;

const UNINSTALL_KEYS = [
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
].join("','");

/** Throws rather than exits, so every check below is reachable from a test. */
function die(msg) {
  throw new Error(msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, { accept, range } = {}) {
  const headers = { 'user-agent': 'trace-mcp-update-check' };
  if (accept) headers.accept = accept;
  if (range) headers.range = range;
  // Only on the API, which a runner shares an IP for and would otherwise hit the
  // 60/h anonymous limit on. NOT on release downloads: those redirect to signed
  // object-storage URLs that reject a request carrying an Authorization header
  // as well, and the assets are public anyway.
  if (process.env.GH_TOKEN && url.startsWith('https://api.github.com/')) {
    headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
  }
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) die(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res;
}

/** Newer? Plain numeric compare — release tags here are always x.y.z. */
export function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/**
 * The fields electron-updater acts on, pulled out of latest.yml by hand. A YAML
 * parser is not worth a dependency for `key: value` at column 0, and `files:`
 * entries are indented, so the top-level `path` wins.
 */
export function readFeed(text) {
  const field = (k) => text.match(new RegExp(`^${k}:\\s*(.+?)\\s*$`, 'm'))?.[1];
  const feed = { version: field('version'), file: field('path') };
  for (const [k, v] of Object.entries(feed)) {
    if (!v) die(`latest.yml has no top-level \`${k === 'file' ? 'path' : k}\`:\n${text}`);
  }
  return feed;
}

/**
 * `update.log` is JSON lines. The two things worth asserting are that the
 * electron-updater branch ran and that the npm branch did not — the npm events
 * are unreachable on win32 by `updateChannelFor`, so seeing one means the
 * channel guard picked the wrong path.
 */
export function auditUpdateLog(text) {
  const events = text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line).event;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const problems = [];
  // The issue asked for `apply-update:electron-updater-downloaded`; the event
  // the code actually writes (packages/app/src/main/index.ts) is this one.
  if (!events.includes('apply-update:downloaded')) {
    problems.push('no `apply-update:downloaded` — the electron-updater branch never completed');
  }
  const npm = events.filter((e) => e === 'apply-update:no-npm' || e.startsWith('resolve-npm:'));
  if (npm.length) problems.push(`npm-path events present: ${npm.join(', ')}`);
  return { events, problems };
}

function powershell(script) {
  return execFileSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
  }).trim();
}

/**
 * Every trace-mcp version Windows believes is installed, from the uninstall
 * entries electron-builder's NSIS target writes (named `trace-mcp <version>`).
 * Not a path under `%LOCALAPPDATA%\\Programs` — the real directory is
 * `trace-mcp-app`, derived from the appId, and the registry is what Add/Remove
 * Programs and the next installer read anyway.
 *
 * A list rather than one value because "exactly one install, at the new
 * version" is the property worth asserting: an upgrade that left the old entry
 * behind is a half-applied update.
 */
function installedVersions() {
  const out = powershell(
    `$ErrorActionPreference='SilentlyContinue'
     Get-ItemProperty '${UNINSTALL_KEYS}' |
       Where-Object { $_.DisplayName -like '${PRODUCT} *' } |
       ForEach-Object { $_.DisplayVersion }
     exit 0`,
  );
  return out
    ? out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/**
 * Where the installed app lives. This NSIS target writes no `InstallLocation`,
 * so the uninstaller's own path is what locates the directory — it is quoted and
 * followed by `/currentuser`, e.g. `"…\\trace-mcp-app\\Uninstall trace-mcp.exe"
 * /currentuser`. Property access rather than `-ExpandProperty`: expanding a
 * property an entry does not carry makes powershell exit non-zero.
 */
function installedExe() {
  const raw = powershell(
    `$ErrorActionPreference='SilentlyContinue'
     $e = Get-ItemProperty '${UNINSTALL_KEYS}' |
       Where-Object { $_.DisplayName -like '${PRODUCT} *' } | Select-Object -First 1
     if ($e) { if ($e.InstallLocation) { $e.InstallLocation } else { $e.UninstallString } }
     exit 0`,
  );
  if (!raw) die('no trace-mcp entry in the uninstall registry to locate the app from');
  const target = raw.startsWith('"') ? raw.slice(1, raw.indexOf('"', 1)) : raw.split(' /')[0];
  const dir =
    fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.dirname(target);
  const exe = path.join(dir, `${PRODUCT}.exe`);
  if (!fs.existsSync(exe)) die(`uninstall entry points at ${dir}, which holds no ${PRODUCT}.exe`);
  return exe;
}

function killApp() {
  // Failing to kill is cleanup noise, not a verification failure.
  powershell(
    `$ErrorActionPreference='SilentlyContinue'; Get-Process ${PRODUCT} | Stop-Process -Force; exit 0`,
  );
}

/** Printed on any failure — this runs where nobody can look around afterwards. */
function dumpInstallState(traceHome) {
  console.log('--- install state');
  console.log(
    powershell(
      `$ErrorActionPreference='SilentlyContinue'
       Get-ChildItem "$env:LOCALAPPDATA\\Programs" -Recurse -Depth 1 -Filter '*.exe' |
         Select-Object -ExpandProperty FullName
       Get-ItemProperty '${UNINSTALL_KEYS}' |
         Where-Object { $_.DisplayName -like '*trace*' } |
         Format-List DisplayName,DisplayVersion,InstallLocation,UninstallString`,
    ) || '(nothing under %LOCALAPPDATA%\\Programs, no matching uninstall entry)',
  );
  const log = path.join(traceHome, 'update.log');
  console.log(`--- ${log}`);
  console.log(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '(not written)');
}

/**
 * Poll until the registry settles on exactly `wantVersion`.
 *
 * Neither the installer's exit nor `quitAndInstall()` returning means the swap
 * is done: the oneClick target hands off to a phase that outlives the process
 * we waited on, and an upgrade removes the old build before registering the new
 * one, so for a moment nothing is installed at all.
 */
async function waitForInstalled(wantVersion, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let seen = [];
  while (Date.now() < deadline) {
    seen = installedVersions();
    if (seen.length === 1 && seen[0] === wantVersion) return true;
    await sleep(3_000);
  }
  console.log(`expected exactly [${wantVersion}], registry shows [${seen.join(', ')}]`);
  return false;
}

async function download(url, dest) {
  const buf = Buffer.from(await (await get(url)).arrayBuffer());
  fs.writeFileSync(dest, buf);
}

/** The newest stable release carrying a Windows installer, and the one before it. */
async function resolveTags() {
  const res = await get(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
    accept: 'application/vnd.github+json',
  });
  const withInstaller = (await res.json()).filter(
    (r) =>
      !r.draft && !r.prerelease && r.assets.some((a) => /^trace-mcp\.Setup\..+\.exe$/.test(a.name)),
  );
  if (withInstaller.length < 2) {
    die('fewer than two stable releases carry a Windows installer — nothing to update from');
  }
  return { latest: withInstaller[0].tag_name, previous: withInstaller[1].tag_name };
}

/** One CDP evaluation of `expression`, with its promise awaited in the page. */
async function evaluate(cdp, expression, timeoutMs) {
  const result = await Promise.race([
    cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    sleep(timeoutMs).then(() => die(`\`${expression}\` did not settle in ${timeoutMs}ms`)),
  ]);
  if (result.exceptionDetails) {
    die(`\`${expression}\` threw: ${result.exceptionDetails.exception?.description ?? '?'}`);
  }
  return result.result?.value;
}

/**
 * The installed app, with its window created but never mapped
 * (`TRACE_MCP_WINDOW_MODE=hidden`, TRA-403) and its own user-data dir so it does
 * not fight another instance for Electron's single-instance lock. `TRACE_HOME`
 * points update.log somewhere this script can read it without guessing which of
 * `~/.trace` / `~/.trace-mcp` the machine is on.
 */
function launchApp(exe, traceHome, userDataDir) {
  const child = spawn(
    exe,
    [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`],
    {
      env: {
        ...process.env,
        TRACE_HOME: traceHome,
        TRACE_MCP_WINDOW_MODE: 'hidden',
        ELECTRON_RUN_AS_NODE: undefined,
      },
      stdio: 'inherit',
      detached: false,
    },
  );
  child.on('error', (err) => console.error(`[app] spawn failed: ${err.message}`));
  return child;
}

async function main() {
  if (process.platform !== 'win32') die('this check must run on Windows');

  const { latest, previous } = await resolveTags();
  const fromTag = process.argv[2] || process.env.FROM_TAG || previous;
  const fromVersion = fromTag.replace(/^v/, '');
  console.log(`Updating a ${fromTag} install; newest stable release is ${latest}.`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmu-'));
  const traceHome = path.join(tmp, 'trace-home');
  fs.mkdirSync(traceHome, { recursive: true });

  try {
    // 1. Baseline: the release a user would be sitting on.
    const oldSetup = path.join(tmp, `trace-mcp.Setup.${fromVersion}.exe`);
    await download(
      `https://github.com/${REPO}/releases/download/${fromTag}/trace-mcp.Setup.${fromVersion}.exe`,
      oldSetup,
    );
    console.log(`> ${path.basename(oldSetup)} /S`);
    execFileSync(oldSetup, ['/S'], { stdio: 'inherit', timeout: 10 * 60_000 });
    if (!(await waitForInstalled(fromVersion, 3 * 60_000))) die(`could not install ${fromTag}`);
    killApp(); // oneClick launches the app when it finishes (`runAfterFinish`)
    console.log(`Installed ${fromVersion}.`);

    // 2. Diagnostics only. The app does its own feed fetch and hash check below;
    // these two lines are here so that when the FEED is what broke, the failure
    // says so instead of surfacing as an opaque updater error. This is the check
    // that caught TRA-592.
    const feedText = await (await get(`${LATEST}/latest.yml`)).text();
    console.log(`--- ${LATEST}/latest.yml\n${feedText}`);
    const feed = readFeed(feedText);
    if (!isNewer(feed.version, fromVersion)) {
      die(
        `latest.yml offers ${feed.version}, not newer than the installed ${fromVersion} — no update would ever be offered`,
      );
    }
    // One byte, over the same redirect chain the updater follows — enough to
    // prove the name in the feed resolves to a real, fetchable asset.
    await get(`${LATEST}/${feed.file}`, { range: 'bytes=0-0' });
    console.log(`Feed names ${feed.file}, which is on the release.`);

    // 3. Hand over to the app: this is `applyUpdate()`, the call the Update
    // button makes, running inside the installed build.
    const app = launchApp(installedExe(), traceHome, path.join(tmp, 'user-data'));
    const page = await waitForPage(120_000, `http://127.0.0.1:${CDP_PORT}`);
    const cdp = await connect(page.webSocketDebuggerUrl);

    const applied = await evaluate(cdp, 'window.electronAPI.applyUpdate()', 15 * 60_000);
    console.log(`applyUpdate() -> ${JSON.stringify(applied)}`);
    if (!applied?.ok || !applied.pending) die(`applyUpdate() refused: ${applied?.error ?? '?'}`);
    if (applied.version !== feed.version) {
      die(`applyUpdate() reports ${applied.version}, latest.yml offers ${feed.version}`);
    }

    // 4. And this is the Restart button: quitAndInstall(). The app tears itself
    // down, so the evaluation never returns a value — the assertion is the swap.
    await evaluate(cdp, 'window.electronAPI.restartApp()', 60_000).catch(() => {});
    if (!(await waitForInstalled(feed.version, 5 * 60_000))) {
      die(`restartApp() did not swap the install to ${feed.version}`);
    }
    app.kill();
    killApp(); // quitAndInstall relaunches the new build

    // 5. The audit trail the issue asked for.
    const logPath = path.join(traceHome, 'update.log');
    if (!fs.existsSync(logPath)) die(`the app wrote no update.log under ${traceHome}`);
    const { events, problems } = auditUpdateLog(fs.readFileSync(logPath, 'utf8'));
    console.log(`update.log events: ${events.join(', ')}`);
    if (problems.length) die(`update.log: ${problems.join('; ')}`);

    console.log(
      `OK: the installed ${fromVersion} app updated itself to ${feed.version} through electron-updater, with no npm calls.`,
    );
  } catch (err) {
    dumpInstallState(traceHome);
    throw err;
  }
}

// Importing this module (the tests do) must not run the install.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
