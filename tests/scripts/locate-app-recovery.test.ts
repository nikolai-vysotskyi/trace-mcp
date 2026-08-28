import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MODULE_PATH = path.join(REPO_ROOT, 'scripts', 'locate-app.mjs');

const BUNDLE_ID = 'com.trace-mcp.app';

function createBundleAt(appPath: string, bundleId: string = BUNDLE_ID): string {
  const contents = path.join(appPath, 'Contents');
  fs.mkdirSync(contents, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
</dict>
</plist>
`;
  fs.writeFileSync(path.join(contents, 'Info.plist'), plist);
  return appPath;
}

function runRecover(opts: {
  homeDir: string;
  fallbackDirs: string[];
  platform?: NodeJS.Platform;
}): Array<{ action: string; path: string }> {
  const harness = `
import { recoverInterruptedSwap } from ${JSON.stringify(MODULE_PATH)};
const opts = JSON.parse(process.argv[2]);
process.stdout.write(JSON.stringify(recoverInterruptedSwap(opts)));
`;
  const harnessPath = path.join(opts.homeDir, 'recover-harness.mjs');
  fs.writeFileSync(harnessPath, harness);
  const stdout = execFileSync(process.execPath, [harnessPath, JSON.stringify(opts)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 15_000,
  });
  return JSON.parse(stdout);
}

function runLocate(opts: {
  homeDir: string;
  fallbackDirs: string[];
  platform?: NodeJS.Platform;
}): { appPath: string; source: string } | null {
  const harness = `
import { locateInstalledApp } from ${JSON.stringify(MODULE_PATH)};
const opts = JSON.parse(process.argv[2]);
// Neutralise Spotlight so the test only sees the fixture directories.
opts.mdfindBin = '/nonexistent/mdfind';
process.stdout.write(JSON.stringify(locateInstalledApp(opts)));
`;
  const harnessPath = path.join(opts.homeDir, 'locate-harness.mjs');
  fs.writeFileSync(harnessPath, harness);
  const stdout = execFileSync(process.execPath, [harnessPath, JSON.stringify(opts)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 15_000,
  });
  return JSON.parse(stdout);
}

// The recovery helper reads .app bundle layouts; it is a no-op on Windows and
// the fixtures below assume POSIX rename semantics, so skip on win32 hosts.
describe.skipIf(process.platform === 'win32')('recoverInterruptedSwap', () => {
  let home: string;
  let installDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-recover-'));
    installDir = path.join(home, 'Applications');
    fs.mkdirSync(installDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('restores the backup when the swap was interrupted after the first rename', () => {
    // The exact on-disk state left behind when the machine reboots between
    // `rename(app -> app.bak-PID)` and `rename(staged -> app)`.
    const appPath = path.join(installDir, 'trace-mcp.app');
    createBundleAt(`${appPath}.bak-4242`);

    const actions = runRecover({ homeDir: home, fallbackDirs: [installDir], platform: 'darwin' });

    expect(actions).toEqual([{ action: 'restored', path: appPath }]);
    expect(fs.existsSync(path.join(appPath, 'Contents', 'Info.plist'))).toBe(true);
    expect(fs.existsSync(`${appPath}.bak-4242`)).toBe(false);
  });

  it('reclaims a leftover backup when the live bundle is already in place', () => {
    const appPath = path.join(installDir, 'trace-mcp.app');
    createBundleAt(appPath);
    createBundleAt(`${appPath}.bak-99`);

    const actions = runRecover({ homeDir: home, fallbackDirs: [installDir], platform: 'darwin' });

    expect(actions).toEqual([{ action: 'reclaimed', path: `${appPath}.bak-99` }]);
    expect(fs.existsSync(`${appPath}.bak-99`)).toBe(false);
    // The live bundle must be untouched.
    expect(fs.existsSync(path.join(appPath, 'Contents', 'Info.plist'))).toBe(true);
  });

  it('leaves a backup that is not a real bundle alone', () => {
    const appPath = path.join(installDir, 'trace-mcp.app');
    fs.mkdirSync(`${appPath}.bak-7`, { recursive: true });

    const actions = runRecover({ homeDir: home, fallbackDirs: [installDir], platform: 'darwin' });

    expect(actions).toEqual([]);
    expect(fs.existsSync(`${appPath}.bak-7`)).toBe(true);
    expect(fs.existsSync(appPath)).toBe(false);
  });

  it('ignores directories that only look like our backups', () => {
    const appPath = path.join(installDir, 'trace-mcp.app');
    createBundleAt(path.join(installDir, 'trace-mcp.app.backup'));
    createBundleAt(path.join(installDir, 'trace-mcp.app.bak-old'));

    const actions = runRecover({ homeDir: home, fallbackDirs: [installDir], platform: 'darwin' });

    expect(actions).toEqual([]);
    expect(fs.existsSync(path.join(installDir, 'trace-mcp.app.backup'))).toBe(true);
    expect(fs.existsSync(path.join(installDir, 'trace-mcp.app.bak-old'))).toBe(true);
    expect(fs.existsSync(appPath)).toBe(false);
  });

  it('recovers in the marker directory even when it is not a conventional install dir', () => {
    const markerDir = path.join(home, 'custom-apps');
    fs.mkdirSync(markerDir, { recursive: true });
    const appPath = path.join(markerDir, 'trace-mcp.app');
    createBundleAt(`${appPath}.bak-11`);
    fs.mkdirSync(path.join(home, '.trace-mcp'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.trace-mcp', 'app-location.json'),
      JSON.stringify({ appPath, bundleId: BUNDLE_ID, writtenAt: Date.now() }),
    );

    const actions = runRecover({ homeDir: home, fallbackDirs: [installDir], platform: 'darwin' });

    expect(actions).toEqual([{ action: 'restored', path: appPath }]);
    expect(fs.existsSync(path.join(appPath, 'Contents', 'Info.plist'))).toBe(true);
  });

  it('turns a bricked install back into one locateInstalledApp can resolve', () => {
    // Regression guard for the actual user-visible symptom: with only the
    // .bak- directory on disk, resolution fails and every caller aborts.
    const appPath = path.join(installDir, 'trace-mcp.app');
    createBundleAt(`${appPath}.bak-4242`);
    const opts = { homeDir: home, fallbackDirs: [installDir], platform: 'darwin' as const };

    expect(runLocate(opts)).toBeNull();
    runRecover(opts);
    expect(runLocate(opts)?.appPath).toBe(appPath);
  });

  it('is a no-op on non-darwin platforms', () => {
    const appPath = path.join(installDir, 'trace-mcp.app');
    createBundleAt(`${appPath}.bak-1`);

    const actions = runRecover({ homeDir: home, fallbackDirs: [installDir], platform: 'linux' });

    expect(actions).toEqual([]);
    expect(fs.existsSync(`${appPath}.bak-1`)).toBe(true);
  });
});
