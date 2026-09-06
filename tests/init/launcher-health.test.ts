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
} from '../../src/init/launcher.js';
import { checkRegisteredLaunchers } from '../../src/init/launcher-health.js';
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

describe.skipIf(process.platform === 'win32')('checkRegisteredLaunchers', () => {
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

  it('checks the path a client is actually registered at', () => {
    const dead = path.join(dir, 'bin', 'trace-mcp');
    fs.mkdirSync(path.dirname(dead));
    fs.symlinkSync(path.join(dir, 'gone'), dead);
    const checks = checkRegisteredLaunchers(config({ mcpServers: { trace: { command: dead } } }));
    expect(checks.find((c) => c.path === dead)?.status).toBe('dangling_symlink');
  });

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
