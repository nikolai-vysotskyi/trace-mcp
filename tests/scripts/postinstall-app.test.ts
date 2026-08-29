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

function writeBundle(appPath: string, version: string): void {
  const contents = path.join(appPath, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
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
    opts: { appRunning?: boolean; appRunningEnv?: boolean } = {},
  ): Promise<string> {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        HOME: fx.home,
        TRACE_MCP_APP_DIST_REPO: DIST_REPO,
        TRACE_MCP_UPDATE_API_BASE: fx.baseUrl,
        TRACE_MCP_APP_RUNNING: opts.appRunningEnv ? '1' : '',
        TRACE_MCP_PGREP_BIN: writePgrepStub(tmp, opts.appRunning ?? false),
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

  it('does not stage a phantom pending update for the running version', async () => {
    installBundle('3.1.1');
    publishRelease('3.1.1');
    fs.writeFileSync(path.join(fx.installDir, '.trace-mcp-version'), '3.1.1');

    await runPostinstall({ appRunning: true });

    expect(fs.existsSync(path.join(fx.installDir, '.trace-mcp-pending.zip'))).toBe(false);
    expect(fs.existsSync(path.join(fx.installDir, '.trace-mcp-pending-version'))).toBe(false);
  });
});
