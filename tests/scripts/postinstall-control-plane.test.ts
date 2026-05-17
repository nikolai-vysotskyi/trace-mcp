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
    expect(fs.existsSync(path.join(home, 'bin', 'trace-mcp'))).toBe(false);
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

      const shimName = process.platform === 'win32' ? 'trace-mcp.cmd' : 'trace-mcp';
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
});
