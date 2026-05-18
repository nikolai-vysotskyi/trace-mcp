import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'apply-pending-update.mjs');

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Drive refreshCliPackage(version) inside a child process so we control HOME
 * and PATH and don't pollute the parent vitest env (refreshCliPackage resolves
 * launcher.env at <HOME>/.trace-mcp/launcher.env, which is computed at import
 * time from os.homedir()).
 *
 * The harness imports the script as an ESM module — main() short-circuits
 * because no PENDING_ZIP exists under tmp HOME, and refreshCliPackage is
 * re-exported for test consumption.
 */
function runRefreshHarness(opts: {
  home: string;
  version: string;
  fakeNpmExitCode?: number;
  fakeNpmDelayMs?: number;
  envCapturePath?: string;
}): { stdout: string; stderr: string; logTail: string } {
  // Build a fake node + npm pair under <home>/fake-node-prefix/{bin,lib}.
  const prefix = path.join(opts.home, 'fake-node-prefix');
  const binDir = path.join(prefix, 'bin');
  const npmRoot = path.join(prefix, 'lib', 'node_modules');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(npmRoot, { recursive: true });

  // Symlink the real node so existsSync(TRACE_MCP_NODE) passes and the
  // version reader walks <node>/../lib/node_modules/trace-mcp/package.json
  // into our fake npm root.
  const fakeNode = path.join(binDir, 'node');
  try {
    fs.symlinkSync(process.execPath, fakeNode);
  } catch {
    fs.copyFileSync(process.execPath, fakeNode);
    fs.chmodSync(fakeNode, 0o755);
  }

  // Fake npm script that records argv + env, then exits with the desired code.
  const npmLog = path.join(opts.home, 'fake-npm.log');
  const fakeNpm = path.join(binDir, 'npm');
  const delay = opts.fakeNpmDelayMs ?? 0;
  const exitCode = opts.fakeNpmExitCode ?? 0;
  const npmScript = `#!/usr/bin/env node
import fs from 'node:fs';
const out = { argv: process.argv.slice(2), env: {
  TRACE_MCP_NO_AUTO_UPDATE: process.env.TRACE_MCP_NO_AUTO_UPDATE ?? null,
  TRACE_MCP_NO_POSTINSTALL: process.env.TRACE_MCP_NO_POSTINSTALL ?? null,
} };
fs.writeFileSync(${JSON.stringify(npmLog)}, JSON.stringify(out, null, 2));
${delay > 0 ? `await new Promise((r) => setTimeout(r, ${delay}));` : ''}
process.exit(${exitCode});
`;
  fs.writeFileSync(fakeNpm, npmScript, { mode: 0o755 });

  // Write launcher.env pointing at the fake node.
  const launcherDir = path.join(opts.home, '.trace-mcp');
  fs.mkdirSync(launcherDir, { recursive: true });
  fs.writeFileSync(
    path.join(launcherDir, 'launcher.env'),
    `TRACE_MCP_NODE="${fakeNode}"\nTRACE_MCP_CLI="/dev/null"\n`,
  );

  return runHarness(opts.home, opts.version);
}

function runHarness(
  home: string,
  version: string,
): { stdout: string; stderr: string; logTail: string } {
  const harness = `
import { refreshCliPackage } from ${JSON.stringify(SCRIPT_PATH)};
refreshCliPackage(${JSON.stringify(version)});
`;
  const harnessPath = path.join(home, 'harness.mjs');
  fs.writeFileSync(harnessPath, harness);

  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync(process.execPath, [harnessPath], {
      env: {
        ...process.env,
        HOME: home,
        // Force the macOS log path under tmp HOME so we don't pollute real logs.
        // The script computes LOG_FILE from os.homedir(), so just overriding
        // HOME is enough on darwin. On Linux the script's main() no-ops,
        // but refreshCliPackage runs regardless of platform.
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 30_000,
    });
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    stdout = e.stdout?.toString() ?? '';
    stderr = e.stderr?.toString() ?? '';
  }

  // Read the apply-update.log that the script writes under HOME.
  const logFile = path.join(home, 'Library', 'Logs', 'trace-mcp', 'apply-update.log');
  let logTail = '';
  if (fs.existsSync(logFile)) logTail = fs.readFileSync(logFile, 'utf-8');
  return { stdout, stderr, logTail };
}

describe('apply-pending-update.refreshCliPackage', () => {
  let home: string;

  beforeEach(() => {
    home = mkTmp('trace-mcp-apply-update-');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('skips when launcher.env is missing', () => {
    // No launcher.env, no fake npm — just call refreshCliPackage.
    const { logTail } = runHarness(home, '1.39.0');
    expect(logTail).toMatch(/refreshCliPackage: skip \(launcher\.env missing/);
    // npm should never have been invoked → no fake-npm.log.
    expect(fs.existsSync(path.join(home, 'fake-npm.log'))).toBe(false);
  });

  it('skips when CLI is already at the target version', () => {
    const version = '1.42.0';
    const { logTail } = runRefreshHarness({ home, version });
    // Plant the installed package.json BEFORE running by pre-seeding manually:
    // runRefreshHarness builds the fake prefix then runs immediately, so
    // re-do the setup and pre-seed the package.json before invocation.
    // (Above call ran without pre-seed → expected to attempt install.)
    void logTail; // discard first run; we re-run with the pkg in place.

    const prefix = path.join(home, 'fake-node-prefix');
    const pkgDir = path.join(prefix, 'lib', 'node_modules', 'trace-mcp');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'trace-mcp', version }),
    );
    // Remove the prior fake-npm.log so we can detect a re-spawn.
    try {
      fs.unlinkSync(path.join(home, 'fake-npm.log'));
    } catch {}

    const second = runHarness(home, version);
    expect(second.logTail).toMatch(
      new RegExp(`refreshCliPackage: skip \\(already at ${version.replace(/\./g, '\\.')}\\)`),
    );
    expect(fs.existsSync(path.join(home, 'fake-npm.log'))).toBe(false);
  });

  it('passes TRACE_MCP_NO_AUTO_UPDATE=1 to npm install', () => {
    const version = '1.50.0';
    runRefreshHarness({ home, version });

    const npmLogPath = path.join(home, 'fake-npm.log');
    expect(fs.existsSync(npmLogPath)).toBe(true);
    const npmLog = JSON.parse(fs.readFileSync(npmLogPath, 'utf-8'));
    expect(npmLog.argv).toEqual(['install', '-g', `trace-mcp@${version}`]);
    expect(npmLog.env.TRACE_MCP_NO_AUTO_UPDATE).toBe('1');
    // TRACE_MCP_NO_POSTINSTALL must NOT be forced — the postinstall still
    // needs to refresh launcher.env.
    expect(npmLog.env.TRACE_MCP_NO_POSTINSTALL).not.toBe('1');
  });

  it('handles npm install failure gracefully (logs, does not throw)', () => {
    const version = '1.51.0';
    const { logTail } = runRefreshHarness({ home, version, fakeNpmExitCode: 17 });

    // Process must not crash — the harness invocation should have exited 0.
    expect(logTail).toMatch(/refreshCliPackage: npm exited status=17/);
    // The failure must NOT include "ok" — only failure lines.
    expect(logTail).not.toMatch(/refreshCliPackage: ok/);
  });
});
