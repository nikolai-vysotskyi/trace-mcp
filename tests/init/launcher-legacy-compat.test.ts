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
import { getLauncherPath, installLauncher } from '../../src/init/launcher.js';
import { LAUNCHER_VERSION } from '../../src/init/types.js';

const STALE_SHIM = '#!/bin/bash\n# trace-mcp-launcher v0.3.0\nexit 127\n';

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
