#!/usr/bin/env node

/**
 * Does an old install actually reach the current version?
 *
 * Everything else that guards the updater asserts against a mock: the GitHub
 * API is stubbed, the "bundle" is a fixture directory. That is what let TRA-357
 * through — the code read correctly and shipped, and five real upgrades in a row
 * ended `npm-only` while the app kept showing "Up to date". A silent update
 * failure produces no complaint, so it has to be caught by running the real
 * thing, not by reading it.
 *
 * So this downloads a real published release, installs it as a real `.app`, runs
 * the real postinstall hook against it, and asserts the bundle on disk moved to
 * this checkout's version and still passes Gatekeeper.
 *
 * Manual / autopilot only — not wired into CI. It downloads two ~110 MB zips per
 * run, which is not a per-PR cost worth paying; the Update Health autopilot runs
 * it and records the starting version it covered.
 *
 *   node scripts/verify-upgrade-path.mjs                # 10 releases back
 *   node scripts/verify-upgrade-path.mjs --from v1.50.0 # a specific one
 *   node scripts/verify-upgrade-path.mjs --arch x64
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { traceHomeDir } from './trace-home.mjs';

const REPO = 'nikolai-vysotskyi/trace-mcp';
const BUNDLE_ID = 'com.trace-mcp.app';

if (process.platform !== 'darwin') {
  console.log('skip: macOS only');
  process.exit(0);
}

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const arch = argOf('--arch') ?? 'arm64';
const zipSuffix = arch === 'arm64' ? '-arm64-mac.zip' : '-mac.zip';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const expected = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')).version;

const gh = (...a) => {
  try {
    return execFileSync('gh', a, { encoding: 'utf-8', maxBuffer: 32 << 20 });
  } catch (err) {
    return null;
  }
};

async function resolveFromRelease() {
  const fromArg = argOf('--from');
  if (fromArg) return fromArg;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, {
      headers: { 'User-Agent': 'trace-mcp' },
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        return data[data.length - 1].tag_name;
      }
    }
  } catch {}
  const ghOut = gh(
    'release',
    'list',
    '--repo',
    REPO,
    '--limit',
    '10',
    '--json',
    'tagName',
    '--jq',
    '.[-1].tagName',
  );
  if (ghOut) return ghOut.trim();
  throw new Error('Could not resolve past releases via GitHub API or gh CLI');
}

async function downloadReleaseZip(tag, suffix, destDir) {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, {
      headers: { 'User-Agent': 'trace-mcp' },
    });
    if (res.ok) {
      const release = await res.json();
      const asset = release.assets?.find((a) => a.name.endsWith(suffix));
      if (!asset) throw new Error(`${tag} publishes no ${suffix} asset`);
      const dl = await fetch(asset.browser_download_url, {
        headers: { 'User-Agent': 'trace-mcp' },
      });
      if (!dl.ok) throw new Error(`HTTP ${dl.status} downloading ${asset.name}`);
      const buffer = await dl.arrayBuffer();
      const zipFile = path.join(destDir, asset.name);
      fs.writeFileSync(zipFile, Buffer.from(buffer));
      return;
    }
  } catch (err) {
    if (err.message?.includes('publishes no')) throw err;
  }
  const ghRes = gh(
    'release',
    'download',
    tag,
    '--repo',
    REPO,
    '--pattern',
    `*${suffix}`,
    '--dir',
    destDir,
  );
  if (ghRes === null) {
    throw new Error(`Failed to download ${tag} asset matching *${suffix}`);
  }
}

async function run() {
  const from = await resolveFromRelease();
  console.log(`upgrade path: ${from} (${arch}) -> ${expected}`);

  // `/private/tmp`, not `/tmp`: locate-app.mjs rejects install paths under a
  // `workdir`/`build`/... segment as local builds, and the applier's own
  // is-this-the-entrypoint check compares argv[1] against a realpath'd
  // import.meta.url. A symlinked or implausible sandbox makes this script pass
  // while testing nothing.
  const sandbox = fs.mkdtempSync(path.join('/private/tmp', 'trace-mcp-upgrade-'));
  const apps = path.join(sandbox, 'Applications');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(apps);
  // The post-rename layout (TRA-611) is what a current machine has, so that is
  // what the postinstall run below has to be exercised against.
  fs.mkdirSync(path.join(home, '.trace'), { recursive: true });

  // ponytail: a stub that reports "nothing running" rather than a fake process
  // tree. pgrep answers for the whole machine, so without this the developer's own
  // running copy becomes the update target — the postinstall would report success
  // having swapped a bundle this script never created.
  const pgrepStub = path.join(sandbox, 'pgrep-none');
  fs.writeFileSync(pgrepStub, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(pgrepStub, 0o755);

  // postinstall-app.mjs unconditionally runs `launchctl stop com.trace-mcp.server`
  // before it resolves which bundle to touch — on the machine that runs this
  // script for real (the Update Health autopilot, a developer's own Mac), that
  // is the real running daemon, not the sandboxed one this script creates.
  // launchd's KeepAlive respawns it, so nothing stays broken, but a
  // verification script has no business bouncing production state as a side
  // effect. Same no-op-binary pattern as the pgrep stub above.
  const launchctlStub = path.join(sandbox, 'launchctl-noop');
  fs.writeFileSync(launchctlStub, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(launchctlStub, 0o755);

  let failure = null;
  try {
    await downloadReleaseZip(from, zipSuffix, sandbox);
    const zip = fs.readdirSync(sandbox).find((n) => n.endsWith(zipSuffix));
    if (!zip) throw new Error(`${from} publishes no ${zipSuffix} asset`);
    execFileSync('/usr/bin/ditto', ['-x', '-k', path.join(sandbox, zip), apps]);

    const appPath = path.join(apps, 'trace-mcp.app');
    const versionOf = (p) =>
      execFileSync(
        '/usr/libexec/PlistBuddy',
        ['-c', 'Print :CFBundleShortVersionString', path.join(p, 'Contents', 'Info.plist')],
        { encoding: 'utf-8' },
      ).trim();

    const before = versionOf(appPath);
    if (before === expected) throw new Error(`${from} is already ${expected} — nothing to verify`);
    console.log(`  installed ${before}`);

    fs.writeFileSync(
      path.join(traceHomeDir(home), 'app-location.json'),
      JSON.stringify({ appPath, bundleId: BUNDLE_ID, version: before, writtenAt: Date.now() }),
    );

    execFileSync('node', [path.join(repoRoot, 'scripts', 'postinstall-app.mjs')], {
      stdio: 'inherit',
      env: {
        ...process.env,
        HOME: home,
        TRACE_MCP_APP_DIRS: apps,
        TRACE_MCP_PGREP_BIN: pgrepStub,
        TRACE_MCP_LAUNCHCTL_BIN: launchctlStub,
      },
    });

    const after = versionOf(appPath);
    if (after !== expected) {
      throw new Error(`bundle is ${after}, expected ${expected} — the update did not land`);
    }
    console.log(`  bundle is now ${after}`);

    // An unsigned or broken bundle launches to a Gatekeeper refusal, which is the
    // same dead end as not updating at all.
    execFileSync('/usr/sbin/spctl', ['-a', '-t', 'exec', appPath], { stdio: 'pipe' });
    console.log('  gatekeeper: accepted');
  } catch (err) {
    failure = err;
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }

  if (failure) {
    console.error(`FAIL ${from} -> ${expected}: ${failure.message}`);
    process.exit(1);
  }
  console.log(`PASS ${from} -> ${expected}`);
}

run().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});
