import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOK = path.resolve('hooks/trace-mcp-reindex.sh');

interface RunResult {
  /** null when the child was killed rather than exiting (e.g. timeout). */
  status: number | null;
  stdout: string;
  stderr: string;
  signal: string | null;
  message: string;
}

/**
 * Assert the hook exited cleanly, reporting *why* it did not when it fails.
 * A bare `expect(res.status).toBe(0)` collapses "script exited 1", "script was
 * killed on timeout" and "spawn failed" into the same uninformative
 * `expected 1 to be +0` — which is exactly what made the macOS flake in
 * TRA-238 undiagnosable from CI logs alone.
 */
function expectCleanExit(res: RunResult): void {
  expect(
    res.status,
    `hook did not exit 0\n  status: ${String(res.status)}\n  signal: ${String(res.signal)}\n  message: ${res.message}\n  stdout: ${JSON.stringify(res.stdout)}\n  stderr: ${JSON.stringify(res.stderr)}`,
  ).toBe(0);
}

function runHook(opts: {
  cwd: string;
  stubDir: string;
  traceHome: string;
  stdin: string;
  port?: number;
  sanitizePath?: boolean;
}): RunResult {
  // sanitizePath drops node_modules / system bin dirs that might have a real
  // trace-mcp installed, so the hook only sees the stubs we provide.
  const basePath = opts.sanitizePath ? '/usr/bin:/bin' : (process.env.PATH ?? '');
  const stubPath = `${opts.stubDir}:${basePath}`;
  try {
    const stdout = execSync(`bash ${HOOK}`, {
      input: opts.stdin,
      cwd: opts.cwd,
      env: {
        ...process.env,
        PATH: stubPath,
        TRACE_MCP_HOME: opts.traceHome,
        TRACE_MCP_DAEMON_PORT: String(opts.port ?? 65535),
        HOME: opts.traceHome,
      },
      encoding: 'utf-8',
      // Generous: the hook is a shell script that spawns ~10 subprocesses, and
      // a shared macOS CI runner under a parallel vitest load is far slower
      // than a developer machine. This bounds a hang, it does not assert
      // latency — the test is about the script's exit semantics.
      timeout: 60_000,
    });
    return { status: 0, stdout, stderr: '', signal: null, message: '' };
  } catch (e) {
    const err = e as {
      status?: number | null;
      signal?: string | null;
      message?: string;
      stdout?: Buffer;
      stderr?: Buffer;
    };
    return {
      // Deliberately NOT `?? 1`: a killed child has a null status, and
      // flattening that to 1 disguises a timeout as a script failure.
      status: err.status ?? null,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      signal: err.signal ?? null,
      message: err.message ?? '',
    };
  }
}

function makeCurlStub(stubDir: string, httpCode: string): string {
  fs.mkdirSync(stubDir, { recursive: true });
  const stubPath = path.join(stubDir, 'curl');
  // Mimic `-w '%{http_code}'`: write the chosen status code to whatever
  // the real curl would write it to. The real hook redirects body to
  // /dev/null and captures stdout — so we just print the code.
  const body = `#!/usr/bin/env bash
# Stub curl. Reads args, prints HTTP code on stdout, exits 0.
echo "${httpCode}"
exit 0
`;
  fs.writeFileSync(stubPath, body);
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

/**
 * Real curl under `-w '%{http_code}'` PRINTS "000" and THEN exits non-zero on
 * a refused connection. The original stub only did the second half, so the
 * hook's old `|| echo "000"` looked correct in tests while producing "000000"
 * — and therefore `reason: "other"` — against the real binary. TRA-694 found
 * `no-daemon` had never once been recorded in 16,440 production lines.
 */
function makeFailingCurlStub(stubDir: string, printsCode = true): string {
  fs.mkdirSync(stubDir, { recursive: true });
  const stubPath = path.join(stubDir, 'curl');
  const body = `#!/usr/bin/env bash
${printsCode ? 'echo "000"' : ':'}
exit 7
`;
  fs.writeFileSync(stubPath, body);
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

/** Stub curl that never answers, to prove the hook does not wait on it. */
function makeHangingCurlStub(stubDir: string, seconds: number): string {
  fs.mkdirSync(stubDir, { recursive: true });
  const stubPath = path.join(stubDir, 'curl');
  fs.writeFileSync(stubPath, `#!/usr/bin/env bash\nsleep ${seconds}\necho "000"\nexit 28\n`);
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

/**
 * The dispatch is detached (TRA-694), so the stats line lands after the hook
 * has already exited. Poll for it instead of reading once.
 */
function readLastStat(traceHome: string, timeoutMs = 10_000): Record<string, unknown> {
  const statsFile = path.join(traceHome, 'hook-stats.jsonl');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(statsFile)) {
      const lines = fs
        .readFileSync(statsFile, 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0);
      if (lines.length > 0) return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    }
    if (Date.now() > deadline) throw new Error(`no stats line written to ${statsFile}`);
    execSync('sleep 0.05');
  }
}

function makeTraceMcpStub(stubDir: string): string {
  const stubPath = path.join(stubDir, 'trace-mcp');
  fs.writeFileSync(stubPath, '#!/usr/bin/env bash\nexit 0\n');
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

describe.skipIf(process.platform === 'win32')('trace-mcp-reindex.sh stats writer', () => {
  let tmpRoot: string;
  let traceHome: string;
  let stubDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-stats-test-'));
    traceHome = path.join(tmpRoot, 'home');
    stubDir = path.join(tmpRoot, 'bin');
    projectDir = path.join(tmpRoot, 'proj');
    fs.mkdirSync(traceHome, { recursive: true });
    fs.mkdirSync(stubDir, { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'foo.ts'), '// test\n');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes a daemon-path JSONL line when curl returns 2xx', () => {
    makeCurlStub(stubDir, '204');
    const filePath = path.join(projectDir, 'src', 'foo.ts');
    const stdin = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: filePath },
    });
    const res = runHook({ cwd: projectDir, stubDir, traceHome, stdin });
    expectCleanExit(res);

    const parsed = readLastStat(traceHome);
    expect(parsed.path).toBe('daemon');
    expect(parsed.reason).toBe('ok');
    expect(typeof parsed.ts).toBe('number');
    expect(typeof parsed.wallclock_ms).toBe('number');
  });

  it('writes a cli-path line with the failure reason when daemon refuses', () => {
    makeFailingCurlStub(stubDir);
    makeTraceMcpStub(stubDir);
    const filePath = path.join(projectDir, 'src', 'foo.ts');
    const stdin = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: filePath },
    });
    const res = runHook({ cwd: projectDir, stubDir, traceHome, stdin });
    expectCleanExit(res);

    const parsed = readLastStat(traceHome);
    expect(parsed.path).toBe('cli');
    expect(parsed.reason).toBe('no-daemon');
  });

  it('writes a skipped-path line when daemon refuses AND no trace-mcp CLI on PATH', () => {
    makeFailingCurlStub(stubDir);
    // No trace-mcp stub installed AND sanitized PATH so the global install
    // doesn't satisfy `command -v trace-mcp`.
    const filePath = path.join(projectDir, 'src', 'foo.ts');
    const stdin = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: filePath },
    });
    const res = runHook({ cwd: projectDir, stubDir, traceHome, stdin, sanitizePath: true });
    expectCleanExit(res);

    const parsed = readLastStat(traceHome);
    expect(parsed.path).toBe('skipped');
    expect(parsed.reason).toBe('no-daemon');
  });

  it('writes a cli-path line with reason=404 when daemon returns 404', () => {
    makeCurlStub(stubDir, '404');
    makeTraceMcpStub(stubDir);
    const filePath = path.join(projectDir, 'src', 'foo.ts');
    const stdin = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: filePath },
    });
    const res = runHook({ cwd: projectDir, stubDir, traceHome, stdin });
    expectCleanExit(res);

    const parsed = readLastStat(traceHome);
    expect(parsed.path).toBe('cli');
    expect(parsed.reason).toBe('404');
  });

  it('classifies a curl that prints 000 and exits non-zero as no-daemon', () => {
    // Guards the v0.5 fix: the old `|| echo "000"` turned this — real curl's
    // actual connection-refused behavior — into "000000" → reason "other".
    makeFailingCurlStub(stubDir, true);
    makeTraceMcpStub(stubDir);
    const filePath = path.join(projectDir, 'src', 'foo.ts');
    const res = runHook({
      cwd: projectDir,
      stubDir,
      traceHome,
      stdin: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath } }),
    });
    expectCleanExit(res);

    const parsed = readLastStat(traceHome);
    expect(parsed.reason).toBe('no-daemon');
  });

  it('returns without waiting for the daemon round trip', () => {
    // TRA-694: the dispatch is fire-and-forget. A daemon that accepts the
    // connection and never answers must cost the agent nothing — that case
    // alone burned 8,547 s of the 12,215 s measured before this fix.
    makeHangingCurlStub(stubDir, 10);
    makeTraceMcpStub(stubDir);
    const filePath = path.join(projectDir, 'src', 'foo.ts');
    const started = Date.now();
    const res = runHook({
      cwd: projectDir,
      stubDir,
      traceHome,
      stdin: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath } }),
    });
    const elapsed = Date.now() - started;
    expectCleanExit(res);
    // Loose bound: the hook itself spawns several subprocesses and CI is slow.
    // Anything under the stub's 10 s sleep proves it did not block on curl.
    expect(elapsed, `hook blocked for ${elapsed} ms on a hanging curl`).toBeLessThan(5_000);
  });

  it('does not error when stats home is read-only — best-effort write', () => {
    makeCurlStub(stubDir, '204');
    // Make stats home read-only.
    fs.chmodSync(traceHome, 0o555);
    const filePath = path.join(projectDir, 'src', 'foo.ts');
    const stdin = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: filePath },
    });
    try {
      const res = runHook({ cwd: projectDir, stubDir, traceHome, stdin });
      expectCleanExit(res);
    } finally {
      fs.chmodSync(traceHome, 0o755);
    }
  });
});
