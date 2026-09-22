/**
 * TRA-1807: `serve-http` verifies its install tree at startup instead of
 * degrading silently. `checkDaemonRuntimeIntact` is pure (no logging, no
 * exit) so it can be driven against throwaway dirs here; cli.ts decides
 * how loud to fail.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDaemonRuntimeIntact, ephemeralServeHttpRefusal } from '../lifecycle.js';

describe('checkDaemonRuntimeIntact (TRA-1807)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function mkCliDir(withWorker: boolean): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-1807-intact-'));
    dirs.push(dir);
    if (withWorker) fs.writeFileSync(path.join(dir, 'extract-worker.js'), '// fake\n');
    return dir;
  }

  it('reports a missing extract-worker.js sibling', () => {
    // The real install has its WASM grammars, so only the worker entry
    // should be reported for a bare dir.
    const problems = checkDaemonRuntimeIntact(mkCliDir(false));
    expect(problems.length).toBe(1);
    expect(problems[0]).toMatch(/extract worker entry missing/);
    expect(problems[0]).toMatch(/TRA-1807/);
  });

  it('reports nothing when the worker entry is present and WASM resolves', () => {
    // In this repo's own install tree-sitter-wasm resolves, so a dir with
    // the worker sibling is fully intact.
    expect(checkDaemonRuntimeIntact(mkCliDir(true))).toEqual([]);
  });
});

describe('ephemeralServeHttpRefusal (TRA-1807)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('refuses serve-http from /tmp and sandbox task paths', () => {
    for (const entry of [
      '/tmp/trace-mcp/dist/cli.js',
      '/private/tmp/trace-mcp/dist/cli.js',
      '/private/tmp/multica-task-3847237843/pinned-latest/node_modules/trace-mcp/dist/cli.js',
    ]) {
      const refusal = ephemeralServeHttpRefusal(entry);
      expect(refusal).not.toBeNull();
      expect(String(refusal)).toMatch(/refuses to start from an ephemeral install path/);
      expect(String(refusal)).toMatch(/TRA-1807/);
    }
  });

  it('allows stable installs', () => {
    expect(
      ephemeralServeHttpRefusal(
        '/Users/nikolai/.hermes/node/lib/node_modules/trace-mcp/dist/cli.js',
      ),
    ).toBeNull();
    expect(ephemeralServeHttpRefusal('')).toBeNull();
  });

  it('exempts a dev checkout even on an ephemeral-shaped path', () => {
    // A git checkout at an agent workdir shape: deliberate invocation, not a hijack.
    const root = path.join(os.tmpdir(), `multica-task-${process.pid}1807`, 'workdir', 'trace-mcp');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const entry = path.join(root, 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '// fake\n');
    dirs.push(path.join(os.tmpdir(), `multica-task-${process.pid}1807`));
    expect(ephemeralServeHttpRefusal(entry)).toBeNull();
  });

  it('refuses an npm tree on an ephemeral-shaped path without .git', () => {
    const root = path.join(os.tmpdir(), `multica-task-${process.pid}1808`);
    const entry = path.join(root, 'pinned-latest', 'node_modules', 'trace-mcp', 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '// fake\n');
    dirs.push(root);
    expect(ephemeralServeHttpRefusal(entry)).not.toBeNull();
  });
});
