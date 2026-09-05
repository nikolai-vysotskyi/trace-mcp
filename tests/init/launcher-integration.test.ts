import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepOrphanTmpFiles } from '../../src/utils/atomic-write.js';

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

function fakeNodeBody(version: string, marker = 'NODE_ARGS'): string {
  return `#!/bin/bash\nif [ "\${1:-}" = "-v" ]; then echo "v${version}"; exit 0; fi\necho "${marker}:$*"\n`;
}

function setupFakeHome(): { home: string; traceHome: string; node: string; cli: string } {
  const home = fs.mkdtempSync(path.join(FIXTURES, 'home-'));
  const traceHome = path.join(home, '.trace-mcp');
  fs.mkdirSync(traceHome, { recursive: true });

  // Fake node that echoes its args so we can assert what the launcher exec'd,
  // and answers `-v` like the real thing — the launcher version-gates node.
  const node = path.join(home, 'fake-node');
  fs.writeFileSync(node, fakeNodeBody('22.22.2'), { mode: 0o755 });

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

    // TRA-881: the backup fallback took whatever the glob listed first. The
    // suffix is the updater's PID, so name order is arbitrary — two crashed
    // updates could leave the client served an arbitrarily old build for the
    // whole session. Newest by mtime is the only meaningful ordering.
    it('prefers the newest backup when the swap window leaves several', () => {
      const { home, traceHome, node } = setupFakeHome();
      const root = path.join(home, '.nvm', 'versions', 'node', 'v22.22.2', 'lib', 'node_modules');
      // '4242' sorts before '999' by name, so a first-match pick loses here.
      for (const [name, body] of [
        ['trace-mcp.tmcp-bak-4242', '// stale old version\n'],
        ['trace-mcp.tmcp-bak-999', '// recent version\n'],
      ]) {
        fs.mkdirSync(path.join(root, name, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(root, name, 'dist', 'cli.js'), body);
      }
      const old = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(path.join(root, 'trace-mcp.tmcp-bak-4242'), old, old);
      const newestCli = fs.realpathSync(
        path.join(root, 'trace-mcp.tmcp-bak-999', 'dist', 'cli.js'),
      );
      fs.mkdirSync(path.join(home, '.nvm', 'alias'), { recursive: true });
      fs.writeFileSync(path.join(home, '.nvm', 'alias', 'default'), 'v22.22.2\n');
      const nvmBin = path.join(home, '.nvm', 'versions', 'node', 'v22.22.2', 'bin');
      fs.mkdirSync(nvmBin, { recursive: true });
      fs.writeFileSync(path.join(nvmBin, 'node'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });

      writeConfig(traceHome, node, path.join(root, 'trace-mcp', 'dist', 'cli.js'));

      const { status, stdout } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, ['serve']);

      expect(status).toBe(0);
      expect(stdout.trim()).toBe(`NODE_ARGS:${newestCli} serve`);
    });

    // npm rewrites its `.trace-mcp-<hex>` staging dir throughout the unpack, so
    // its mtime is almost always the newest thing in the root — and a cli.js
    // that exists there may still be mid-write. A complete backup wins even
    // when it is older (TRA-881).
    it('prefers a complete backup over npm\'s newer in-progress staging dir', () => {
      const { home, traceHome, node } = setupFakeHome();
      const root = path.join(home, '.nvm', 'versions', 'node', 'v22.22.2', 'lib', 'node_modules');
      for (const name of ['trace-mcp.tmcp-bak-4242', '.trace-mcp-deadbeef']) {
        fs.mkdirSync(path.join(root, name, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(root, name, 'dist', 'cli.js'), `// ${name}\n`);
      }
      const bakCli = fs.realpathSync(
        path.join(root, 'trace-mcp.tmcp-bak-4242', 'dist', 'cli.js'),
      );
      // Backdate the backup so a pure mtime sort would pick the staging dir.
      const old = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(path.join(root, 'trace-mcp.tmcp-bak-4242'), old, old);
      fs.mkdirSync(path.join(home, '.nvm', 'alias'), { recursive: true });
      fs.writeFileSync(path.join(home, '.nvm', 'alias', 'default'), 'v22.22.2\n');
      const nvmBin = path.join(home, '.nvm', 'versions', 'node', 'v22.22.2', 'bin');
      fs.mkdirSync(nvmBin, { recursive: true });
      fs.writeFileSync(path.join(nvmBin, 'node'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });

      writeConfig(traceHome, node, path.join(root, 'trace-mcp', 'dist', 'cli.js'));

      const { status, stdout } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, ['serve']);

      expect(status).toBe(0);
      expect(stdout.trim()).toBe(`NODE_ARGS:${bakCli} serve`);
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
      fs.writeFileSync(
        node,
        '#!/bin/bash\nif [ "${1:-}" = "-v" ]; then echo "v22.22.2"; exit 0; fi\necho "NODE_PATH_ENV:$PATH"\n',
        { mode: 0o755 },
      );
      writeConfig(traceHome, node, cli);

      const result = spawnSync(LAUNCHER_SRC, ['serve'], {
        env: { HOME: home, TRACE_MCP_HOME: traceHome, PATH: '/client/bin:/usr/bin:/bin' },
        encoding: 'utf-8',
        timeout: 5000,
      });

      expect(result.stdout.trim()).toBe('NODE_PATH_ENV:/client/bin:/usr/bin:/bin');
    });

    // TRA-755: cli.js needs the `engines.node` major. Under an older node it
    // dies on a SyntaxError the client can only report as "failed to connect",
    // and — worse — the launcher used to heal that node into launcher.env, so
    // every later start repeated it with a clean `exec` line in the log.
    describe('node version gate', () => {
      // Plants an nvm tree whose default alias is `version`, holding the package.
      function plantNvm(home: string, version: string): { node: string; cli: string } {
        const prefix = path.join(home, '.nvm', 'versions', 'node', `v${version}`);
        const bin = path.join(prefix, 'bin');
        fs.mkdirSync(bin, { recursive: true });
        const node = path.join(bin, 'node');
        fs.writeFileSync(node, fakeNodeBody(version), { mode: 0o755 });
        fs.mkdirSync(path.join(home, '.nvm', 'alias'), { recursive: true });
        fs.writeFileSync(path.join(home, '.nvm', 'alias', 'default'), `v${version}\n`);
        const dist = path.join(prefix, 'lib', 'node_modules', 'trace-mcp', 'dist');
        fs.mkdirSync(dist, { recursive: true });
        fs.writeFileSync(path.join(dist, 'cli.js'), '// fake cli\n');
        return { node, cli: fs.realpathSync(path.join(dist, 'cli.js')) };
      }

      // The probe also considers /opt/homebrew/bin/node and /usr/local/bin/node,
      // which are absolute and so escape the fake HOME — CI runners have a real
      // node there. Raising the required major above any real release is what
      // makes the probe tests below hermetic: every system node is rejected too,
      // and only the fake planted at v99 can win.
      const ABOVE_ANY_REAL = { TRACE_MCP_NODE_MIN_MAJOR: '99' };

      it('skips a too-old default node and fails loudly rather than silently', () => {
        const { home, traceHome } = setupFakeHome();
        plantNvm(home, '20.11.0');

        const { status, stderr } = runLauncher({
          HOME: home,
          TRACE_MCP_HOME: traceHome,
          ...ABOVE_ANY_REAL,
        });

        expect(status).toBe(127);
        expect(stderr).toContain('no Node.js >= 99 found');
        // Nothing may be pinned: the next start must be free to find a good node.
        expect(fs.existsSync(path.join(traceHome, 'launcher.env'))).toBe(false);
        expect(fs.readFileSync(path.join(traceHome, 'launcher.log'), 'utf-8')).toContain('ERROR');
      });

      it('prefers a supported node over an older one found first', () => {
        const { home, traceHome } = setupFakeHome();
        // Volta is probed before the nvm tree, and here it holds the old node.
        const volta = path.join(home, '.volta', 'bin');
        fs.mkdirSync(volta, { recursive: true });
        fs.writeFileSync(path.join(volta, 'node'), fakeNodeBody('18.20.0'), { mode: 0o755 });
        const { node, cli } = plantNvm(home, '99.0.0');

        const { status, stdout } = runLauncher(
          { HOME: home, TRACE_MCP_HOME: traceHome, ...ABOVE_ANY_REAL },
          ['serve'],
        );

        expect(status).toBe(0);
        expect(stdout.trim()).toBe(`NODE_ARGS:${cli} serve`);
        expect(fs.readFileSync(path.join(traceHome, 'launcher.env'), 'utf-8')).toContain(
          `TRACE_MCP_NODE="${node}"`,
        );
      });

      it('re-probes when launcher.env already pins an unsupported node', () => {
        const { home, traceHome, cli } = setupFakeHome();
        const old = path.join(home, 'old-node');
        fs.writeFileSync(old, fakeNodeBody('20.11.0'), { mode: 0o755 });
        writeConfig(traceHome, old, cli);
        const good = plantNvm(home, '99.0.0');

        const { status, stdout } = runLauncher(
          { HOME: home, TRACE_MCP_HOME: traceHome, ...ABOVE_ANY_REAL },
          ['serve'],
        );

        expect(status).toBe(0);
        expect(stdout.trim()).toBe(`NODE_ARGS:${cli} serve`);
        const cfg = fs.readFileSync(path.join(traceHome, 'launcher.env'), 'utf-8');
        expect(cfg).toContain(`TRACE_MCP_NODE="${good.node}"`);
        expect(cfg).not.toContain(old);
      });

      // Review of #831: the two override env vars shared one flag, so setting
      // only TRACE_MCP_CLI_OVERRIDE — a legitimate debugging move — carried the
      // configured node straight past the gate.
      it('a CLI-only override does not waive the gate for the configured node', () => {
        const { home, traceHome, cli } = setupFakeHome();
        const old = path.join(home, 'old-node');
        fs.writeFileSync(old, fakeNodeBody('20.11.0'), { mode: 0o755 });
        fs.writeFileSync(
          path.join(traceHome, 'launcher.env'),
          [
            `TRACE_MCP_NODE="${old}"`,
            `TRACE_MCP_CLI="${cli}"`,
            'TRACE_MCP_NODE_MAJOR="20"',
            '',
          ].join('\n'),
        );

        const { status, stdout } = runLauncher(
          {
            HOME: home,
            TRACE_MCP_HOME: traceHome,
            TRACE_MCP_CLI_OVERRIDE: cli,
            ...ABOVE_ANY_REAL,
          },
          ['serve'],
        );

        // Nothing supported to fall back to, so it must refuse — never exec the
        // Node 20 the config named.
        expect(status).toBe(127);
        expect(stdout).not.toContain('NODE_ARGS:');
      });

      // Review of #831: a digits-only but overflowing cached major made bash
      // arithmetic abort, so the `-lt` test failed and the gate failed OPEN.
      it.each([
        ['overflowing', '999999999999999999999999999999999999'],
        ['non-numeric', 'twenty'],
      ])('treats a %s cached major as missing and re-verifies', (_label, value) => {
        const { home, traceHome, cli } = setupFakeHome();
        const old = path.join(home, 'old-node');
        fs.writeFileSync(old, fakeNodeBody('20.11.0'), { mode: 0o755 });
        fs.writeFileSync(
          path.join(traceHome, 'launcher.env'),
          [
            `TRACE_MCP_NODE="${old}"`,
            `TRACE_MCP_CLI="${cli}"`,
            `TRACE_MCP_NODE_MAJOR="${value}"`,
            '',
          ].join('\n'),
        );

        const { status, stdout } = runLauncher(
          { HOME: home, TRACE_MCP_HOME: traceHome, ...ABOVE_ANY_REAL },
          ['serve'],
        );

        expect(status).toBe(127);
        expect(stdout).not.toContain('NODE_ARGS:');
      });

      // Same hazard from the other direction: the minimum itself is env input.
      it('falls back to the default minimum when the env override is garbage', () => {
        const { home, traceHome, node, cli } = setupFakeHome();
        writeConfig(traceHome, node, cli);

        const { status, stdout } = runLauncher(
          {
            HOME: home,
            TRACE_MCP_HOME: traceHome,
            TRACE_MCP_NODE_MIN_MAJOR: '99999999999999999999',
          },
          ['serve'],
        );

        // Default minimum is 22 and the fake node reports 22 — it must run,
        // not abort on an unusable comparison.
        expect(status).toBe(0);
        expect(stdout.trim()).toBe(`NODE_ARGS:${cli} serve`);
      });

      // Review of #831: the gate's own heal path skipped the "never persist an
      // override" rule, so verifying a legacy config under a temporary
      // TRACE_MCP_CLI_OVERRIDE baked that throwaway path into launcher.env and
      // every later start without the override used it.
      it('does not persist a CLI override while verifying a legacy config', () => {
        const { home, traceHome, node, cli } = setupFakeHome();
        writeConfig(traceHome, node, cli); // legacy: no recorded major
        const debugCli = path.join(home, 'debug-cli.js');
        fs.writeFileSync(debugCli, '// throwaway\n');

        const { status } = runLauncher(
          { HOME: home, TRACE_MCP_HOME: traceHome, TRACE_MCP_CLI_OVERRIDE: debugCli },
          ['serve'],
        );

        expect(status).toBe(0);
        const cfg = fs.readFileSync(path.join(traceHome, 'launcher.env'), 'utf-8');
        expect(cfg).not.toContain(debugCli);
        expect(cfg).toContain(`TRACE_MCP_CLI="${cli}"`);
      });

      it('caches the verified major so the next start spawns nothing extra', () => {
        const { home, traceHome, node, cli } = setupFakeHome();
        writeConfig(traceHome, node, cli); // legacy config: no recorded major

        runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, ['serve']);

        expect(fs.readFileSync(path.join(traceHome, 'launcher.env'), 'utf-8')).toContain(
          'TRACE_MCP_NODE_MAJOR="22"',
        );
        // Second start takes the fast path on the cached value alone.
        const { status, stdout } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, [
          'serve',
        ]);
        expect(status).toBe(0);
        expect(stdout.trim()).toBe(`NODE_ARGS:${cli} serve`);
      });
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

  // TRA-742: the mirror of TRA-701. `pkg_roots` learned about bundled runtimes
  // and custom npm prefixes, but `probe_node` never did — so a machine whose
  // ONLY node lives in such a prefix died with "node binary not found" while a
  // working node and cli.js sat right next to each other on disk.
  //
  // The two system paths the probe tries before anything under HOME are
  // absolute, so a runner that has Homebrew/system node installed resolves at
  // step 4a and never reaches the fallback under test.
  const HAS_SYSTEM_NODE =
    fs.existsSync('/opt/homebrew/bin/node') || fs.existsSync('/usr/local/bin/node');

  describe.skipIf(HAS_SYSTEM_NODE)('node resolves from a prefix only pkg_roots knows', () => {
    /** Plants a working node + package inside `prefix`, returns both realpaths. */
    function plantPrefix(prefix: string): { node: string; cli: string } {
      fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
      const node = path.join(prefix, 'bin', 'node');
      fs.writeFileSync(node, fakeNodeBody('22.22.2'), { mode: 0o755 });
      const dist = path.join(prefix, 'lib', 'node_modules', 'trace-mcp', 'dist');
      fs.mkdirSync(dist, { recursive: true });
      const cli = path.join(dist, 'cli.js');
      fs.writeFileSync(cli, '// bundled cli\n');
      return { node: fs.realpathSync(node), cli: fs.realpathSync(cli) };
    }

    it('uses the node recorded in pkg-roots when no standard node exists', () => {
      const { home, traceHome } = setupFakeHome();
      const prefix = path.join(home, 'some-bundled-runtime', 'node');
      const { cli } = plantPrefix(prefix);
      fs.writeFileSync(
        path.join(traceHome, 'pkg-roots'),
        `${path.join(prefix, 'lib', 'node_modules')}\n`,
      );
      writeConfig(traceHome, '/nonexistent/node', '/nonexistent/cli.js');

      const { status, stdout } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, ['serve']);

      expect(status).toBe(0);
      expect(stdout.trim()).toBe(`NODE_ARGS:${cli} serve`);
    });

    // Review of #831: node_from_pkg_roots returned after the first executable
    // it found. Combined with the version gate that let an old runtime in the
    // first root mask a supported node recorded in a later one.
    it('keeps looking past a too-old node in an earlier pkg-roots entry', () => {
      const { home, traceHome } = setupFakeHome();
      const oldPrefix = path.join(home, 'old-runtime', 'node');
      fs.mkdirSync(path.join(oldPrefix, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(oldPrefix, 'bin', 'node'), fakeNodeBody('20.11.0'), {
        mode: 0o755,
      });
      fs.mkdirSync(path.join(oldPrefix, 'lib', 'node_modules'), { recursive: true });
      const goodPrefix = path.join(home, 'new-runtime', 'node');
      const { cli } = plantPrefix(goodPrefix);
      fs.writeFileSync(
        path.join(traceHome, 'pkg-roots'),
        [
          path.join(oldPrefix, 'lib', 'node_modules'),
          path.join(goodPrefix, 'lib', 'node_modules'),
          '',
        ].join('\n'),
      );
      writeConfig(traceHome, '/nonexistent/node', '/nonexistent/cli.js');

      const { status, stdout } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, ['serve']);

      expect(status).toBe(0);
      expect(stdout.trim()).toBe(`NODE_ARGS:${cli} serve`);
    });

    it('uses the node bundled by Hermes when no standard node exists', () => {
      const { home, traceHome } = setupFakeHome();
      const { node, cli } = plantPrefix(path.join(home, '.hermes', 'node'));
      writeConfig(traceHome, '/nonexistent/node', '/nonexistent/cli.js');

      const { status, stdout } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, ['serve']);

      expect(status).toBe(0);
      expect(stdout.trim()).toBe(`NODE_ARGS:${cli} serve`);
      // And the healed config pins the pair, so the next start is a fast path.
      const cfg = fs.readFileSync(path.join(traceHome, 'launcher.env'), 'utf-8');
      expect(cfg).toContain(`TRACE_MCP_NODE="${node}"`);
    });

    it('uses the node under a custom npm prefix from ~/.npmrc', () => {
      const { home, traceHome } = setupFakeHome();
      const prefix = path.join(home, 'custom-prefix');
      const { cli } = plantPrefix(prefix);
      fs.writeFileSync(path.join(home, '.npmrc'), `prefix=${prefix}\n`);
      writeConfig(traceHome, '/nonexistent/node', '/nonexistent/cli.js');

      const { status, stdout } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, ['serve']);

      expect(status).toBe(0);
      expect(stdout.trim()).toBe(`NODE_ARGS:${cli} serve`);
    });

    it('still exits 127 when no prefix holds a node', () => {
      const { home, traceHome } = setupFakeHome();
      fs.writeFileSync(path.join(traceHome, 'pkg-roots'), `${path.join(home, 'gone')}\n`);
      const { status, stderr } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, ['serve']);

      expect(status).toBe(127);
      expect(stderr).toContain('node binary not found');
    });
  });

  // A standard node must keep winning: the fallback is a last resort, not a
  // reordering of the probe.
  it('prefers an nvm default node over one found via pkg-roots', () => {
    const { home, traceHome } = setupFakeHome();
    const nvmBin = path.join(home, '.nvm', 'versions', 'node', 'v22.22.2', 'bin');
    fs.mkdirSync(nvmBin, { recursive: true });
    fs.writeFileSync(path.join(nvmBin, 'node'), fakeNodeBody('22.22.2', 'NVM_NODE'), {
      mode: 0o755,
    });
    fs.mkdirSync(path.join(home, '.nvm', 'alias'), { recursive: true });
    fs.writeFileSync(path.join(home, '.nvm', 'alias', 'default'), 'v22.22.2\n');

    const bundled = path.join(home, '.hermes', 'node');
    fs.mkdirSync(path.join(bundled, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(bundled, 'bin', 'node'), fakeNodeBody('22.22.2', 'BUNDLED'), {
      mode: 0o755,
    });
    const dist = path.join(bundled, 'lib', 'node_modules', 'trace-mcp', 'dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'cli.js'), '// bundled cli\n');
    writeConfig(traceHome, '/nonexistent/node', '/nonexistent/cli.js');

    const { status, stdout } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome }, ['serve']);

    expect(status).toBe(0);
    // Whichever standard node the probe picked, it is not the bundled one.
    expect(stdout).not.toContain('BUNDLED:');
  });

  it('stale config (broken paths) falls through to probe and still errors cleanly', () => {
    const { home, traceHome } = setupFakeHome();
    writeConfig(traceHome, '/nonexistent/node', '/nonexistent/cli.js');
    // Same environment-dependent outcome as above (see "missing node/cli").
    const { status, stderr } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome });

    expect(status).toBe(127);
    expect(stderr).toMatch(/node binary not found|trace-mcp package not found/);
  });

  // Anything bash itself prints when the shim mishandles a failure: the
  // `set -u` abort, the failed read, the failed redirection. The launcher's
  // own `die` message is not in here — that one is deliberate output.
  const SHELL_DIAGNOSTIC = /unbound variable|read error|Permission denied|Is a directory/;

  // Both TRA-797 cases below need a run that actually reaches heal_config: an
  // empty config, and a prefix the probe can find node + cli.js in.
  function setupHealingHome(): { home: string; traceHome: string } {
    const home = fs.mkdtempSync(path.join(FIXTURES, 'heal-'));
    const traceHome = path.join(home, '.trace-mcp');
    const pkgDist = path.join(home, 'prefix', 'lib', 'node_modules', 'trace-mcp', 'dist');
    fs.mkdirSync(traceHome, { recursive: true });
    fs.mkdirSync(pkgDist, { recursive: true });
    fs.mkdirSync(path.join(home, 'prefix', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, 'prefix', 'bin', 'node'), fakeNodeBody('22.22.2'), {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(pkgDist, 'cli.js'), '// fake cli\n');
    fs.writeFileSync(
      path.join(traceHome, 'pkg-roots'),
      `${path.join(home, 'prefix', 'lib', 'node_modules')}\n`,
    );
    return { home, traceHome };
  }

  // A config the shim cannot read is not an empty config: the first `read`
  // fails, and under `set -u` a bare `$key` in the loop condition used to
  // abort the shim with exit 1 and a raw bash error — no recovery message,
  // no probe fallback, a dead server for the rest of the session (TRA-797).
  // A directory at the config path is the reproducible stand-in for the I/O
  // errors (network mounts, half-written files) that trip the same path.
  it('an unreadable config falls through to the probe instead of aborting', () => {
    const { home, traceHome } = setupHealingHome();
    fs.mkdirSync(path.join(traceHome, 'launcher.env'));

    const { status, stderr } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome });

    // Which node the probe lands on depends on the machine (a CI runner has a
    // system node the planted prefix cannot outrank), so assert the behaviour
    // that is the point: the shim reaches an exec instead of aborting, and
    // says nothing the client would read as a crash.
    expect(status).toBe(0);
    expect(stderr).not.toMatch(SHELL_DIAGNOSTIC);
  });

  // The heal writes launcher.env through a tmp + rename, and `mv` onto a
  // DIRECTORY moves the tmp inside it rather than over it. So a directory at
  // the config path used to make every single start deposit another orphan
  // there — unbounded, and collected by nothing: the state sweeper only reads
  // the directories it knows by name, and `launcher.env/` is not one of them
  // (TRA-829). The heal has to refuse instead, loudly enough to be found by
  // the one diagnostic a user is told to run: grep ERROR launcher.log.
  it('refuses to heal onto a config path that is not a regular file', () => {
    const { home, traceHome } = setupHealingHome();
    const configDir = path.join(traceHome, 'launcher.env');
    fs.mkdirSync(configDir);

    for (let i = 0; i < 3; i++) runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome });

    expect(fs.readdirSync(configDir)).toEqual([]);
    expect(sweepOrphanTmpFiles(configDir, 0)).toEqual([]);
    const log = fs.readFileSync(path.join(traceHome, 'launcher.log'), 'utf-8');
    expect(log).toContain(`ERROR: ${configDir} is not a regular file`);
  });

  // A shim killed between the heal's write and its rename still leaks its tmp
  // into the state home, where only sweepOrphanTmpFiles collects it — so the
  // name has to carry the `.tmp.<pid>.<12 hex>` suffix that sweeper matches on.
  // Before TRA-797 it was `.tmp.<pid>`, which never matched. The window is too
  // narrow to hit from a test, so the name is asserted where it is built.
  it('builds its heal tmp with a name the orphan sweeper collects', () => {
    expect(fs.readFileSync(LAUNCHER_SRC, 'utf-8')).toContain(
      `tmp="$CONFIG.tmp.$$.$(printf '%04x%04x%04x'`,
    );
    // The same shape, resolved — this is what the sweeper is handed on disk.
    const dir = fs.mkdtempSync(path.join(FIXTURES, 'tmpname-'));
    const sample = path.join(dir, `launcher.env.tmp.${process.pid}.0123456789ab`);
    fs.writeFileSync(sample, '');
    // Negative age: cutoff in the future, so a file written a moment ago counts.
    expect(sweepOrphanTmpFiles(dir, -1000)).toEqual([sample]);
  });

  // A state home the shim cannot write to (read-only volume, root-owned
  // ~/.trace after a sudo install) used to make the log append and the heal's
  // failed redirection print raw shell errors into the client's stderr on
  // EVERY start — a healthy server that reads as broken in the client's log.
  it('an unwritable state home does not leak shell errors into client stderr', () => {
    const { home, traceHome } = setupHealingHome();
    fs.chmodSync(traceHome, 0o500);
    try {
      const { status, stderr } = runLauncher({ HOME: home, TRACE_MCP_HOME: traceHome });
      expect(status).toBe(0);
      expect(stderr).not.toMatch(SHELL_DIAGNOSTIC);
    } finally {
      fs.chmodSync(traceHome, 0o700);
    }
  });
});
