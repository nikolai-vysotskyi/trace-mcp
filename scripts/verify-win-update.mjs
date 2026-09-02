#!/usr/bin/env node
/**
 * End-to-end check of the Windows self-update path, on a real install (TRA-368).
 *
 * The failure this exists for is silent and total: electron-updater on Windows
 * reads `latest.yml` off /releases/latest and nothing else. If that file is
 * absent, stale, or its sha512 does not match the installer beside it, every
 * Windows install polls forever and simply never offers an update —
 * indistinguishable from "no new release yet". Nobody reports it, because
 * nothing visibly breaks. Reading the release-asset list does not catch a
 * mismatched hash, and no unit test can: it is a property of the published
 * release, not of the code.
 *
 * So this reproduces what an installed app actually does:
 *
 *   1. install the PREVIOUS release's NSIS installer silently
 *   2. fetch latest.yml from the exact URL electron-updater resolves
 *   3. download the installer that feed names and verify its sha512 against it
 *   4. run that installer the way electron-updater runs it (`/S --updated`)
 *   5. assert the installed build's version actually advanced
 *
 * Steps 2-4 are electron-updater's own sequence with the library taken out —
 * the library needs a live Electron `app`, and driving a GUI on a runner buys
 * nothing here. What that skips is the eight lines in
 * packages/app/src/main/index.ts that call it; `updateChannelFor` (win32 =>
 * electron-updater, never npm) and the packaged-dependency check already cover
 * those, and neither can go wrong per-release the way the feed can.
 *
 * Windows only. Usage:
 *   node scripts/verify-win-update.mjs [from-tag]     (or FROM_TAG=v3.10.0)
 * With no argument the previous stable release carrying an installer is used.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'nikolai-vysotskyi/trace-mcp';
const INSTALL_DIR = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'trace-mcp');
const APP_EXE = path.join(INSTALL_DIR, 'trace-mcp.exe');

/** Throws rather than exits, so every check below is reachable from a test. */
function die(msg) {
  throw new Error(msg);
}

async function get(url, accept) {
  const headers = { 'user-agent': 'trace-mcp-update-check' };
  if (accept) headers.accept = accept;
  // Unauthenticated works for a public repo, but a runner shares its IP with
  // the rest of GitHub Actions and hits the 60/h anonymous limit.
  if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
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
 * The two fields electron-updater acts on, pulled out of latest.yml by hand.
 * A YAML parser is not worth a dependency for `key: value` at column 0, and
 * `files:` entries are indented, so the top-level `path`/`sha512` win.
 */
export function readFeed(text) {
  const field = (k) => text.match(new RegExp(`^${k}:\\s*(.+?)\\s*$`, 'm'))?.[1];
  const feed = {
    version: field('version'),
    file: field('path'),
    sha512: field('sha512'),
  };
  for (const [k, v] of Object.entries(feed)) {
    if (!v) die(`latest.yml has no top-level \`${k === 'file' ? 'path' : k}\`:\n${text}`);
  }
  return feed;
}

function installedVersion() {
  if (!fs.existsSync(APP_EXE)) return null;
  const v = execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${APP_EXE}').VersionInfo.ProductVersion`],
    { encoding: 'utf8' },
  ).trim();
  return v || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Silent install, then wait for the result to actually be on disk.
 *
 * Two reasons not to trust the installer's exit: the oneClick target hands off
 * to an elevated/spawned phase that outlives the process we waited on, and on
 * an upgrade it removes the old build before laying down the new one, so the
 * exe is briefly absent and then briefly the OLD version. Poll for the version
 * we are expecting rather than sleeping a guessed interval.
 */
async function installAndWaitFor(exe, args, wantVersion) {
  console.log(`> ${path.basename(exe)} ${args.join(' ')}`);
  execFileSync(exe, args, { stdio: 'inherit', timeout: 10 * 60_000 });

  const deadline = Date.now() + 3 * 60_000;
  let seen = null;
  while (Date.now() < deadline) {
    seen = installedVersion();
    if (seen === wantVersion) break;
    await sleep(3_000);
  }

  // `runAfterFinish` defaults on, so the app is now running and holding the
  // install directory open — the next install would fight it. Failing to kill
  // it is not itself a verification failure, hence the swallowed errors.
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "$ErrorActionPreference='SilentlyContinue'; Get-Process trace-mcp | Stop-Process -Force; exit 0",
    ],
    { stdio: 'inherit' },
  );
  return seen;
}

async function download(url, dest) {
  const res = await get(url);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf;
}

/** The newest stable release carrying a Windows installer, and the one before it. */
async function resolveTags() {
  const res = await get(
    `https://api.github.com/repos/${REPO}/releases?per_page=30`,
    'application/vnd.github+json',
  );
  const withInstaller = (await res.json()).filter(
    (r) =>
      !r.draft && !r.prerelease && r.assets.some((a) => /^trace-mcp\.Setup\..+\.exe$/.test(a.name)),
  );
  if (withInstaller.length < 2) {
    die('fewer than two stable releases carry a Windows installer — nothing to update from');
  }
  return { latest: withInstaller[0].tag_name, previous: withInstaller[1].tag_name };
}

async function main() {
  if (process.platform !== 'win32') die('this check must run on Windows');

  const { latest, previous } = await resolveTags();
  const fromTag = process.argv[2] || process.env.FROM_TAG || previous;
  const fromVersion = fromTag.replace(/^v/, '');
  console.log(`Updating a ${fromTag} install; newest stable release is ${latest}.`);

  // 1. Install the previous release.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmu-'));
  const oldSetup = path.join(tmp, `trace-mcp.Setup.${fromVersion}.exe`);
  await download(
    `https://github.com/${REPO}/releases/download/${fromTag}/trace-mcp.Setup.${fromVersion}.exe`,
    oldSetup,
  );
  const before = await installAndWaitFor(oldSetup, ['/S'], fromVersion);
  if (before !== fromVersion) {
    die(`installed ${fromTag} but the app reports ${before ?? 'nothing'} at ${APP_EXE}`);
  }
  console.log(`Installed ${fromVersion}.`);

  // 2. The feed, from the URL electron-updater builds for the github provider.
  // A 404 here IS the bug this check exists for.
  const feedUrl = `https://github.com/${REPO}/releases/latest/download/latest.yml`;
  const feedText = await (await get(feedUrl)).text();
  console.log(`--- ${feedUrl}\n${feedText}`);
  const feed = readFeed(feedText);
  if (!isNewer(feed.version, fromVersion)) {
    die(
      `latest.yml offers ${feed.version}, which is not newer than the installed ${fromVersion} — no update would ever be offered`,
    );
  }

  // 3. The artifact it names, hashed the way electron-updater hashes it before
  // it will run anything. A mismatch here is the release that installs nothing.
  const newSetup = path.join(tmp, feed.file);
  const buf = await download(
    `https://github.com/${REPO}/releases/latest/download/${feed.file}`,
    newSetup,
  );
  const actual = createHash('sha512').update(buf).digest('base64');
  if (actual !== feed.sha512) {
    die(`sha512 mismatch for ${feed.file}\n  latest.yml: ${feed.sha512}\n  downloaded: ${actual}`);
  }
  console.log(`${feed.file} matches the sha512 in latest.yml.`);

  // 4. The swap, with the flags electron-updater's NSIS path passes.
  const after = await installAndWaitFor(newSetup, ['/S', '--updated'], feed.version);
  if (after !== feed.version) {
    die(`update did not take: expected ${feed.version} at ${APP_EXE}, found ${after ?? 'nothing'}`);
  }

  console.log(`OK: ${fromVersion} -> ${after} on a real Windows install, no npm involved.`);
}

// Importing this module (the tests do) must not run the install.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
