/**
 * Which launcher directory and which binary name the app resolves to while the
 * CLI is renaming itself `trace-mcp` → `trace` (TRA-610/TRA-614).
 *
 * The invariant these cover is the one that costs something if it breaks: the
 * app must not move to `~/.trace` before the CLI does. An app that guessed the
 * new directory on a machine whose CLI still writes the old one would install
 * its daemon somewhere nothing else reads — the two would each report a healthy
 * daemon the other cannot see.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Every resolver reads os.homedir() and the environment per call, so a spy and
// stubbed env are enough — no module reset, and a plain static import.
import { getLauncherDir, getLauncherShimPath } from '../trace-home';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-home-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('TRACE_HOME', '');
  vi.stubEnv('TRACE_MCP_HOME', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

const shimName = process.platform === 'win32' ? 'trace.cmd' : 'trace';
const legacyShimName = process.platform === 'win32' ? 'trace-mcp.cmd' : 'trace-mcp';

function makeShim(dir: string, name: string): string {
  const p = path.join(home, dir, 'bin', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 });
  return p;
}

describe('getLauncherDir', () => {
  it('stays on ~/.trace-mcp when the CLI has not created ~/.trace yet', () => {
    fs.mkdirSync(path.join(home, '.trace-mcp'));
    expect(getLauncherDir()).toBe(path.join(home, '.trace-mcp'));
  });

  /* The default on a machine with neither directory is the legacy one too: the
     app installs the daemon into whatever it returns, and until the rename
     ships that has to be the directory the CLI reads. */
  it('defaults to ~/.trace-mcp when neither directory exists', () => {
    expect(getLauncherDir()).toBe(path.join(home, '.trace-mcp'));
  });

  it('follows the CLI to ~/.trace once that directory is there', () => {
    fs.mkdirSync(path.join(home, '.trace'));
    fs.mkdirSync(path.join(home, '.trace-mcp'));
    expect(getLauncherDir()).toBe(path.join(home, '.trace'));
  });

  it.each(['TRACE_HOME', 'TRACE_MCP_HOME'])('honours %s over both defaults', (key) => {
    fs.mkdirSync(path.join(home, '.trace'));
    vi.stubEnv(key, '/somewhere/else');
    expect(getLauncherDir()).toBe('/somewhere/else');
  });
});

describe('getLauncherShimPath', () => {
  it('picks the legacy shim when it is the only one installed', () => {
    const legacy = makeShim('.trace-mcp', legacyShimName);
    expect(getLauncherShimPath()).toBe(legacy);
  });

  it('prefers the renamed shim once both are present', () => {
    fs.mkdirSync(path.join(home, '.trace'), { recursive: true });
    makeShim('.trace', legacyShimName);
    const current = makeShim('.trace', shimName);
    expect(getLauncherShimPath()).toBe(current);
  });

  /* Nothing installed is not an error here — the caller needs a path to name in
     its "run init first" message. */
  it('names the expected path when nothing is installed', () => {
    expect(getLauncherShimPath()).toBe(
      path.join(home, '.trace-mcp', 'bin', legacyShimName),
    );
  });
});
