/**
 * TRA-638: the desktop app could not spawn its own CLI on Windows.
 *
 * The MCP-clients screen ran `execFile(resolveCliCommand(), …)`, and on Windows
 * `resolveCliCommand` returns `~/.trace-mcp/bin/trace-mcp.cmd` — a file Node
 * refuses to launch without a shell. Status, Connect and Update all failed, and
 * looked identical to working buttons while doing so.
 *
 * These tests live in the root suite on purpose. The app has its own lockfile
 * and its own vitest run, and that job (`app-typecheck`) is ubuntu-only, so a
 * Windows-only defect in `packages/app/src/main` has nowhere in the app's own
 * suite where it would ever be executed. The root suite is what
 * `cross-platform-test` runs on windows-latest.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  execCli,
  resolveCliCommand,
  resolveCliInvocation,
} from '../../packages/app/src/main/daemon-install';

/**
 * A launcher dir shaped like a real install: both shim names present (so the
 * layout is valid whichever platform reads it) and a launcher.env pointing at a
 * cli.js that echoes the argv it was handed.
 */
function makeLauncherHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tra638-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });

  const cli = path.join(home, 'cli.js');
  fs.writeFileSync(cli, 'console.log(JSON.stringify(process.argv.slice(2)));\n');

  // The POSIX shim, doing what the shipped one does: exec Node on cli.js.
  fs.writeFileSync(
    path.join(bin, 'trace'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`,
    { mode: 0o755 },
  );
  // The Windows shim — present so the resolver has the .cmd it must not pick.
  fs.writeFileSync(path.join(bin, 'trace.cmd'), '@echo off\r\n', { mode: 0o755 });

  fs.writeFileSync(
    path.join(home, 'launcher.env'),
    [`TRACE_CLI="${cli.replaceAll('\\', '/')}"`, 'TRACE_VERSION="3.7.0"', ''].join('\n'),
  );
  return home;
}

describe('resolveCliInvocation', () => {
  let home: string;

  beforeEach(() => {
    home = makeLauncherHome();
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('never hands execFile a .cmd on Windows', () => {
    const inv = resolveCliInvocation({ dir: home, isWindows: true, execPath: '/opt/node' });

    expect(inv).toEqual({
      file: '/opt/node',
      prefixArgs: [path.join(home, 'cli.js').replaceAll('\\', '/')],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    // What shipped instead, under this exact layout — unlaunchable without a shell.
    expect(path.extname(resolveCliInvocation({ dir: home, isWindows: true }).file)).not.toBe(
      '.cmd',
    );
  });

  it('stays on the shim off Windows, where it is directly executable', () => {
    const inv = resolveCliInvocation({ dir: home, isWindows: false });
    expect(inv).toEqual({ file: resolveCliCommand(home), prefixArgs: [] });
  });

  it('falls back to the shim when launcher.env names no cli.js', () => {
    fs.rmSync(path.join(home, 'launcher.env'));
    const inv = resolveCliInvocation({ dir: home, isWindows: true });
    expect(inv.prefixArgs).toEqual([]);
  });
});

describe('execCli', () => {
  let home: string;
  const previous = process.env.TRACE_HOME;

  beforeEach(() => {
    home = makeLauncherHome();
    process.env.TRACE_HOME = home;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.TRACE_HOME;
    else process.env.TRACE_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });

  /* The status call, spawned for real on whatever OS is running this. On
     Windows that exercises the runtime + cli.js path; elsewhere, the shim.
     A shell anywhere in that chain would have eaten the `&`. */
  it('reaches the CLI with argv intact — spaces and & included', async () => {
    const argv = await new Promise<string[]>((resolve, reject) => {
      execCli(
        ['clients', 'status', '--json', '--scope', 'C:\\Program Files\\a & b'],
        { timeout: 30_000 },
        (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout))),
      );
    });

    expect(argv).toEqual(['clients', 'status', '--json', '--scope', 'C:\\Program Files\\a & b']);
  });
});
