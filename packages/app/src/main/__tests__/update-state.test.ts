/**
 * Global-install inspection: which npm root MCP clients actually launch from,
 * and whether it is behind. The updater-decision tests that used to live here
 * described the staged-zip updater and went with it (TRA-437).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cliPathOwnedByRoot,
  cmpSemver,
  daemonUpdateDegradeToCommand,
  evaluateDaemonUpdate,
  findStaleRoots,
  GENERIC_NPM_UPDATE_COMMAND,
  type GlobalInstall,
  readAppLocationMarker,
  readLauncherCliPath,
  runningAppBundle,
  scanAppBundles,
  scanGlobalInstalls,
  staleRootInUse,
} from '../update-state';

describe('scanGlobalInstalls', () => {
  let tmp: string;

  const makeRoot = (name: string, version?: string): string => {
    const root = path.join(tmp, name);
    if (version === undefined) {
      fs.mkdirSync(root, { recursive: true });
      return root;
    }
    const pkgDir = path.join(root, 'trace-mcp');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version }));
    return root;
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-global-roots-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reports the version in every root that has trace-mcp', () => {
    const a = makeRoot('nvm', '3.1.1');
    const b = makeRoot('hermes', '3.0.0');
    expect(scanGlobalInstalls([a, b])).toEqual([
      { root: a, version: '3.1.1' },
      { root: b, version: '3.0.0' },
    ]);
  });

  it('skips absent roots, roots without trace-mcp, and null entries', () => {
    const withPkg = makeRoot('nvm', '3.1.1');
    const empty = makeRoot('empty');
    expect(scanGlobalInstalls([withPkg, empty, path.join(tmp, 'nope'), null, undefined])).toEqual([
      { root: withPkg, version: '3.1.1' },
    ]);
  });

  it('counts a symlinked duplicate of the same install once', () => {
    const real = makeRoot('nvm', '3.1.1');
    const link = path.join(tmp, 'linked');
    fs.mkdirSync(link);
    fs.symlinkSync(path.join(real, 'trace-mcp'), path.join(link, 'trace-mcp'), 'dir');
    expect(scanGlobalInstalls([real, link])).toEqual([{ root: real, version: '3.1.1' }]);
  });

  it('skips a package whose package.json is unreadable or has no version', () => {
    const broken = makeRoot('broken', '3.1.1');
    fs.writeFileSync(path.join(broken, 'trace-mcp', 'package.json'), '{ not json');
    const versionless = makeRoot('versionless', '3.1.1');
    fs.writeFileSync(path.join(versionless, 'trace-mcp', 'package.json'), '{}');
    expect(scanGlobalInstalls([broken, versionless])).toEqual([]);
  });
});

describe('findStaleRoots', () => {
  const install = (root: string, version: string): GlobalInstall => ({ root, version });

  it('reports nothing for a single-root machine', () => {
    expect(findStaleRoots([install('/a', '3.1.1')], cmpSemver)).toEqual([]);
    expect(findStaleRoots([], cmpSemver)).toEqual([]);
  });

  it('reports nothing when every root agrees', () => {
    expect(findStaleRoots([install('/a', '3.1.1'), install('/b', '3.1.1')], cmpSemver)).toEqual([]);
  });

  it('reports every root behind the newest — the TRA-364 three-root case', () => {
    const stale = findStaleRoots(
      [install('/herd', '3.1.1'), install('/nvm', '3.1.1'), install('/hermes', '3.0.0')],
      cmpSemver,
    );
    expect(stale).toEqual([install('/hermes', '3.0.0')]);
  });

  it('measures against the newest root, not the first one seen', () => {
    const stale = findStaleRoots(
      [install('/old', '3.0.0'), install('/new', '3.1.1'), install('/older', '2.9.0')],
      cmpSemver,
    );
    expect(stale.map((s) => s.root)).toEqual(['/old', '/older']);
  });
});

/* TRA-377: the app menu's warning renders exactly when these two say it should.
   A stale root nothing resolves to is inert; the one the launcher shim points
   into means every MCP client is running the old server. */
describe('readLauncherCliPath', () => {
  let tmp: string;
  const write = (body: string): string => {
    const p = path.join(tmp, 'launcher.env');
    fs.writeFileSync(p, body);
    return p;
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-launcher-env-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads TRACE_MCP_CLI, unquoting the way the shim does', () => {
    const p = write(
      '# Managed by `trace-mcp init`\nTRACE_MCP_NODE=/n/bin/node\nTRACE_MCP_CLI="/nvm/lib/node_modules/trace-mcp/dist/cli.js"\nTRACE_MCP_VERSION=3.0.0\n',
    );
    expect(readLauncherCliPath(p)).toBe('/nvm/lib/node_modules/trace-mcp/dist/cli.js');
  });

  it('returns null when the launcher was never installed or has no CLI key', () => {
    expect(readLauncherCliPath(path.join(tmp, 'absent.env'))).toBeNull();
    expect(readLauncherCliPath(write('TRACE_MCP_NODE=/n/bin/node\n'))).toBeNull();
  });
});

describe('staleRootInUse', () => {
  let tmp: string;

  const makeRoot = (name: string, version: string): string => {
    const root = path.join(tmp, name);
    const pkgDir = path.join(root, 'trace-mcp');
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version }));
    fs.writeFileSync(path.join(pkgDir, 'dist', 'cli.js'), '');
    return root;
  };
  const cli = (root: string): string => path.join(root, 'trace-mcp', 'dist', 'cli.js');

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-in-use-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the stale root the launcher points into', () => {
    const stale = makeRoot('hermes', '3.0.0');
    expect(staleRootInUse([{ root: stale, version: '3.0.0' }], cli(stale))).toEqual({
      root: stale,
      version: '3.0.0',
    });
  });

  it('stays silent when clients run a current root instead', () => {
    const stale = makeRoot('hermes', '3.0.0');
    const current = makeRoot('nvm', '3.1.1');
    expect(staleRootInUse([{ root: stale, version: '3.0.0' }], cli(current))).toBeNull();
  });

  it('stays silent when the launcher was never installed', () => {
    const stale = makeRoot('hermes', '3.0.0');
    expect(staleRootInUse([{ root: stale, version: '3.0.0' }], null)).toBeNull();
    expect(staleRootInUse([{ root: stale, version: '3.0.0' }], path.join(tmp, 'gone.js'))).toBeNull();
  });

  it('matches through symlinks — the shim resolves to the real package dir', () => {
    const stale = makeRoot('hermes', '3.0.0');
    const linkRoot = path.join(tmp, 'linked');
    fs.mkdirSync(linkRoot);
    fs.symlinkSync(path.join(stale, 'trace-mcp'), path.join(linkRoot, 'trace-mcp'), 'dir');
    expect(staleRootInUse([{ root: stale, version: '3.0.0' }], cli(linkRoot))?.root).toBe(stale);
  });
});

/* TRA-692: two installed bundles, only the running one gets updated. The scan is
   what makes the other copy visible at all. */
describe('scanAppBundles', () => {
  let tmp: string;

  const makeBundle = (dir: string, version?: string): string => {
    const appPath = path.join(tmp, dir, 'trace-mcp.app');
    fs.mkdirSync(path.join(appPath, 'Contents', 'MacOS'), { recursive: true });
    if (version !== undefined) {
      fs.writeFileSync(
        path.join(appPath, 'Contents', 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleIdentifier</key>\n<string>com.trace-mcp.app</string>\n<key>CFBundleShortVersionString</key>\n<string>${version}</string>\n</dict></plist>\n`,
      );
    }
    return appPath;
  };
  const exec = (appPath: string): string => path.join(appPath, 'Contents', 'MacOS', 'trace-mcp');

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-bundles-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reports both bundles and their versions, marking the running one', () => {
    const system = makeBundle('Applications', '3.10.0');
    const user = makeBundle('home-apps', '3.11.0');
    expect(scanAppBundles([system, user], runningAppBundle(exec(user)))).toEqual([
      { path: system, version: '3.10.0', running: false },
      { path: user, version: '3.11.0', running: true },
    ]);
  });

  it('reports the single install on a normal machine — the caller gates on length', () => {
    const only = makeBundle('Applications', '3.11.0');
    expect(
      scanAppBundles(
        [only, null, path.join(tmp, 'gone', 'trace-mcp.app')],
        runningAppBundle(exec(only)),
      ),
    ).toEqual([{ path: only, version: '3.11.0', running: true }]);
  });

  it('counts a path reached twice — marker and directory — once', () => {
    const only = makeBundle('Applications', '3.11.0');
    const viaLink = path.join(tmp, 'link.app');
    fs.symlinkSync(only, viaLink, 'dir');
    expect(scanAppBundles([only, viaLink], null)).toHaveLength(1);
  });

  it('skips a build output and a bundle with no readable version', () => {
    const built = makeBundle(path.join('checkout', 'packages', 'app', 'release'), '3.11.0');
    const versionless = makeBundle('Applications');
    expect(scanAppBundles([built, versionless], null)).toEqual([]);
  });
});

describe('runningAppBundle', () => {
  // Built with path.join so the separator matches the one the helper looks for
  // on whatever platform a contributor runs the suite from.
  const bundle = path.join(path.sep, 'Applications', 'trace-mcp.app');

  it('walks back from the executable to the bundle', () => {
    expect(runningAppBundle(path.join(bundle, 'Contents', 'MacOS', 'trace-mcp'))).toBe(bundle);
  });

  it('returns null for a process not running out of a bundle', () => {
    expect(runningAppBundle(path.join(path.sep, 'usr', 'local', 'bin', 'electron'))).toBeNull();
  });
});

describe('readAppLocationMarker', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-marker-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads the recorded appPath', () => {
    const marker = path.join(tmp, 'app-location.json');
    fs.writeFileSync(marker, JSON.stringify({ appPath: '/Applications/trace-mcp.app' }));
    expect(readAppLocationMarker(marker)).toBe('/Applications/trace-mcp.app');
  });

  it('returns null when the marker is absent or malformed', () => {
    expect(readAppLocationMarker(path.join(tmp, 'absent.json'))).toBeNull();
    const broken = path.join(tmp, 'broken.json');
    fs.writeFileSync(broken, '{ not json');
    expect(readAppLocationMarker(broken)).toBeNull();
  });
});

/* TRA-686 code review (PR #790): `apply-daemon-update` used to run `npm
   install -g` through whatever npm it could resolve, without checking that
   the npm root it resolved is the one actually running the daemon. On a
   DMG-only install (TRA-438) the control plane is the app's own bundled
   runtime — `launcher.env` points at a staged server, not at any npm global
   root — so a Homebrew/system npm merely existing on the machine is not
   permission to install through it. */
describe('cliPathOwnedByRoot', () => {
  let tmp: string;

  const makeNpmRoot = (name: string): string => {
    const root = path.join(tmp, name);
    const pkgDir = path.join(root, 'trace-mcp');
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version: '3.10.0' }));
    fs.writeFileSync(path.join(pkgDir, 'dist', 'cli.js'), '');
    return root;
  };
  const cli = (root: string): string => path.join(root, 'trace-mcp', 'dist', 'cli.js');

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-cli-owned-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('is owned when the launcher CLI lives inside the npm root', () => {
    const npmRoot = makeNpmRoot('nvm');
    expect(cliPathOwnedByRoot(cli(npmRoot), npmRoot)).toBe(true);
  });

  it('is NOT owned when the running CLI is the app-bundled runtime, even though an unrelated npm root resolves', () => {
    // The exact scenario the review flagged: a DMG-only install whose
    // launcher.env points at the app's own staged server, on a machine where
    // Homebrew npm happens to also exist and resolve fine.
    const bundledCli = path.join(tmp, 'trace-mcp.app', 'Contents', 'Resources', 'server', 'cli.js');
    fs.mkdirSync(path.dirname(bundledCli), { recursive: true });
    fs.writeFileSync(bundledCli, '');
    const unrelatedNpmRoot = makeNpmRoot('homebrew');

    expect(cliPathOwnedByRoot(bundledCli, unrelatedNpmRoot)).toBe(false);
  });

  it('is not owned when the CLI path does not exist', () => {
    const npmRoot = makeNpmRoot('nvm');
    expect(cliPathOwnedByRoot(path.join(tmp, 'gone.js'), npmRoot)).toBe(false);
  });

  it('is not owned when the root does not exist', () => {
    expect(cliPathOwnedByRoot(cli(makeNpmRoot('nvm')), path.join(tmp, 'no-such-root'))).toBe(false);
  });

  it('is not owned when either input is null', () => {
    const npmRoot = makeNpmRoot('nvm');
    expect(cliPathOwnedByRoot(null, npmRoot)).toBe(false);
    expect(cliPathOwnedByRoot(cli(npmRoot), null)).toBe(false);
  });

  it('matches through symlinks — the shim resolves to the real package dir', () => {
    const real = makeNpmRoot('nvm');
    const linkRoot = path.join(tmp, 'linked');
    fs.mkdirSync(linkRoot);
    fs.symlinkSync(path.join(real, 'trace-mcp'), path.join(linkRoot, 'trace-mcp'), 'dir');
    expect(cliPathOwnedByRoot(cli(linkRoot), real)).toBe(true);
  });
});

describe('evaluateDaemonUpdate', () => {
  it('reports available when the running daemon is behind the registry', () => {
    expect(evaluateDaemonUpdate('3.10.0', '3.13.0', 1000)).toEqual({
      available: true,
      current: '3.10.0',
      latest: '3.13.0',
      lastChecked: 1000,
    });
  });

  it('reports up to date when the daemon already matches the registry', () => {
    expect(evaluateDaemonUpdate('3.13.0', '3.13.0', 1000)).toEqual({
      available: false,
      current: '3.13.0',
      latest: '3.13.0',
      lastChecked: 1000,
    });
  });

  it('is never available when the daemon version is unknown', () => {
    // A daemon /health miss should not flip to "available" just because a
    // registry version came back — an app-vs-daemon mismatch is a different
    // question than "is the daemon current".
    expect(evaluateDaemonUpdate(undefined, '3.13.0', 1000)).toEqual({
      available: false,
      current: undefined,
      latest: '3.13.0',
      lastChecked: 1000,
    });
  });

  it('is never available when the registry lookup failed', () => {
    expect(evaluateDaemonUpdate('3.10.0', undefined, 1000)).toEqual({
      available: false,
      current: '3.10.0',
      lastChecked: 1000,
    });
  });
});

describe('daemonUpdateDegradeToCommand', () => {
  it('hands back the generic copyable command alongside the error', () => {
    expect(daemonUpdateDegradeToCommand('could not locate npm')).toEqual({
      ok: false,
      error: 'could not locate npm',
      command: GENERIC_NPM_UPDATE_COMMAND,
    });
  });
});
