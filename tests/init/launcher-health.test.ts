/**
 * Every failure mode that kills a client *before* the shim runs — so nothing
 * ever reaches launcher.log and a log-only health check reports zero errors
 * during a total outage (TRA-913).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkLauncherFile,
  getLauncherPath,
  installLauncher,
  isBroken,
  legacyCompatCmdBody,
} from '../../src/init/launcher.js';
import {
  checkRegisteredLaunchers,
  launcherConfigLocations,
} from '../../src/init/launcher-health.js';
import { ALL_MCP_CLIENT_NAMES, getConfigPath } from '../../src/init/mcp-client.js';
import { LAUNCHER_VERSION } from '../../src/init/types.js';

const SHIM = `#!/bin/bash\n# trace-mcp-launcher v${LAUNCHER_VERSION}\nexit 0\n`;

describe.skipIf(process.platform === 'win32')('checkLauncherFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-health-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, mode = 0o755): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, SHIM, { mode });
    fs.chmodSync(p, mode);
    return p;
  }

  it('accepts an executable shim we wrote', () => {
    const check = checkLauncherFile(write('trace'));
    expect(check.status).toBe('ok');
    expect(isBroken(check.status)).toBe(false);
  });

  it('reports a missing path', () => {
    expect(checkLauncherFile(path.join(dir, 'nope')).status).toBe('missing');
  });

  it('reports a dangling symlink instead of trusting it', () => {
    const link = path.join(dir, 'legacy');
    fs.symlinkSync(path.join(dir, 'gone'), link);
    const check = checkLauncherFile(link);
    expect(check.status).toBe('dangling_symlink');
    expect(check.detail).toContain('gone');
  });

  it('follows a live symlink to its target', () => {
    const link = path.join(dir, 'legacy');
    fs.symlinkSync(write('trace'), link);
    expect(checkLauncherFile(link).status).toBe('ok');
  });

  it('reports a directory at the launcher path', () => {
    const p = path.join(dir, 'trace');
    fs.mkdirSync(p);
    expect(checkLauncherFile(p).status).toBe('not_a_file');
  });

  it('reports a shim that lost its execute bit', () => {
    expect(checkLauncherFile(write('trace', 0o644)).status).toBe('not_executable');
  });

  it('flags a file that is not ours without calling it broken', () => {
    const p = path.join(dir, 'wrapper');
    fs.writeFileSync(p, '#!/bin/sh\nexec my-own-thing\n', { mode: 0o755 });
    const check = checkLauncherFile(p);
    expect(check.status).toBe('foreign');
    expect(isBroken(check.status)).toBe(false);
  });

  it('does not guess at a PATH-resolved command name', () => {
    expect(checkLauncherFile('npx').status).toBe('unchecked');
  });
});

describe('checkRegisteredLaunchers', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-registered-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function config(content: unknown): { clientName: string; configPath: string }[] {
    const configPath = path.join(dir, 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify(content));
    return [{ clientName: 'claude-code', configPath }];
  }

  function raw(name: string, text: string): { clientName: string; configPath: string }[] {
    const configPath = path.join(dir, name);
    fs.writeFileSync(configPath, text);
    return [{ clientName: 'other', configPath }];
  }

  it.skipIf(process.platform === 'win32')(
    'checks the path a client is actually registered at',
    () => {
      const dead = path.join(dir, 'bin', 'trace-mcp');
      fs.mkdirSync(path.dirname(dead));
      fs.symlinkSync(path.join(dir, 'gone'), dead);
      const checks = checkRegisteredLaunchers(config({ mcpServers: { trace: { command: dead } } }));
      expect(checks.find((c) => c.path === dead)?.status).toBe('dangling_symlink');
    },
  );

  it('reads the legacy server key too', () => {
    const checks = checkRegisteredLaunchers(
      config({ mcpServers: { 'trace-mcp': { command: path.join(dir, 'nope') } } }),
    );
    expect(checks.some((c) => c.path === path.join(dir, 'nope'))).toBe(true);
  });

  it('reads per-project entries in ~/.claude.json', () => {
    const cmd = path.join(dir, 'proj-launcher');
    const checks = checkRegisteredLaunchers(
      config({ projects: { '/some/repo': { mcpServers: { trace: { command: cmd } } } } }),
    );
    expect(checks.find((c) => c.path === cmd)?.status).toBe('missing');
  });

  it('reads a Codex TOML section', () => {
    const cmd = path.join(dir, 'codex-launcher');
    const checks = checkRegisteredLaunchers(
      raw(
        'config.toml',
        `[other]\ncommand = "unrelated"\n\n[mcp_servers.trace]\ncommand = "${cmd}"\nargs = []\n\n[mcp_servers.other]\ncommand = "nope"\n`,
      ),
    );
    expect(checks.map((c) => c.path)).toContain(cmd);
    expect(checks.map((c) => c.path)).not.toContain('nope');
  });

  it('reads a Hermes YAML block', () => {
    const cmd = path.join(dir, 'hermes-launcher');
    const checks = checkRegisteredLaunchers(
      raw('config.yaml', `mcp_servers:\n  trace:\n    command: ${cmd}\n    args: []\n`),
    );
    expect(checks.map((c) => c.path)).toContain(cmd);
  });

  it("reads AMP's literal-dot key out of commented JSONC", () => {
    const cmd = path.join(dir, 'amp-launcher');
    const checks = checkRegisteredLaunchers(
      raw(
        'settings.jsonc',
        `{\n  // a comment JSON.parse would choke on\n  "amp.mcpServers": { "trace": { "command": "${cmd}" } }\n}\n`,
      ),
    );
    expect(checks.map((c) => c.path)).toContain(cmd);
  });

  it('always includes the installed launcher path, even with no client configured', () => {
    const checks = checkRegisteredLaunchers([]);
    expect(checks).toHaveLength(1);
    expect(checks[0].configPath).toBe('(installed launcher)');
  });

  it('ignores malformed and absent config files', () => {
    const bad = path.join(dir, 'broken.json');
    fs.writeFileSync(bad, '{ not json');
    const checks = checkRegisteredLaunchers([
      { clientName: 'cursor', configPath: bad },
      { clientName: 'cursor', configPath: path.join(dir, 'absent.json') },
    ]);
    expect(checks).toHaveLength(1);
  });

  it('reports one finding per path when two clients share it', () => {
    const cmd = path.join(dir, 'shared');
    const a = path.join(dir, 'a.json');
    const b = path.join(dir, 'b.json');
    for (const f of [a, b])
      fs.writeFileSync(f, JSON.stringify({ mcpServers: { trace: { command: cmd } } }));
    const checks = checkRegisteredLaunchers([
      { clientName: 'cursor', configPath: a },
      { clientName: 'windsurf', configPath: b },
    ]);
    expect(checks.filter((c) => c.path === cmd)).toHaveLength(1);
  });
});

describe.skipIf(process.platform === 'win32')('installLauncher repairs an unspawnable shim', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-home-'));
    prevHome = process.env.TRACE_MCP_HOME;
    process.env.TRACE_MCP_HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.TRACE_MCP_HOME;
    else process.env.TRACE_MCP_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('reinstalls a current-version shim that lost its execute bit', () => {
    installLauncher({});
    const dest = getLauncherPath();
    fs.chmodSync(dest, 0o644);
    expect(checkLauncherFile(dest).status).toBe('not_executable');

    // Version alone still reads current — only the file check catches this.
    const result = installLauncher({});
    expect(result.action).not.toBe('already_configured');
    expect(checkLauncherFile(dest).status).toBe('ok');
  });

  it('still skips the rewrite when the shim is healthy', () => {
    installLauncher({});
    expect(installLauncher({}).action).toBe('already_configured');
  });
});

/**
 * A shim can carry the current version header, be executable, and still never
 * run a line — the reviewer's case on #988. Nothing about it reaches
 * launcher.log, so it has to be caught here or not at all.
 */
describe.skipIf(process.platform === 'win32')('unspawnable but well-formed shims', () => {
  let dir: string;
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-interp-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-home-'));
    prevHome = process.env.TRACE_MCP_HOME;
    process.env.TRACE_MCP_HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.TRACE_MCP_HOME;
    else process.env.TRACE_MCP_HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  function shim(shebang: string): string {
    const p = path.join(dir, 'trace');
    fs.writeFileSync(p, `${shebang}\n# trace-mcp-launcher v${LAUNCHER_VERSION}\nexit 0\n`, {
      mode: 0o755,
    });
    fs.chmodSync(p, 0o755);
    return p;
  }

  it('reports an absolute interpreter that is not installed', () => {
    const check = checkLauncherFile(shim('#!/nope/bin/bash'));
    expect(check.status).toBe('broken_interpreter');
    expect(check.detail).toContain('/nope/bin/bash');
  });

  it('reports an env-resolved interpreter that is not on PATH', () => {
    expect(checkLauncherFile(shim('#!/usr/bin/env definitely-not-a-real-shell')).status).toBe(
      'broken_interpreter',
    );
  });

  it('accepts the interpreter the shipped shim actually uses', () => {
    expect(checkLauncherFile(shim('#!/bin/sh')).status).toBe('ok');
  });

  it('trace init rewrites a current-version shim whose interpreter is gone', () => {
    installLauncher({});
    const dest = getLauncherPath();
    const body = fs.readFileSync(dest, 'utf-8').replace(/^#![^\n]*/, '#!/nope/bin/bash');
    fs.writeFileSync(dest, body, { mode: 0o755 });
    expect(checkLauncherFile(dest).status).toBe('broken_interpreter');

    expect(installLauncher({}).action).not.toBe('already_configured');
    expect(checkLauncherFile(dest).status).toBe('ok');
  });
});

/**
 * The Windows compat shim delegates by exec instead of by symlink, so its
 * equivalent of a dangling link is a quoted path that no longer exists. Checked
 * on every platform: the file is text either way, and the Windows CI job is
 * conditional.
 */
describe('windows compat shim delegate', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-delegate-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function cmd(target: string): string {
    const p = path.join(dir, 'trace-mcp.cmd');
    fs.writeFileSync(p, legacyCompatCmdBody(target), { mode: 0o755 });
    fs.chmodSync(p, 0o755);
    return p;
  }

  it('reports a delegate target that is gone', () => {
    const gone = path.join(dir, 'gone', 'trace.cmd');
    const check = checkLauncherFile(cmd(gone));
    expect(check.status).toBe('broken_delegate');
    expect(check.detail).toContain(gone);
  });

  it('accepts a delegate target that exists', () => {
    const target = path.join(dir, 'trace.cmd');
    fs.writeFileSync(target, legacyCompatCmdBody('x'), { mode: 0o755 });
    expect(checkLauncherFile(cmd(target)).status).toBe('ok');
  });
});

describe('config discovery covers every supported client', () => {
  it('finds a config file for every client that has one', () => {
    const found = new Set(launcherConfigLocations('/tmp/some-project').map((l) => l.clientName));
    for (const name of ALL_MCP_CLIENT_NAMES) {
      const hasConfig =
        getConfigPath(name, '/tmp/some-project', 'global') !== null ||
        getConfigPath(name, '/tmp/some-project', 'project') !== null;
      expect(hasConfig ? found.has(name) : !found.has(name)).toBe(true);
    }
  });
});
