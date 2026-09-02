import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'postinstall-app.mjs');

const BUNDLE_ID = 'com.trace-mcp.app';
const DIST_REPO = 'trace-mcp-test/dist';

/**
 * End-to-end coverage for `npm install -g trace-mcp` → the installed `.app`
 * actually moving to the new version.
 *
 * This is deliberately not a unit test of the helpers. The incident that
 * motivated it (TRA-357: bundle stuck on 1.50.0 for five consecutive updates
 * while npm walked to 3.1.1) was invisible to code review — every helper read
 * correctly. Only running the real script against a real bundle on disk and
 * then reading the version back out of `Info.plist` catches it.
 *
 * The release API and the zip come from a local HTTP server, so the test is
 * hermetic and fast; everything else — unzip, the rename swap, the pending
 * staging, the checksum gate — is the production code path.
 *
 * macOS only: the script exits early on other platforms by design.
 */

interface Fixture {
  home: string;
  installDir: string;
  appPath: string;
  server: http.Server;
  baseUrl: string;
  /** Asset name → body served under /dl/<name>. */
  assets: Map<string, Buffer>;
  releaseBody: unknown;
}

/**
 * @param selfUpdating  Omits the apply-pending helper from `Contents/Resources`,
 *   which is how the postinstall recognises a build that owns its own updates
 *   and must not be touched from outside (TRA-437). Defaults to a legacy bundle
 *   because that is what every swap test here is about.
 */
function writeBundle(appPath: string, version: string, selfUpdating = false): void {
  const contents = path.join(appPath, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  if (!selfUpdating) {
    fs.mkdirSync(path.join(contents, 'Resources', 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(contents, 'Resources', 'scripts', 'apply-pending-update.mjs'),
      '// legacy staged-swap helper\n',
    );
  }
  fs.writeFileSync(
    path.join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict>
</plist>
`,
  );
  fs.writeFileSync(path.join(contents, 'MacOS', 'trace-mcp'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
}

function readBundleVersion(appPath: string): string {
  const plist = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf-8');
  return (
    plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? ''
  );
}

/** Zip a bundle the way the release CI does: `trace-mcp.app` at the zip root. */
function zipBundle(appPath: string, outZip: string): Buffer {
  execFileSync('/usr/bin/zip', ['-qry', outZip, path.basename(appPath)], {
    cwd: path.dirname(appPath),
  });
  return fs.readFileSync(outZip);
}

/** A stub standing in for `/usr/bin/pgrep`, forcing the running/not-running branch. */
function writePgrepStub(dir: string, running: boolean): string {
  const stub = path.join(dir, 'pgrep-stub.sh');
  // pgrep exits 1 with no output when nothing matches — mirror that exactly.
  fs.writeFileSync(stub, running ? '#!/bin/sh\necho 4242\n' : '#!/bin/sh\nexit 1\n', {
    mode: 0o755,
  });
  return stub;
}

/**
 * A pgrep stub that answers "not running" until its `runningFromCall`-th
 * invocation and "running" from then on — the user launching the app midway
 * through a multi-bundle sweep.
 */
function writeFlippingPgrepStub(dir: string, runningFromCall: number): string {
  const stub = path.join(dir, 'pgrep-flip-stub.sh');
  const counter = path.join(dir, 'pgrep-calls');
  fs.rmSync(counter, { force: true });
  fs.writeFileSync(
    stub,
    `#!/bin/sh
n=$(cat '${counter}' 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > '${counter}'
[ "$n" -ge ${runningFromCall} ] && { echo 4242; exit 0; }
exit 1
`,
    { mode: 0o755 },
  );
  return stub;
}

/** A stub for `/bin/ps -p <pid> -o comm=`, reporting `appPath`'s main binary. */
function writePsStub(dir: string, appPath: string): string {
  const stub = path.join(dir, 'ps-stub.sh');
  fs.writeFileSync(
    stub,
    `#!/bin/sh\necho '${path.join(appPath, 'Contents', 'MacOS', 'trace-mcp')}'\n`,
    {
      mode: 0o755,
    },
  );
  return stub;
}

describe.skipIf(process.platform !== 'darwin')('postinstall-app.mjs bundle swap', () => {
  let fx: Fixture;
  let tmp: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-postinstall-'));
    const home = path.join(tmp, 'home');
    const installDir = path.join(home, 'Applications');
    fs.mkdirSync(path.join(home, '.trace-mcp'), { recursive: true });
    fs.mkdirSync(installDir, { recursive: true });

    const assets = new Map<string, Buffer>();
    const server = http.createServer((req, res) => {
      const url = req.url ?? '';
      if (url === `/repos/${DIST_REPO}/releases/latest`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(fx.releaseBody));
        return;
      }
      const name = decodeURIComponent(url.replace(/^\/dl\//, ''));
      const body = assets.get(name);
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;

    fx = {
      home,
      installDir,
      appPath: path.join(installDir, 'trace-mcp.app'),
      server,
      baseUrl: `http://127.0.0.1:${port}`,
      assets,
      releaseBody: {},
    };
  });

  afterEach(async () => {
    await new Promise<void>((r) => fx.server.close(() => r()));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Publish a fake release whose macOS zip contains a bundle at `newVersion`.
   * `corruptChecksum` serves a digest that will not match the zip;
   * `omitChecksum` drops the `.sha256` sibling entirely.
   */
  function publishRelease(
    newVersion: string,
    opts: { corruptChecksum?: boolean; omitChecksum?: boolean } = {},
  ): void {
    const staging = path.join(tmp, `staging-${newVersion}`);
    fs.mkdirSync(staging, { recursive: true });
    const newBundle = path.join(staging, 'trace-mcp.app');
    writeBundle(newBundle, newVersion);

    // Both arch names so the test runs on Intel and Apple silicon alike; only
    // the one matching process.arch is picked up by the script.
    const zipName =
      process.arch === 'arm64'
        ? `trace-mcp-${newVersion}-arm64-mac.zip`
        : `trace-mcp-${newVersion}-mac.zip`;
    const zipBytes = zipBundle(newBundle, path.join(tmp, zipName));
    fx.assets.set(zipName, zipBytes);

    const assets: Array<{ name: string; browser_download_url: string }> = [
      { name: zipName, browser_download_url: `${fx.baseUrl}/dl/${zipName}` },
    ];
    if (!opts.omitChecksum) {
      const digest = opts.corruptChecksum
        ? 'f'.repeat(64)
        : crypto.createHash('sha256').update(zipBytes).digest('hex');
      fx.assets.set(`${zipName}.sha256`, Buffer.from(`${digest}  ${zipName}\n`));
      assets.push({
        name: `${zipName}.sha256`,
        browser_download_url: `${fx.baseUrl}/dl/${zipName}.sha256`,
      });
    }
    fx.releaseBody = { tag_name: `v${newVersion}`, assets };
  }

  /** Install a bundle at `version` and point the location marker at it. */
  function installBundle(version: string): void {
    writeBundle(fx.appPath, version);
    fs.writeFileSync(
      path.join(fx.home, '.trace-mcp', 'app-location.json'),
      JSON.stringify({ appPath: fx.appPath, bundleId: BUNDLE_ID, version, writtenAt: Date.now() }),
    );
  }

  /**
   * Must be async: the fake release server lives in this process, so a
   * synchronous execFileSync would block the event loop and deadlock against
   * the child's own HTTP request.
   */
  function runPostinstall(
    opts: {
      appRunning?: boolean;
      appRunningEnv?: boolean;
      runningBundle?: string;
      pgrepRunningFromCall?: number;
    } = {},
  ): Promise<string> {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        HOME: fx.home,
        TRACE_MCP_APP_DIST_REPO: DIST_REPO,
        TRACE_MCP_UPDATE_API_BASE: fx.baseUrl,
        TRACE_MCP_APP_RUNNING: opts.appRunningEnv ? '1' : '',
        TRACE_MCP_PGREP_BIN: opts.pgrepRunningFromCall
          ? writeFlippingPgrepStub(tmp, opts.pgrepRunningFromCall)
          : writePgrepStub(tmp, opts.appRunning ?? false),
        // Left at a binary that reports no such pid unless a test names the
        // bundle it wants "running"; that keeps every other case on the
        // marker-resolved path they were written against.
        TRACE_MCP_PS_BIN: opts.runningBundle
          ? writePsStub(tmp, opts.runningBundle)
          : '/usr/bin/false',
        // Silence Spotlight queries so tests never resolve bundles on the host.
        TRACE_MCP_MDFIND_BIN: '/usr/bin/false',
        // Confine the orphan-staging sweep to this fixture. Without it the
        // script would reach into the real /Applications of whatever machine
        // runs the suite.
        TRACE_MCP_APP_DIRS: [fx.installDir, path.join(tmp, 'Applications')].join(':'),
        // Never bounce the developer's real launchd daemon from a test run.
        TRACE_MCP_LAUNCHCTL_BIN: '/usr/bin/true',
        TRACE_MCP_NO_AUTO_UPDATE: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    return new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', () => resolve(stdout));
    });
  }

  /* TRA-437. This hook is now the bridge off the old updater and nothing else:
     a build that owns its own updates via electron-updater must never have its
     bundle written from outside, or the two mechanisms race over the same
     `.app` — the failure the rewrite existed to make impossible. */
  describe('electron-updater bundles', () => {
    it('leaves a self-updating bundle alone even when it is behind', async () => {
      writeBundle(fx.appPath, '3.3.0', true);
      publishRelease('3.9.0');

      const stdout = await runPostinstall();

      expect(readBundleVersion(fx.appPath)).toBe('3.3.0');
      expect(stdout).toContain('updates itself');
      // Not staged either: staging is the other half of the swap, and the app
      // that would apply it no longer exists.
      expect(fs.existsSync(path.join(fx.installDir, '.trace-mcp-pending.zip'))).toBe(false);
    });

    it('reclaims staging left beside a bundle that has finished migrating', async () => {
      writeBundle(fx.appPath, '3.9.0', true);
      for (const [name, body] of [
        ['.trace-mcp-pending.zip', 'leftover'],
        ['.trace-mcp-pending.sha256', 'f'.repeat(64)],
        ['.trace-mcp-pending-version', '3.5.2'],
      ] as const) {
        fs.writeFileSync(path.join(fx.installDir, name), body);
      }
      publishRelease('3.9.0');

      await runPostinstall();

      for (const name of [
        '.trace-mcp-pending.zip',
        '.trace-mcp-pending.sha256',
        '.trace-mcp-pending-version',
      ]) {
        expect(fs.existsSync(path.join(fx.installDir, name))).toBe(false);
      }
    });

    /* The staged-zip updater's state file. Nothing reads it any more, but a
       stale "stuck on 3.3.0" marker on an upgrading user's disk must not be
       able to influence anything ever again — so it is removed, not orphaned. */
    it('deletes the old app-update-state.json', async () => {
      const statePath = path.join(fx.home, '.trace-mcp', 'app-update-state.json');
      fs.writeFileSync(
        statePath,
        JSON.stringify({ lastNpmOnlyAttempt: { bundle: '3.3.0', target: '3.9.0', at: 1 } }),
      );
      writeBundle(fx.appPath, '3.9.0', true);
      publishRelease('3.9.0');

      await runPostinstall();

      expect(fs.existsSync(statePath)).toBe(false);
    });
  });

  it('replaces a bundle that is several majors behind', async () => {
    // The exact shape of the incident: installed 1.50.0, released 3.1.1.
    installBundle('1.50.0');
    publishRelease('3.1.1');

    const stdout = await runPostinstall();

    expect(readBundleVersion(fx.appPath)).toBe('3.1.1');
    expect(stdout).toContain('updated to v3.1.1');
    expect(fs.readFileSync(path.join(fx.installDir, '.trace-mcp-version'), 'utf-8')).toBe('v3.1.1');
    // No half-finished swap left behind.
    expect(fs.readdirSync(fx.installDir).filter((f) => f.includes('.bak-'))).toEqual([]);
  });

  /* TRA-506: one machine, two installed bundles — one dragged into
     /Applications, one re-installed into ~/Applications. The location marker
     named the second, the user was running the first, and postinstall staged
     the pending zip beside the bundle nobody had open. The running copy never
     offered "restart to install" and sat two releases behind while every npm
     install reported success; the orphan zip (110 MB) was never applied and
     never reclaimed, because both appliers only look beside the bundle they
     resolved themselves. Electron main targets `process.execPath`, so the
     running bundle is the one postinstall has to agree with. */
  it('targets the running bundle over the marker and reclaims the orphan staging', async () => {
    // Marker + fx.appPath point at the ~/Applications copy...
    installBundle('3.4.0');
    // ...but the user is running the one in the system-wide directory.
    const systemDir = path.join(tmp, 'Applications');
    fs.mkdirSync(systemDir, { recursive: true });
    const systemApp = path.join(systemDir, 'trace-mcp.app');
    writeBundle(systemApp, '3.3.0');

    // A previous run staged 3.5.2 next to the marker's bundle; nothing can
    // ever apply it there once the running copy is the target.
    for (const [name, body] of [
      ['.trace-mcp-pending.zip', 'orphan'],
      ['.trace-mcp-pending.sha256', 'f'.repeat(64)],
      ['.trace-mcp-pending-version', '3.5.2'],
    ] as const) {
      fs.writeFileSync(path.join(fx.installDir, name), body);
    }

    publishRelease('3.5.2');

    const stdout = await runPostinstall({ appRunning: true, runningBundle: systemApp });

    expect(stdout).toContain(systemApp);
    // Staged beside the bundle the user actually has open.
    expect(fs.existsSync(path.join(systemDir, '.trace-mcp-pending.zip'))).toBe(true);
    expect(fs.readFileSync(path.join(systemDir, '.trace-mcp-pending-version'), 'utf-8')).toBe(
      '3.5.2',
    );
    // The other copy is not running, so it is updated directly in place
    // rather than left holding corrupt leftover staging: bundle moved to 3.5.2,
    // and the old orphan staging files are cleaned up.
    expect(readBundleVersion(fx.appPath)).toBe('3.5.2');
    expect(fs.existsSync(path.join(fx.installDir, '.trace-mcp-pending.zip'))).toBe(false);
    expect(fs.existsSync(path.join(fx.installDir, '.trace-mcp-pending.sha256'))).toBe(false);
    expect(fs.existsSync(path.join(fx.installDir, '.trace-mcp-pending-version'))).toBe(false);
  });

  /* Found on the founder's machine: `/Applications/trace-mcp.app` sat on 3.3.0
     while `~/Applications/trace-mcp.app` tracked 3.6.0. A bundle that is never
     launched never writes the location marker, so nothing ever resolves to it
     and nothing ever updates it — it stays behind forever while every
     `npm install -g` reports success. One download, applied to every install. */
  it('updates every installed bundle, not just the resolved one', async () => {
    installBundle('3.4.0');
    const systemDir = path.join(tmp, 'Applications');
    fs.mkdirSync(systemDir, { recursive: true });
    const systemApp = path.join(systemDir, 'trace-mcp.app');
    writeBundle(systemApp, '3.3.0');

    publishRelease('3.5.2');

    const stdout = await runPostinstall();

    expect(readBundleVersion(fx.appPath)).toBe('3.5.2');
    expect(readBundleVersion(systemApp)).toBe('3.5.2');
    expect(stdout).toContain('2 legacy bundles');
    // Each swap records its own version marker, and leaves no backup behind.
    expect(fs.readFileSync(path.join(systemDir, '.trace-mcp-version'), 'utf-8')).toBe('v3.5.2');
    expect(fs.readdirSync(systemDir).filter((f) => f.includes('.bak-'))).toEqual([]);
  });

  /* TRA-555: swapping a ~100 MB bundle takes seconds, so the user can launch
     the app while the sweep is between bundles. A single hoisted "is it
     running" answer would then swap a live bundle out from under a running
     process — TRA-431, once per install. pgrep here says "not running" for the
     first bundle and "running" for the second. */
  it('re-checks whether the app is running between bundles', async () => {
    installBundle('3.4.0');
    const systemDir = path.join(tmp, 'Applications');
    fs.mkdirSync(systemDir, { recursive: true });
    const systemApp = path.join(systemDir, 'trace-mcp.app');
    writeBundle(systemApp, '3.3.0');

    publishRelease('3.5.2');

    // Call 1 is the startup runningBundlePath() probe, calls 2 and 3 are the
    // per-bundle checks — so the app "launches" just before the second swap.
    await runPostinstall({ pgrepRunningFromCall: 3 });

    expect(readBundleVersion(fx.appPath)).toBe('3.5.2');
    // Second bundle was left alone and got a staged update instead.
    expect(readBundleVersion(systemApp)).toBe('3.3.0');
    expect(fs.readFileSync(path.join(systemDir, '.trace-mcp-pending-version'), 'utf-8')).toBe(
      '3.5.2',
    );
  });

  it('leaves an already-current sibling bundle untouched', async () => {
    installBundle('3.4.0');
    const systemDir = path.join(tmp, 'Applications');
    fs.mkdirSync(systemDir, { recursive: true });
    const systemApp = path.join(systemDir, 'trace-mcp.app');
    writeBundle(systemApp, '3.5.2');
    const before = fs.statSync(systemApp).mtimeMs;

    publishRelease('3.5.2');
    await runPostinstall();

    expect(readBundleVersion(fx.appPath)).toBe('3.5.2');
    expect(fs.statSync(systemApp).mtimeMs).toBe(before);
  });

  /* The state this was found in: marker and running app agreed on
     ~/Applications, while a complete 112 MB staging for the current release sat
     beside a /Applications copy left over from an earlier drag-install. Neither
     applier looks there, so it was permanent. */
  it('reclaims staging left in a conventional dir that is not the target', async () => {
    installBundle('3.4.0');
    const otherDir = path.join(tmp, 'Applications');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, '.trace-mcp-pending.zip'), 'orphan');
    fs.writeFileSync(path.join(otherDir, '.trace-mcp-pending-version'), '3.5.2');
    publishRelease('3.5.2');

    await runPostinstall();

    expect(readBundleVersion(fx.appPath)).toBe('3.5.2');
    expect(fs.existsSync(path.join(otherDir, '.trace-mcp-pending.zip'))).toBe(false);
    expect(fs.existsSync(path.join(otherDir, '.trace-mcp-pending-version'))).toBe(false);
  });

  it('stages a pending zip instead of swapping while the app is running', async () => {
    installBundle('1.50.0');
    publishRelease('3.1.1');

    await runPostinstall({ appRunning: true });

    // Bundle untouched — replacing a running .app breaks its code signature.
    expect(readBundleVersion(fx.appPath)).toBe('1.50.0');
    expect(fs.existsSync(path.join(fx.installDir, '.trace-mcp-pending.zip'))).toBe(true);
    expect(fs.readFileSync(path.join(fx.installDir, '.trace-mcp-pending-version'), 'utf-8')).toBe(
      '3.1.1',
    );
    expect(fs.existsSync(path.join(fx.installDir, '.trace-mcp-pending.partial'))).toBe(false);
  });

  /* TRA-431: the app clicked Update, pgrep answered "not running" while the app
     was the very process driving the install, and this script renamed the live
     bundle aside and moved 3.3.0 into its place. The in-app path no longer
     depends on that guess — the app sets TRACE_MCP_APP_RUNNING itself — so the
     pgrep stub here says "not running" deliberately: the env signal must win. */
  it('stages instead of swapping when the app says it is running, even if pgrep disagrees', async () => {
    installBundle('3.2.0');
    publishRelease('3.3.0');

    await runPostinstall({ appRunning: false, appRunningEnv: true });

    expect(readBundleVersion(fx.appPath)).toBe('3.2.0');
    expect(fs.existsSync(path.join(fx.installDir, '.trace-mcp-pending.zip'))).toBe(true);
    expect(fs.readFileSync(path.join(fx.installDir, '.trace-mcp-pending-version'), 'utf-8')).toBe(
      '3.3.0',
    );
    // The version marker only moves on a real swap; a stale one is what made
    // the repair rerun a silent no-op.
    expect(fs.existsSync(path.join(fx.installDir, '.trace-mcp-version'))).toBe(false);
  });

  it('leaves the install alone when the checksum does not match', async () => {
    installBundle('1.50.0');
    publishRelease('3.1.1', { corruptChecksum: true });

    await runPostinstall();

    expect(readBundleVersion(fx.appPath)).toBe('1.50.0');
    expect(fs.existsSync(path.join(fx.installDir, '.trace-mcp-version'))).toBe(false);
  });

  it('leaves the install alone when the release ships no .sha256 asset', async () => {
    installBundle('1.50.0');
    publishRelease('3.1.1', { omitChecksum: true });

    await runPostinstall();

    expect(readBundleVersion(fx.appPath)).toBe('1.50.0');
  });

  it('is a no-op once the installed version marker matches the release', async () => {
    installBundle('3.1.1');
    publishRelease('3.1.1');
    fs.writeFileSync(path.join(fx.installDir, '.trace-mcp-version'), 'v3.1.1');

    const before = fs.statSync(fx.appPath).mtimeMs;
    const stdout = await runPostinstall();

    expect(fs.statSync(fx.appPath).mtimeMs).toBe(before);
    expect(stdout).not.toContain('updated to');
  });

  // The marker has two writers that disagree on format: this script writes
  // `tag_name` ("v3.1.1"), apply-pending-update.mjs writes the normalized
  // pending version ("3.1.1"). The test above only ever covered the first
  // form, so the mismatch was invisible: after any GUI-applied update every
  // later install re-downloaded the whole zip and re-staged a version already
  // installed, leaving a "restart to install" banner that never cleared.
  it('is a no-op when the marker was written by the GUI apply path (no leading v)', async () => {
    installBundle('3.1.1');
    publishRelease('3.1.1');
    fs.writeFileSync(path.join(fx.installDir, '.trace-mcp-version'), '3.1.1');

    const before = fs.statSync(fx.appPath).mtimeMs;
    const stdout = await runPostinstall();

    expect(fs.statSync(fx.appPath).mtimeMs).toBe(before);
    expect(stdout).not.toContain('updated to');
  });

  /* TRA-443: the marker file only records what the last swap intended. Replace
     the bundle out-of-band — drag an older .app in, restore one from a backup —
     and the marker runs ahead of what is installed. Gating on it alone made
     this script exit 0 silently on every later install while the app, which
     reads Info.plist, kept offering an update that could never land. */
  it('updates a bundle whose version marker runs ahead of the real bundle', async () => {
    installBundle('3.1.1');
    publishRelease('3.3.0');
    fs.writeFileSync(path.join(fx.installDir, '.trace-mcp-version'), 'v3.3.0');

    const stdout = await runPostinstall();

    expect(readBundleVersion(fx.appPath)).toBe('3.3.0');
    expect(stdout).toContain('updated to v3.3.0');
  });

  it('does not stage a phantom pending update for the running version', async () => {
    installBundle('3.1.1');
    publishRelease('3.1.1');
    fs.writeFileSync(path.join(fx.installDir, '.trace-mcp-version'), '3.1.1');

    await runPostinstall({ appRunning: true });

    expect(fs.existsSync(path.join(fx.installDir, '.trace-mcp-pending.zip'))).toBe(false);
    expect(fs.existsSync(path.join(fx.installDir, '.trace-mcp-pending-version'))).toBe(false);
  });
});
