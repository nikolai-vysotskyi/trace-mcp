/**
 * The pre-TRA-611 launcher path `~/.trace-mcp/bin/trace-mcp` stays registered in
 * MCP client configs long after the home directory was renamed to `~/.trace`.
 * Whatever sits at that path is what the client actually spawns, so it must not
 * be allowed to freeze at the launcher version that happened to be on disk when
 * the rename ran — every later launcher fix would miss those clients entirely.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLauncherPath,
  installLauncher,
  legacyCompatCmdBody,
} from '../../src/init/launcher.js';
import { LAUNCHER_VERSION } from '../../src/init/types.js';

const STALE_SHIM = '#!/bin/bash\n# trace-mcp-launcher v0.3.0\nexit 127\n';

// Windows cannot use a symlink here without privileges the installer usually
// lacks, so the legacy .cmd delegates by exec. Asserted on every platform:
// the Windows CI job is conditional, and this is the shim clients would spawn.
describe('windows legacy compat shim', () => {
  const body = legacyCompatCmdBody('C:\\Users\\x\\.trace\\bin\\trace.cmd');

  it('delegates to the current launcher and forwards all arguments', () => {
    expect(body).toContain('"C:\\Users\\x\\.trace\\bin\\trace.cmd" %*');
  });

  it('carries the launcher header so a later run recognises it as ours', () => {
    expect(body).toMatch(/trace-mcp-launcher v[0-9]+\.[0-9]+\.[0-9]+/);
    expect(body.split(/\r?\n/)[0]).toBe('@echo off');
  });

  it('uses CRLF line endings', () => {
    expect(body).toContain('\r\n');
    expect(body).not.toMatch(/[^\r]\n/);
  });
});

describe.skipIf(process.platform === 'win32')('legacy bin compat', () => {
  let home: string;
  let legacyPath: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-legacy-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    legacyPath = path.join(home, '.trace-mcp', 'bin', 'trace-mcp');
    // The launcher installs into ~/.trace; leaving TRACE_MCP_HOME unset keeps
    // the legacy and current homes distinct, as they are on a migrated machine.
    delete process.env.TRACE_MCP_HOME;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeLegacy(content: string): void {
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, content, { mode: 0o755 });
  }

  it('repoints a stale trace-mcp-owned shim at the current launcher', () => {
    writeLegacy(STALE_SHIM);

    installLauncher({ force: true });

    expect(fs.lstatSync(legacyPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(legacyPath)).toBe(fs.realpathSync(getLauncherPath()));
    // What a client spawning the legacy path now actually runs.
    expect(fs.readFileSync(legacyPath, 'utf-8')).toContain(
      `trace-mcp-launcher v${LAUNCHER_VERSION}`,
    );
  });

  it('creates the compat symlink when the legacy bin dir survives but the shim is gone', () => {
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });

    installLauncher({ force: true });

    expect(fs.lstatSync(legacyPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(legacyPath)).toBe(fs.realpathSync(getLauncherPath()));
  });

  it('creates nothing for a fresh install with no legacy path', () => {
    installLauncher({ force: true });

    expect(fs.existsSync(path.join(home, '.trace-mcp'))).toBe(false);
  });

  it('leaves an existing symlink alone', () => {
    writeLegacy(STALE_SHIM);
    installLauncher({ force: true });
    const before = fs.readlinkSync(legacyPath);

    installLauncher({ force: true });

    expect(fs.readlinkSync(legacyPath)).toBe(before);
  });

  it('never clobbers a file we do not own', () => {
    const foreign = '#!/bin/bash\n# hand-rolled wrapper\nexec my-thing "$@"\n';
    writeLegacy(foreign);

    installLauncher({ force: true });

    expect(fs.lstatSync(legacyPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(legacyPath, 'utf-8')).toBe(foreign);
  });

  // The branch an ordinary `trace upgrade` takes once the current shim is
  // already at LAUNCHER_VERSION. Passing force:true masks this entirely.
  it('repairs the legacy path on the already-current upgrade path', () => {
    installLauncher({ force: true }); // current shim in place, legacy dir absent
    writeLegacy(STALE_SHIM); // client still pointed at a pre-rename shim

    const step = installLauncher({});

    expect(step.action).toBe('already_configured');
    expect(fs.lstatSync(legacyPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(legacyPath)).toBe(fs.realpathSync(getLauncherPath()));
  });

  it('leaves the legacy path untouched when a dry run reports it as current', () => {
    installLauncher({ force: true });
    writeLegacy(STALE_SHIM);

    installLauncher({ dryRun: true });

    expect(fs.lstatSync(legacyPath).isSymbolicLink()).toBe(false);
  });

  // The legacy path is what a registered client spawns. Removing it before the
  // replacement exists would take the launcher away entirely on any failure —
  // routine on Windows, where symlinks need privileges.
  it('preserves the working shim when the replacement cannot be created', () => {
    writeLegacy(STALE_SHIM);
    vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });

    installLauncher({ force: true });

    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(fs.readFileSync(legacyPath, 'utf-8')).toBe(STALE_SHIM);
    expect(fs.readdirSync(path.dirname(legacyPath))).toEqual(['trace-mcp']);
  });

  it('does not link the legacy path to itself when it is the launcher home', () => {
    process.env.TRACE_MCP_HOME = path.join(home, '.trace-mcp');
    try {
      installLauncher({ force: true });
      // The real shim lives here now; replacing it with a self-symlink would
      // leave the client executing a loop.
      expect(fs.lstatSync(getLauncherPath()).isSymbolicLink()).toBe(false);
    } finally {
      delete process.env.TRACE_MCP_HOME;
    }
  });
});
