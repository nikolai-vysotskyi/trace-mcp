import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'postinstall-control-plane.mjs');
const ATTRIBUTION_PATH = path.join(REPO_ROOT, 'scripts', 'daemon-attribution.mjs');

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

describe('postinstall-control-plane', () => {
  let home: string;

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
    const fakePkg = mkTmp('trace-mcp-fakepkg-');
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
    const fakePkg = mkTmp('trace-mcp-fakepkg-');
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
    // Must exceed the daemon's own 5s bounded hard-exit so we decide when to
    // give up, not launchd.
    expect(Number(scriptTimeout)).toBeGreaterThan(5);
    for (const src of [script, lifecycle]) {
      expect(src).toContain('<key>ExitTimeOut</key>');
      expect(src).toContain('<integer>${PLIST_EXIT_TIMEOUT_SEC}</integer>');
    }
  });
});
