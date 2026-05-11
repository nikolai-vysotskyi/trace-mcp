import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOK = path.resolve('hooks/trace-mcp-reindex.sh');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
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
      timeout: 10_000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
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

function makeFailingCurlStub(stubDir: string): string {
  fs.mkdirSync(stubDir, { recursive: true });
  const stubPath = path.join(stubDir, 'curl');
  // Mimics curl's connection-refused behavior: writes nothing useful to
  // stdout and exits non-zero. The hook's "|| echo 000" branch then
  // substitutes the missing HTTP code.
  const body = `#!/usr/bin/env bash
exit 7
`;
  fs.writeFileSync(stubPath, body);
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
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
    expect(res.status).toBe(0);

    const statsFile = path.join(traceHome, 'hook-stats.jsonl');
    expect(fs.existsSync(statsFile)).toBe(true);
    const lines = fs
      .readFileSync(statsFile, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
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
    expect(res.status).toBe(0);

    const statsFile = path.join(traceHome, 'hook-stats.jsonl');
    const parsed = JSON.parse(
      fs.readFileSync(statsFile, 'utf-8').trim().split('\n').pop() as string,
    ) as Record<string, unknown>;
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
    expect(res.status).toBe(0);

    const statsFile = path.join(traceHome, 'hook-stats.jsonl');
    const parsed = JSON.parse(
      fs.readFileSync(statsFile, 'utf-8').trim().split('\n').pop() as string,
    ) as Record<string, unknown>;
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
    expect(res.status).toBe(0);

    const statsFile = path.join(traceHome, 'hook-stats.jsonl');
    const parsed = JSON.parse(
      fs.readFileSync(statsFile, 'utf-8').trim().split('\n').pop() as string,
    ) as Record<string, unknown>;
    expect(parsed.path).toBe('cli');
    expect(parsed.reason).toBe('404');
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
      expect(res.status).toBe(0);
    } finally {
      fs.chmodSync(traceHome, 0o755);
    }
  });
});
