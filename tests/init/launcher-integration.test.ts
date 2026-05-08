import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const LAUNCHER_SRC = path.resolve(__dirname, '..', '..', 'hooks', 'trace-mcp-launcher.sh');
const FIXTURES = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-it-'));

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runLauncher(env: Record<string, string>, args: string[] = ['serve']): RunResult {
  const result = spawnSync(LAUNCHER_SRC, args, {
    env: { ...env, PATH: '/usr/bin:/bin' }, // minimal PATH, no node visible
    encoding: 'utf-8',
    timeout: 5000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function setupFakeHome(): { home: string; traceHome: string; node: string; cli: string } {
  const home = fs.mkdtempSync(path.join(FIXTURES, 'home-'));
  const traceHome = path.join(home, '.trace-mcp');
  fs.mkdirSync(traceHome, { recursive: true });

  // Fake node that echoes its args so we can assert what the launcher exec'd.
  const node = path.join(home, 'fake-node');
  fs.writeFileSync(node, '#!/bin/bash\necho "NODE_ARGS:$*"\n', { mode: 0o755 });

  // Fake cli.js (content irrelevant — fake node never actually runs it)
  const cli = path.join(home, 'fake-cli.js');
  fs.writeFileSync(cli, '// fake cli\n');

  return { home, traceHome, node, cli };
}

function writeConfig(traceHome: string, node: string, cli: string) {
  fs.writeFileSync(
    path.join(traceHome, 'launcher.env'),
    [`TRACE_MCP_NODE="${node}"`, `TRACE_MCP_CLI="${cli}"`, 'TRACE_MCP_VERSION="0.0.0"', ''].join(
      '\n',
    ),
  );
}

beforeAll(() => {
  // Launcher must be executable — it is in the repo, but harden in case of fresh checkouts
  if (fs.existsSync(LAUNCHER_SRC)) fs.chmodSync(LAUNCHER_SRC, 0o755);
});

afterAll(() => {
  fs.rmSync(FIXTURES, { recursive: true, force: true });
});

// The POSIX launcher shim (sh) is meaningful only on macOS/Linux. The Windows
// equivalent is covered by tests/init/launcher-integration-windows.test.ts via
// cmd.exe + powershell. Skip this suite on win32.
describe.skipIf(process.platform === 'win32')('launcher shim integration', () => {
  it('happy path: valid config → execs node+cli with passed args', () => {
    const { home, traceHome, node, cli } = setupFakeHome();
    writeConfig(traceHome, node, cli);

    const { status, stdout, stderr } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, [
      'serve',
      '--foo',
      'bar',
    ]);

    expect(status).toBe(0);
    expect(stdout.trim()).toBe(`NODE_ARGS:${cli} serve --foo bar`);
    expect(stderr).toBe('');
  });

  it('env override wins over config', () => {
    const { home, traceHome, node, cli } = setupFakeHome();
    // config points at non-existent paths — override rescues it
    writeConfig(traceHome, '/nope/node', '/nope/cli.js');

    const { status, stdout } = runLauncher(
      {
        HOME: home,
        TRACE_MCP_HOME: traceHome,
        TRACE_MCP_NODE_OVERRIDE: node,
        TRACE_MCP_CLI_OVERRIDE: cli,
      },
      ['serve'],
    );

    expect(status).toBe(0);
    expect(stdout.trim()).toBe(`NODE_ARGS:${cli} serve`);
  });

  it('missing node/cli → exit 127 with recovery message', () => {
    const { home, traceHome } = setupFakeHome();
    // No config, no overrides, minimal PATH, fake HOME.
    // On a fully clean system this fails at "node not found"; on CI runners
    // with /usr/local/bin/node installed, the node probe succeeds and we
    // fail at "trace-mcp package not found" instead. Both are legitimate
    // outcomes of the same failure class — probe couldn't produce a working
    // pair — so the contract we assert is: exit 127 + recovery hint, not
    // the exact layer that tripped.
    const { status, stderr } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome });

    expect(status).toBe(127);
    expect(stderr).toMatch(/node binary not found|trace-mcp package not found/);
    expect(stderr).toContain('npm i -g trace-mcp');
  });

  it('injection attempt in config values is not evaluated', () => {
    const { home, traceHome } = setupFakeHome();
    // Sentinel file we check below — command substitution would create it
    const sentinel = path.join(home, 'PWNED');
    fs.writeFileSync(
      path.join(traceHome, 'launcher.env'),
      [
        `TRACE_MCP_NODE="/tmp/fake; touch ${sentinel}"`,
        `TRACE_MCP_CLI="$(touch ${sentinel}-sub)"`,
        '',
      ].join('\n'),
    );

    const { status } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome });

    // Launcher should fail (paths don't resolve to executables) but not execute
    expect(status).toBe(127);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(fs.existsSync(`${sentinel}-sub`)).toBe(false);
  });

  it('logs resolution to launcher.log', () => {
    const { home, traceHome, node, cli } = setupFakeHome();
    writeConfig(traceHome, node, cli);
    runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, ['serve']);

    const logPath = path.join(traceHome, 'launcher.log');
    expect(fs.existsSync(logPath)).toBe(true);
    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toContain('exec(config)');
    expect(log).toContain(`node=${node}`);
    expect(log).toContain(`cli=${cli}`);
  });

  it('stale config (broken paths) falls through to probe and still errors cleanly', () => {
    const { home, traceHome } = setupFakeHome();
    writeConfig(traceHome, '/nonexistent/node', '/nonexistent/cli.js');
    // Same environment-dependent outcome as above (see "missing node/cli").
    const { status, stderr } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome });

    expect(status).toBe(127);
    expect(stderr).toMatch(/node binary not found|trace-mcp package not found/);
  });
});
