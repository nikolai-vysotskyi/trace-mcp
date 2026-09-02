/**
 * The scripts' copy of the `~/.trace-mcp` → `~/.trace` fallback (TRA-667).
 *
 * The case that costs something is "the CLI already migrated": `src/global.ts`
 * *renames* the old directory away on first import, so a script still building
 * paths from `~/.trace-mcp` afterwards points at a directory that no longer
 * exists — the postinstall then never stops the running daemon, and the app
 * location marker is silently missed.
 *
 * The mirror of this for the Electron main process lives in
 * `packages/app/src/main/__tests__/trace-home.test.ts`.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { traceHomeDir } from '../../scripts/trace-home.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// A bare Windows path (`C:\...`) is not a valid ESM specifier — it doesn't
// start with `/`, so Node treats it as a bare package name instead of an
// absolute path and resolution fails. `file://` URLs work on every platform.
const MODULE_SPECIFIER = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'trace-home.mjs')).href;

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'scripts-trace-home-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** Resolve in a child process, so `os.homedir()` and env are really the ones we set. */
function resolveWithEnv(env: Record<string, string>): string {
  const harness = path.join(home, 'harness.mjs');
  fs.writeFileSync(
    harness,
    `import { traceHomeDir } from ${JSON.stringify(MODULE_SPECIFIER)};\n` +
      `process.stdout.write(traceHomeDir());\n`,
  );
  return execFileSync(process.execPath, [harness], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
  });
}

describe('traceHomeDir', () => {
  it('follows the CLI to ~/.trace once the rename has happened', () => {
    fs.mkdirSync(path.join(home, '.trace'));
    expect(traceHomeDir(home)).toBe(path.join(home, '.trace'));
  });

  it('stays on ~/.trace-mcp while the CLI has not renamed yet', () => {
    fs.mkdirSync(path.join(home, '.trace-mcp'));
    expect(traceHomeDir(home)).toBe(path.join(home, '.trace-mcp'));
  });

  it('prefers ~/.trace when both are on disk mid-migration', () => {
    fs.mkdirSync(path.join(home, '.trace'));
    fs.mkdirSync(path.join(home, '.trace-mcp'));
    expect(traceHomeDir(home)).toBe(path.join(home, '.trace'));
  });

  it('defaults to ~/.trace-mcp when neither directory exists', () => {
    expect(traceHomeDir(home)).toBe(path.join(home, '.trace-mcp'));
  });

  /* An explicit home is a sandbox root; a TRACE_HOME in the developer's shell
     must not redirect a lookup that was deliberately pinned. */
  it('ignores TRACE_HOME when the caller pinned a home directory', () => {
    process.env.TRACE_HOME = '/somewhere/else';
    try {
      expect(traceHomeDir(home)).toBe(path.join(home, '.trace-mcp'));
    } finally {
      delete process.env.TRACE_HOME;
    }
  });

  it.each(['TRACE_HOME', 'TRACE_MCP_HOME'])('honours %s when no home is pinned', (key) => {
    fs.mkdirSync(path.join(home, '.trace'));
    expect(resolveWithEnv({ [key]: '/somewhere/else' })).toBe('/somewhere/else');
  });

  it('resolves from os.homedir() when nothing is pinned', () => {
    fs.mkdirSync(path.join(home, '.trace'));
    expect(resolveWithEnv({ TRACE_HOME: '', TRACE_MCP_HOME: '' })).toBe(path.join(home, '.trace'));
  });
});
