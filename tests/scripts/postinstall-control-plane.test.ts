import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAEMON_SHUTDOWN_DEADLINE_MS } from '../../src/server/bounded-shutdown.js';
import { isEphemeralInstallPath } from '../../src/global.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'postinstall-control-plane.mjs');
const ATTRIBUTION_PATH = path.join(REPO_ROOT, 'scripts', 'daemon-attribution.mjs');

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Stage a fake INSTALLED package outside ephemeral shapes (TRA-1807).
 *
 * The Multica runtime exports a task-scoped TMPDIR (`/tmp/multica-task-<id>`),
 * and postinstall refuses to adopt the live daemon from anywhere under it
 * (or under /tmp at all) — a fixture staged with plain mkTmp would read as a
 * sandbox install and take the refusal branch. Step out of the task dir first
 * (same idea as tmpRootOutsideTaskDir in tests/test-utils.ts); on a machine
 * where that still lands under /tmp, fall back to the real home. The
 * returned dir is verified against the real classifier the script mirrors.
 */
function mkStableTmp(prefix: string): string {
  const base = os.tmpdir();
  const stepped = /[/\\]multica-task-\d+[/\\]?$/i.test(base) ? path.dirname(base) : base;
  for (const dir of [stepped, os.homedir()]) {
    try {
      const staged = fs.mkdtempSync(path.join(dir, prefix));
      if (!isEphemeralInstallPath(staged)) return staged;
      fs.rmSync(staged, { recursive: true, force: true });
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('mkStableTmp: no non-ephemeral staging dir found');
}

// CI sets TRACE_MCP_NO_POSTINSTALL=1 at workflow level so npm install doesn't
// run our control-plane script. That env var leaks into this test via
// process.env, forcing every script invocation to short-circuit before it
// reaches the dev-checkout / fake-pkg branches the tests want to exercise.
// Strip the opt-out vars from the inherited env unless the caller sets them
// explicitly, so tests get the real script behavior they assert against.
const STRIP_INHERITED = [
  'TRACE_MCP_NO_POSTINSTALL',
  'TRACE_MCP_NO_AUTO_UPDATE',
  'TRACE_MCP_NO_PREFLIGHT',
  'TRACE_MCP_MANAGED_BY',
] as const;

function buildEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const k of STRIP_INHERITED) delete merged[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  return merged;
}

function runScript(env: Record<string, string | undefined>): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  try {
    const out = execFileSync(process.execPath, [SCRIPT_PATH], {
      env: buildEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return { status: 0, stdout: out, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      status: e.status ?? 1,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
    };
  }
}

/** Minimal installed-package layout with no .git, so the script doesn't skip. */
function stageFakePkg(fakePkg: string): void {
  fs.mkdirSync(path.join(fakePkg, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(fakePkg, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(fakePkg, 'dist'), { recursive: true });
  fs.copyFileSync(SCRIPT_PATH, path.join(fakePkg, 'scripts', 'postinstall-control-plane.mjs'));
  fs.copyFileSync(ATTRIBUTION_PATH, path.join(fakePkg, 'scripts', 'daemon-attribution.mjs'));
  for (const name of [
    'trace-mcp-launcher.sh',
    'trace-mcp-launcher.cmd',
    'trace-mcp-launcher.ps1',
  ]) {
    const src = path.join(REPO_ROOT, 'hooks', name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(fakePkg, 'hooks', name));
  }
  fs.writeFileSync(path.join(fakePkg, 'dist', 'cli.js'), '// fake\n');
  fs.writeFileSync(
    path.join(fakePkg, 'package.json'),
    JSON.stringify({ name: 'trace-mcp', version: '9.9.9-test' }),
  );
}

describe('postinstall-control-plane', () => {
  let home: string;

  /** Run the staged script against the fake home, with the real default paths. */
  function runFakePkg(fakePkg: string): void {
    execFileSync(
      process.execPath,
      [path.join(fakePkg, 'scripts', 'postinstall-control-plane.mjs')],
      {
        env: buildEnv({
          HOME: home,
          USERPROFILE: home,
          CI: 'true',
          TRACE_MCP_DATA_DIR: undefined,
          TRACE_MCP_HOME: undefined,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
  }

  beforeEach(() => {
    home = mkTmp('trace-mcp-postinstall-');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('respects TRACE_MCP_NO_POSTINSTALL=1', () => {
    const result = runScript({
      HOME: home,
      TRACE_MCP_DATA_DIR: home,
      TRACE_MCP_NO_POSTINSTALL: '1',
    });
    expect(result.status).toBe(0);
    // launcher.env should NOT be written when opt-out is active.
    expect(fs.existsSync(path.join(home, 'launcher.env'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'bin', 'trace'))).toBe(false);
  });

  it('skips dev checkout (.git next to package.json)', () => {
    // The repo we run from IS a dev checkout — running without overrides
    // should detect .git and skip.
    const result = runScript({
      HOME: home,
      TRACE_MCP_DATA_DIR: home,
    });
    expect(result.status).toBe(0);
    // Postinstall.log should exist (early-skip is still logged).
    const logPath = path.join(home, 'postinstall.log');
    if (fs.existsSync(logPath)) {
      const log = fs.readFileSync(logPath, 'utf-8');
      expect(log).toMatch(/skip \(dev checkout/);
    }
    // No launcher.env in a dev checkout.
    expect(fs.existsSync(path.join(home, 'launcher.env'))).toBe(false);
  });

  it('writes launcher.env and shim when not a dev checkout (idempotent)', () => {
    // Create a fake installed package layout that has NO .git.
    // Staged outside ephemeral shapes (mkStableTmp): under a task-scoped
    // TMPDIR the refusal branch would fire instead of the install branch.
    const fakePkg = mkStableTmp('trace-mcp-fakepkg-');
    try {
      fs.mkdirSync(path.join(fakePkg, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(fakePkg, 'hooks'), { recursive: true });
      fs.mkdirSync(path.join(fakePkg, 'dist'), { recursive: true });
      // Copy the script + required hook + a fake dist/cli.js + package.json.
      fs.copyFileSync(SCRIPT_PATH, path.join(fakePkg, 'scripts', 'postinstall-control-plane.mjs'));
      // Sibling module the script imports for stop attribution (TRA-850).
      fs.copyFileSync(ATTRIBUTION_PATH, path.join(fakePkg, 'scripts', 'daemon-attribution.mjs'));
      for (const name of [
        'trace-mcp-launcher.sh',
        'trace-mcp-launcher.cmd',
        'trace-mcp-launcher.ps1',
      ]) {
        const src = path.join(REPO_ROOT, 'hooks', name);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(fakePkg, 'hooks', name));
      }
      fs.writeFileSync(path.join(fakePkg, 'dist', 'cli.js'), '// fake\n');
      fs.writeFileSync(
        path.join(fakePkg, 'package.json'),
        JSON.stringify({ name: 'trace-mcp', version: '9.9.9-test' }),
      );

      const fakeScript = path.join(fakePkg, 'scripts', 'postinstall-control-plane.mjs');
      const env = {
        HOME: home,
        TRACE_MCP_DATA_DIR: home,
        // Force-skip launchctl so the host's LaunchAgents stay untouched.
        // (The script's CI=true short-circuit keeps us out of plist territory.)
        CI: 'true',
      };
      const result1 = execFileSync(process.execPath, [fakeScript], {
        env: buildEnv(env),
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });

      const envPath = path.join(home, 'launcher.env');
      expect(fs.existsSync(envPath)).toBe(true);
      const envContent = fs.readFileSync(envPath, 'utf-8');
      expect(envContent).toMatch(/^TRACE_MCP_NODE="/m);
      expect(envContent).toMatch(/^TRACE_MCP_CLI=".*\/dist\/cli\.js"$/m);
      expect(envContent).toMatch(/^TRACE_MCP_VERSION="9\.9\.9-test"$/m);

      const shimName = process.platform === 'win32' ? 'trace.cmd' : 'trace';
      const shimPath = path.join(home, 'bin', shimName);
      expect(fs.existsSync(shimPath)).toBe(true);

      // Idempotency: run twice → identical files.
      const snapshot1 = fs.readFileSync(envPath, 'utf-8');
      const shim1 = fs.readFileSync(shimPath);

      execFileSync(process.execPath, [fakeScript], {
        env: buildEnv(env),
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });

      const snapshot2 = fs.readFileSync(envPath, 'utf-8');
      const shim2 = fs.readFileSync(shimPath);
      expect(snapshot2).toBe(snapshot1);
      expect(Buffer.compare(shim1, shim2)).toBe(0);
      // Suppress unused-variable lint for result1; the assertion above already ran.
      void result1;
    } finally {
      fs.rmSync(fakePkg, { recursive: true, force: true });
    }
  });

  it('migrates a pre-existing ~/.trace-mcp home dir to ~/.trace and preserves a legacy bin symlink', () => {
    // No TRACE_MCP_DATA_DIR override this time — exercise the real default
    // resolution (~/.trace, migrated from ~/.trace-mcp) instead of pinning it.
    // Staged outside ephemeral shapes (mkStableTmp) — see above.
    const fakePkg = mkStableTmp('trace-mcp-fakepkg-');
    try {
      fs.mkdirSync(path.join(fakePkg, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(fakePkg, 'hooks'), { recursive: true });
      fs.mkdirSync(path.join(fakePkg, 'dist'), { recursive: true });
      fs.copyFileSync(SCRIPT_PATH, path.join(fakePkg, 'scripts', 'postinstall-control-plane.mjs'));
      // Sibling module the script imports for stop attribution (TRA-850).
      fs.copyFileSync(ATTRIBUTION_PATH, path.join(fakePkg, 'scripts', 'daemon-attribution.mjs'));
      for (const name of [
        'trace-mcp-launcher.sh',
        'trace-mcp-launcher.cmd',
        'trace-mcp-launcher.ps1',
      ]) {
        const src = path.join(REPO_ROOT, 'hooks', name);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(fakePkg, 'hooks', name));
      }
      fs.writeFileSync(path.join(fakePkg, 'dist', 'cli.js'), '// fake\n');
      fs.writeFileSync(
        path.join(fakePkg, 'package.json'),
        JSON.stringify({ name: 'trace-mcp', version: '9.9.9-test' }),
      );

      // Pre-existing ~/.trace-mcp with a marker file, as a real pre-TRA-611 install would have.
      const legacyHome = path.join(home, '.trace-mcp');
      fs.mkdirSync(legacyHome, { recursive: true });
      fs.writeFileSync(path.join(legacyHome, 'registry.json'), '{"marker":true}');

      const fakeScript = path.join(fakePkg, 'scripts', 'postinstall-control-plane.mjs');
      execFileSync(process.execPath, [fakeScript], {
        // tests/setup/isolate-home.ts pins TRACE_MCP_DATA_DIR for the whole
        // worker process so the suite never touches the real ~/.trace — this
        // test exercises the *default* (unoverridden) resolution, so clear
        // both env vars the script accepts as an override (see global.ts).
        // os.homedir() reads USERPROFILE on Windows, not HOME — set both so
        // the child resolves to the same fake home regardless of platform.
        env: buildEnv({
          HOME: home,
          USERPROFILE: home,
          CI: 'true',
          TRACE_MCP_DATA_DIR: undefined,
          TRACE_MCP_HOME: undefined,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });

      const newHome = path.join(home, '.trace');
      // The rename carried the marker file over — not a copy that left a stale duplicate.
      expect(fs.readFileSync(path.join(newHome, 'registry.json'), 'utf-8')).toBe('{"marker":true}');
      // Old data doesn't linger behind at the legacy path — only the compat symlink (below) does.
      expect(fs.existsSync(path.join(legacyHome, 'registry.json'))).toBe(false);

      const shimName = process.platform === 'win32' ? 'trace.cmd' : 'trace';
      expect(fs.existsSync(path.join(newHome, 'bin', shimName))).toBe(true);

      // Durable marker: a later `trace init`/postinstall run must be able to
      // retry the compat symlink below even if this run's attempt had failed,
      // so this has to outlive the one-shot in-process migration flag.
      expect(fs.existsSync(path.join(newHome, '.migrated-from-trace-mcp'))).toBe(true);

      // Legacy absolute path a pre-rename MCP client config still points at.
      const legacyShimName = process.platform === 'win32' ? 'trace-mcp.cmd' : 'trace-mcp';
      const legacyShimPath = path.join(legacyHome, 'bin', legacyShimName);
      const legacyStat = fs.lstatSync(legacyShimPath);
      expect(legacyStat.isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(legacyShimPath)).toBe(
        fs.realpathSync(path.join(newHome, 'bin', shimName)),
      );
    } finally {
      fs.rmSync(fakePkg, { recursive: true, force: true });
    }
  });

  // `npm i -g trace-mcp` runs this script and never reaches `trace init`, so
  // this is the only installer an upgrade has. It used to return early whenever
  // the legacy path existed in any shape, which left an MCP client registered
  // there spawning a frozen copy no launcher fix could reach (TRA-1156).
  it.skipIf(process.platform === 'win32')(
    'repoints a stale legacy shim copy at the current one instead of leaving it frozen',
    () => {
      // Staged outside ephemeral shapes (mkStableTmp) — see above.
      const fakePkg = mkStableTmp('trace-mcp-fakepkg-');
      try {
        stageFakePkg(fakePkg);

        // A pre-rename install: a real shim file at the legacy absolute path,
        // several launcher versions behind, plus the migration marker a past
        // run left behind.
        const legacyBin = path.join(home, '.trace-mcp', 'bin');
        fs.mkdirSync(legacyBin, { recursive: true });
        const legacyShim = path.join(legacyBin, 'trace-mcp');
        fs.writeFileSync(legacyShim, '#!/bin/bash\n# trace-mcp-launcher v0.1.0\nexit 0\n', {
          mode: 0o755,
        });
        const newHome = path.join(home, '.trace');
        fs.mkdirSync(newHome, { recursive: true });
        fs.writeFileSync(path.join(newHome, '.migrated-from-trace-mcp'), '');

        runFakePkg(fakePkg);

        const currentShim = path.join(newHome, 'bin', 'trace');
        expect(fs.lstatSync(legacyShim).isSymbolicLink()).toBe(true);
        expect(fs.realpathSync(legacyShim)).toBe(fs.realpathSync(currentShim));
        // No orphaned tmp left beside it.
        expect(fs.readdirSync(legacyBin).filter((n) => n.includes('.tmp.'))).toEqual([]);
      } finally {
        fs.rmSync(fakePkg, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    "leaves a wrapper at the legacy path that isn't ours alone",
    () => {
      // Staged outside ephemeral shapes (mkStableTmp) — see above.
      const fakePkg = mkStableTmp('trace-mcp-fakepkg-');
      try {
        stageFakePkg(fakePkg);

        const legacyBin = path.join(home, '.trace-mcp', 'bin');
        fs.mkdirSync(legacyBin, { recursive: true });
        const legacyShim = path.join(legacyBin, 'trace-mcp');
        const userWrapper = '#!/bin/sh\nexec my-own-thing "$@"\n';
        fs.writeFileSync(legacyShim, userWrapper, { mode: 0o755 });
        fs.mkdirSync(path.join(home, '.trace'), { recursive: true });
        fs.writeFileSync(path.join(home, '.trace', '.migrated-from-trace-mcp'), '');

        runFakePkg(fakePkg);

        expect(fs.lstatSync(legacyShim).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(legacyShim, 'utf-8')).toBe(userWrapper);
      } finally {
        fs.rmSync(fakePkg, { recursive: true, force: true });
      }
    },
  );

  // TRA-1807: a postinstall running from an agent-run sandbox
  // (/private/tmp/multica-task-<id>/...) must not adopt the live daemon —
  // overwriting launcher.env + the shim and kickstarting launchd from there
  // pins :3741 to a directory that dies with the run.
  it('refuses to adopt the live daemon from an ephemeral sandbox install', () => {
    // Deterministic task-style dir (NOT mkdtempSync: its random suffix would
    // land inside the run id and break the `multica-task-<digits>/` shape —
    // the id itself must be pure digits followed by a separator).
    // Mirror the incident layout: <sandbox>/pinned-latest/node_modules/trace-mcp.
    const sandbox = path.join(os.tmpdir(), `multica-task-${process.pid}1807`);
    fs.mkdirSync(sandbox, { recursive: true });
    const fakePkg = path.join(sandbox, 'pinned-latest', 'node_modules', 'trace-mcp');
    try {
      stageFakePkg(fakePkg);

      // Run the staged sandbox copy (runScript would run the REPO script,
      // which early-skips as a dev checkout).
      const fakeScript = path.join(fakePkg, 'scripts', 'postinstall-control-plane.mjs');
      execFileSync(process.execPath, [fakeScript], {
        env: buildEnv({ HOME: home, TRACE_MCP_DATA_DIR: home, CI: 'true' }),
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });

      // Nothing adopted: no launcher.env, no shim, refusal logged, exit 0
      // (postinstall must never fail npm install).
      expect(fs.existsSync(path.join(home, 'launcher.env'))).toBe(false);
      expect(fs.existsSync(path.join(home, 'bin', 'trace'))).toBe(false);
      const log = fs.readFileSync(path.join(home, 'postinstall.log'), 'utf-8');
      expect(log).toMatch(/refusing to adopt live daemon from ephemeral install/);
      expect(log).toMatch(/TRA-1807/);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  // TRA-1963: a stale cached extract (npx `~/.npm/_npx/<hash>/...`) must not
  // adopt the live daemon even when it is not under a tmp root — the tree
  // can vanish with the next cache prune, and in the incident it carried an
  // older version that downgraded :3741.
  it('refuses to adopt the live daemon from a transient npx cache', () => {
    // Must live outside /tmp: the shared-tmp rule would refuse it for the
    // wrong reason. Staged under the real home instead (cleaned up below).
    const base = fs.mkdtempSync(path.join(os.homedir(), 'trace-mcp-npxtest-'));
    const fakePkg = path.join(base, '_npx', '6f1433a36d5760a4', 'node_modules', 'trace-mcp');
    try {
      // Sanity: this path is refused for the npx reason, not the tmp reason.
      expect(isEphemeralInstallPath(fakePkg)).toBe(true);
      expect(path.resolve(fakePkg).startsWith(`${path.resolve('/tmp')}/`)).toBe(false);
      expect(path.resolve(fakePkg).startsWith(`${path.resolve('/private/tmp')}/`)).toBe(false);
      stageFakePkg(fakePkg);

      const fakeScript = path.join(fakePkg, 'scripts', 'postinstall-control-plane.mjs');
      execFileSync(process.execPath, [fakeScript], {
        env: buildEnv({ HOME: home, TRACE_MCP_DATA_DIR: home, CI: 'true' }),
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });

      expect(fs.existsSync(path.join(home, 'launcher.env'))).toBe(false);
      expect(fs.existsSync(path.join(home, 'bin', 'trace'))).toBe(false);
      const log = fs.readFileSync(path.join(home, 'postinstall.log'), 'utf-8');
      expect(log).toMatch(/refusing to adopt live daemon from ephemeral install/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  // TRA-1963: the 3.33.0 → 3.31.5 (stale npx cache) → 3.32.0 incident. A
  // candidate older than the version backing the live daemon (per
  // launcher.env) must leave launcher.env, the shim and launchd untouched.
  it('refuses a candidate older than the live daemon (downgrade guard)', () => {
    const fakePkg = mkStableTmp('trace-mcp-fakepkg-');
    try {
      stageFakePkg(fakePkg);
      // The candidate is stale: rewrite the staged package.json to 1.0.0.
      fs.writeFileSync(
        path.join(fakePkg, 'package.json'),
        JSON.stringify({ name: 'trace-mcp', version: '1.0.0-stale' }),
      );
      // The live daemon serves 9.9.9-test (what stageFakePkg's launcher.env
      // would have recorded on the install that adopted it).
      const liveCli = path.join(fakePkg, 'dist', 'cli.js');
      fs.writeFileSync(
        path.join(home, 'launcher.env'),
        '# Managed by trace-mcp postinstall — do not edit by hand.\n' +
          `TRACE_MCP_NODE="/usr/local/bin/node"\n` +
          `TRACE_MCP_CLI="${liveCli}"\n` +
          `TRACE_MCP_VERSION="9.9.9-test"\n`,
      );

      const fakeScript = path.join(fakePkg, 'scripts', 'postinstall-control-plane.mjs');
      execFileSync(process.execPath, [fakeScript], {
        env: buildEnv({ HOME: home, TRACE_MCP_DATA_DIR: home, CI: 'true' }),
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });

      // launcher.env still names the live version; no shim was (re)installed.
      const envContent = fs.readFileSync(path.join(home, 'launcher.env'), 'utf-8');
      expect(envContent).toMatch(/^TRACE_MCP_VERSION="9\.9\.9-test"$/m);
      expect(envContent).not.toMatch(/1\.0\.0-stale/);
      expect(fs.existsSync(path.join(home, 'bin', 'trace'))).toBe(false);
      const log = fs.readFileSync(path.join(home, 'postinstall.log'), 'utf-8');
      expect(log).toMatch(/downgrade-refused/);
      expect(log).toMatch(/TRA-1963/);
    } finally {
      fs.rmSync(fakePkg, { recursive: true, force: true });
    }
  });

  // The guard must not block the normal path: a newer candidate over a live
  // older version still adopts the daemon.
  it('adopts a candidate newer than the live daemon', () => {
    const fakePkg = mkStableTmp('trace-mcp-fakepkg-');
    try {
      stageFakePkg(fakePkg);
      fs.writeFileSync(
        path.join(home, 'launcher.env'),
        '# Managed by trace-mcp postinstall — do not edit by hand.\n' +
          `TRACE_MCP_NODE="/usr/local/bin/node"\n` +
          `TRACE_MCP_CLI="/nowhere/cli.js"\n` +
          `TRACE_MCP_VERSION="1.0.0-old"\n`,
      );

      const fakeScript = path.join(fakePkg, 'scripts', 'postinstall-control-plane.mjs');
      execFileSync(process.execPath, [fakeScript], {
        env: buildEnv({ HOME: home, TRACE_MCP_DATA_DIR: home, CI: 'true' }),
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });

      const envContent = fs.readFileSync(path.join(home, 'launcher.env'), 'utf-8');
      expect(envContent).toMatch(/^TRACE_MCP_VERSION="9\.9\.9-test"$/m);
      const shimName = process.platform === 'win32' ? 'trace.cmd' : 'trace';
      expect(fs.existsSync(path.join(home, 'bin', shimName))).toBe(true);
      const log = fs.readFileSync(path.join(home, 'postinstall.log'), 'utf-8');
      expect(log).not.toMatch(/downgrade-refused/);
    } finally {
      fs.rmSync(fakePkg, { recursive: true, force: true });
    }
  });

  // TRA-1963: a launchctl failure with empty stdout/stderr must still say why
  // — `kickstart: failed ()` is undebuggable. The script now prefers stderr,
  // then stdout, then the spawn error message, then the exit status.
  it('never logs an empty launchctl failure reason', () => {
    const script = fs.readFileSync(SCRIPT_PATH, 'utf-8');
    expect(script).toContain('describeLaunchctlFailure');
    expect(script).not.toMatch(/kickstart: \$\{kick\.ok \? 'ok' : `failed \(\$\{kick\.stderr/);
    expect(script).not.toMatch(/failed \(\$\{kick\.stderr\.trim\(\)\}\)/);
  });

  it('PLIST_VERSION constant matches src/daemon/lifecycle.ts', () => {
    const script = fs.readFileSync(SCRIPT_PATH, 'utf-8');
    const lifecycle = fs.readFileSync(
      path.join(REPO_ROOT, 'src', 'daemon', 'lifecycle.ts'),
      'utf-8',
    );
    const scriptMatch = script.match(/const PLIST_VERSION\s*=\s*(\d+)/);
    const lifecycleMatch = lifecycle.match(/const PLIST_VERSION\s*=\s*(\d+)/);
    expect(scriptMatch?.[1]).toBeDefined();
    expect(lifecycleMatch?.[1]).toBeDefined();
    expect(scriptMatch?.[1]).toBe(lifecycleMatch?.[1]);
  });

  /**
   * TRA-421: launchd's default ExitTimeOut is 5s. Graceful shutdown closes a DB
   * per registered project, overran that, and launchd SIGKILLed the daemon
   * (LastExitStatus=9) — taking the buffered "Daemon shutting down" line with
   * it, which is why 210 of 624 restarts left no trace at all. Both plist
   * templates must set it, and to the same value.
   */
  it('both plist templates set a matching ExitTimeOut', () => {
    const script = fs.readFileSync(SCRIPT_PATH, 'utf-8');
    const lifecycle = fs.readFileSync(
      path.join(REPO_ROOT, 'src', 'daemon', 'lifecycle.ts'),
      'utf-8',
    );
    const pattern = /const PLIST_EXIT_TIMEOUT_SEC\s*=\s*(\d+)/;
    const scriptTimeout = script.match(pattern)?.[1];
    const lifecycleTimeout = lifecycle.match(pattern)?.[1];
    expect(scriptTimeout).toBeDefined();
    expect(scriptTimeout).toBe(lifecycleTimeout);
    // Must exceed the daemon's own bounded hard-exit so we decide when to give
    // up, not launchd. Compared against the real constant (TRA-849): raising
    // one of the two past the other silently reintroduces the SIGKILL that
    // TRA-421 fixed.
    expect(Number(scriptTimeout) * 1000).toBeGreaterThan(DAEMON_SHUTDOWN_DEADLINE_MS);
    for (const src of [script, lifecycle]) {
      expect(src).toContain('<key>ExitTimeOut</key>');
      expect(src).toContain('<integer>${PLIST_EXIT_TIMEOUT_SEC}</integer>');
    }
  });

  it('atomic writes in postinstall script use 12-char hex random suffix matching ORPHAN_TMP_PATTERN', () => {
    const script = fs.readFileSync(SCRIPT_PATH, 'utf-8');
    expect(script).not.toMatch(/\.tmp\.\$\{process\.pid\}\.\$\{Date\.now\(\)\}/);
    expect(script).toMatch(/const rand = randomBytes\(6\)\.toString\('hex'\)/);
  });
});
