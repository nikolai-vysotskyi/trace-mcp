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

  // TRA-701: node and cli.js must resolve independently. Before v0.4.0 the cli
  // was only ever looked for next to the selected node, so a machine with the
  // package in a different npm prefix lost the MCP server outright (3576 fatal
  // launcher errors in the field).
  describe('cli.js resolves independently of the selected node', () => {
    // Plants an nvm-layout tree under the fake HOME holding node + the package,
    // so the probe has a prefix to find that is NOT the configured node's.
    function plantNvmPackage(home: string, cliBody = '// fake cli\n'): string {
      const version = 'v22.22.2';
      const prefix = path.join(home, '.nvm', 'versions', 'node', version);
      fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(prefix, 'bin', 'node'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
      fs.mkdirSync(path.join(home, '.nvm', 'alias'), { recursive: true });
      fs.writeFileSync(path.join(home, '.nvm', 'alias', 'default'), `${version}\n`);
      const pkgDir = path.join(prefix, 'lib', 'node_modules', 'trace-mcp', 'dist');
      fs.mkdirSync(pkgDir, { recursive: true });
      const cli = path.join(pkgDir, 'cli.js');
      fs.writeFileSync(cli, cliBody);
      // The launcher normalises probed paths through realpath; on macOS the
      // temp dir lives behind the /var → /private/var symlink, so compare
      // against the resolved form.
      return fs.realpathSync(cli);
    }

    it('finds the package in another prefix when the configured node has none', () => {
      const { home, traceHome, node } = setupFakeHome();
      const otherCli = plantNvmPackage(home);
      // Configured node is fine; its own prefix carries no trace-mcp package.
      writeConfig(traceHome, node, path.join(home, 'gone', 'cli.js'));

      const { status, stdout } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, ['serve']);

      expect(status).toBe(0);
      expect(stdout.trim()).toBe(`NODE_ARGS:${otherCli} serve`);
    });

    it('rewrites launcher.env with the probed pair so the next start is fast', () => {
      const { home, traceHome, node } = setupFakeHome();
      const otherCli = plantNvmPackage(home);
      writeConfig(traceHome, node, path.join(home, 'gone', 'cli.js'));

      runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, ['serve']);

      const cfg = fs.readFileSync(path.join(traceHome, 'launcher.env'), 'utf-8');
      expect(cfg).toContain(`TRACE_MCP_NODE="${node}"`);
      expect(cfg).toContain(`TRACE_MCP_CLI="${otherCli}"`);
      // Header must keep the trusted-emitter provenance marker (env-classifier).
      expect(cfg.split('\n')[0]).toMatch(/^# Managed by trace-mcp\b/);
      // Second run now takes the config fast path.
      const { stdout } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, ['serve']);
      expect(stdout.trim()).toBe(`NODE_ARGS:${otherCli} serve`);
      expect(fs.readFileSync(path.join(traceHome, 'launcher.log'), 'utf-8')).toContain(
        'exec(config)',
      );
    });

    it('does not persist env overrides into launcher.env', () => {
      const { home, traceHome, node, cli } = setupFakeHome();
      // No config at all — overrides carry the run.
      const { status } = runLauncher(
        {
          HOME: home,
          TRACE_MCP_HOME: traceHome,
          TRACE_MCP_NODE_OVERRIDE: node,
          TRACE_MCP_CLI_OVERRIDE: cli,
        },
        ['serve'],
      );

      expect(status).toBe(0);
      expect(fs.existsSync(path.join(traceHome, 'launcher.env'))).toBe(false);
    });

    it('survives the npm swap window via the renamed-aside package dir', () => {
      const { home, traceHome, node } = setupFakeHome();
      // Package root exists but `trace-mcp/` is mid-rename: only the backup
      // directory our updater leaves behind is on disk.
      const root = path.join(home, '.nvm', 'versions', 'node', 'v22.22.2', 'lib', 'node_modules');
      const bakDir = path.join(root, 'trace-mcp.tmcp-bak-4242', 'dist');
      fs.mkdirSync(bakDir, { recursive: true });
      fs.writeFileSync(path.join(bakDir, 'cli.js'), '// previous version\n');
      const bakCli = fs.realpathSync(path.join(bakDir, 'cli.js'));
      fs.mkdirSync(path.join(home, '.nvm', 'alias'), { recursive: true });
      fs.writeFileSync(path.join(home, '.nvm', 'alias', 'default'), 'v22.22.2\n');
      const nvmBin = path.join(home, '.nvm', 'versions', 'node', 'v22.22.2', 'bin');
      fs.mkdirSync(nvmBin, { recursive: true });
      fs.writeFileSync(path.join(nvmBin, 'node'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });

      writeConfig(traceHome, node, path.join(root, 'trace-mcp', 'dist', 'cli.js'));

      const { status, stdout } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, ['serve']);

      expect(status).toBe(0);
      expect(stdout.trim()).toBe(`NODE_ARGS:${bakCli} serve`);
      // The backup directory is about to be deleted — pinning the config to it
      // would only buy a dangling fast path on the next start.
      expect(fs.existsSync(path.join(traceHome, 'launcher.env'))).toBe(true);
      expect(fs.readFileSync(path.join(traceHome, 'launcher.env'), 'utf-8')).not.toContain(
        'tmcp-bak',
      );
    });

    it.skipIf(process.platform === 'win32')('keeps the healed launcher.env at 0600', () => {
      const { home, traceHome, node } = setupFakeHome();
      plantNvmPackage(home);
      writeConfig(traceHome, node, path.join(home, 'gone', 'cli.js'));
      fs.chmodSync(path.join(traceHome, 'launcher.env'), 0o600);

      runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, ['serve']);

      const mode = fs.statSync(path.join(traceHome, 'launcher.env')).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    // A repository-controlled `node_modules/.bin` is a normal thing to sit on
    // an MCP client's PATH. None of the helpers the shim runs may resolve to it.
    it.each(['npm', 'sed', 'date', 'head', 'ls', 'realpath', 'mv', 'dirname'])(
      'never executes a hostile %s found on PATH',
      (helper) => {
        const { home, traceHome, node } = setupFakeHome();
        plantNvmPackage(home);
        const hostileBin = path.join(home, `hostile-bin-${helper}`);
        fs.mkdirSync(hostileBin, { recursive: true });
        const sentinel = path.join(home, `RAN_${helper}`);
        fs.writeFileSync(path.join(hostileBin, helper), `#!/bin/bash\ntouch ${sentinel}\n`, {
          mode: 0o755,
        });
        // A prefix line makes the shim read ~/.npmrc, exercising that branch too.
        fs.writeFileSync(path.join(home, '.npmrc'), `prefix=${path.join(home, 'nowhere')}\n`);
        writeConfig(traceHome, node, path.join(home, 'gone', 'cli.js'));

        const result = spawnSync(LAUNCHER_SRC, ['serve'], {
          env: { HOME: home, TRACE_MCP_HOME: traceHome, PATH: `${hostileBin}:/usr/bin:/bin` },
          encoding: 'utf-8',
          timeout: 5000,
        });

        expect(result.status).toBe(0);
        expect(fs.existsSync(sentinel)).toBe(false);
      },
    );

    it('hands the client PATH back to node, not the sanitised one', () => {
      const { home, traceHome, cli } = setupFakeHome();
      // The server itself needs the client's PATH to find git, LSP servers, npm.
      const node = path.join(home, 'path-echo-node');
      fs.writeFileSync(node, '#!/bin/bash\necho "NODE_PATH_ENV:$PATH"\n', { mode: 0o755 });
      writeConfig(traceHome, node, cli);

      const result = spawnSync(LAUNCHER_SRC, ['serve'], {
        env: { HOME: home, TRACE_MCP_HOME: traceHome, PATH: '/client/bin:/usr/bin:/bin' },
        encoding: 'utf-8',
        timeout: 5000,
      });

      expect(result.stdout.trim()).toBe('NODE_PATH_ENV:/client/bin:/usr/bin:/bin');
    });

    it('finds the package in a bundled runtime prefix recorded by a past install', () => {
      const { home, traceHome, node } = setupFakeHome();
      // Prefixes like this are on no standard list — the only way the shim can
      // know about them is the registry each install appends to.
      const root = path.join(home, 'some-bundled-runtime', 'node', 'lib', 'node_modules');
      fs.mkdirSync(path.join(root, 'trace-mcp', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(root, 'trace-mcp', 'dist', 'cli.js'), '// bundled cli\n');
      const cli = fs.realpathSync(path.join(root, 'trace-mcp', 'dist', 'cli.js'));
      fs.writeFileSync(path.join(traceHome, 'pkg-roots'), `# recorded by install\n${root}\n`);
      writeConfig(traceHome, node, path.join(home, 'gone', 'cli.js'));

      const { status, stdout } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, ['serve']);

      expect(status).toBe(0);
      expect(stdout.trim()).toBe(`NODE_ARGS:${cli} serve`);
    });

    it('finds the package in a Hermes bundled node prefix', () => {
      const { home, traceHome, node } = setupFakeHome();
      // The prefix on the machine that reported TRA-701: node bundled by the
      // runtime, package installed into it, named by no standard layout.
      const dist = path.join(home, '.hermes', 'node', 'lib', 'node_modules', 'trace-mcp', 'dist');
      fs.mkdirSync(dist, { recursive: true });
      fs.writeFileSync(path.join(dist, 'cli.js'), '// hermes cli\n');
      const cli = fs.realpathSync(path.join(dist, 'cli.js'));
      writeConfig(traceHome, node, path.join(home, 'gone', 'cli.js'));

      const { status, stdout } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, ['serve']);

      expect(status).toBe(0);
      expect(stdout.trim()).toBe(`NODE_ARGS:${cli} serve`);
    });

    it('honours a custom npm prefix from ~/.npmrc without running npm', () => {
      const { home, traceHome, node } = setupFakeHome();
      const prefix = path.join(home, 'custom-prefix');
      const pkgDir = path.join(prefix, 'lib', 'node_modules', 'trace-mcp', 'dist');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'cli.js'), '// custom prefix cli\n');
      const cli = fs.realpathSync(path.join(pkgDir, 'cli.js'));
      fs.writeFileSync(path.join(home, '.npmrc'), `prefix=${prefix}\n`);
      writeConfig(traceHome, node, path.join(home, 'gone', 'cli.js'));

      const { status, stdout } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, ['serve']);

      expect(status).toBe(0);
      expect(stdout.trim()).toBe(`NODE_ARGS:${cli} serve`);
    });
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
