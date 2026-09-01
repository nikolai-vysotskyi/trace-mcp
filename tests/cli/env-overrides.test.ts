/**
 * Tests for TRACE_MCP_DATA_DIR + TRACE_MCP_REPO_ROOT env-var overrides.
 *
 * Both modules resolve their values at import time, so we drive the tests
 * by shelling out — clearing the cached module isn't enough when the
 * constant is a top-level expression. Subprocess invocations keep the
 * resolution surface honest: a user setting TRACE_MCP_DATA_DIR=/foo and
 * launching trace-mcp must see /foo, full stop.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');

/** Normalise both expected suffix and actual output to forward slashes so
 *  endsWith() checks are path-separator-agnostic. Without this, Windows
 *  runners see `\custom-trace-mcp` and the `'/custom-trace-mcp'` literal
 *  in the assertion never matches. */
const fwd = (p: string) => p.split(sep).join('/');

function runWithEnv(script: string, env: Record<string, string>): string {
  const out = execFileSync(
    'node',
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    {
      cwd: repoRoot,
      env: { ...process.env, ...env, NODE_OPTIONS: '' },
      encoding: 'utf-8',
    },
  );
  return out.trim();
}

describe('TRACE_MCP_DATA_DIR', () => {
  it('overrides ~/.trace-mcp/ when set to an absolute path', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'trace-data-'));
    const out = runWithEnv(
      `import { TRACE_MCP_HOME } from './src/global.ts'; console.log(TRACE_MCP_HOME);`,
      { TRACE_MCP_DATA_DIR: tmp },
    );
    expect(out).toBe(resolve(tmp));
  });

  it('expands ~ in the override', () => {
    const out = runWithEnv(
      `import { TRACE_MCP_HOME } from './src/global.ts'; console.log(TRACE_MCP_HOME);`,
      { TRACE_MCP_DATA_DIR: '~/custom-trace-mcp' },
    );
    expect(fwd(out).endsWith('/custom-trace-mcp')).toBe(true);
    expect(out).not.toBe('~/custom-trace-mcp'); // expansion must have happened
  });

  it('falls back to ~/.trace when env var is empty', () => {
    // Fake HOME: with no override the fallback also runs the one-time
    // ~/.trace-mcp → ~/.trace move, which must never touch the real home.
    const fakeHome = mkdtempSync(join(tmpdir(), 'trace-fake-home-'));
    const out = runWithEnv(
      `import { TRACE_MCP_HOME } from './src/global.ts'; console.log(TRACE_MCP_HOME);`,
      { TRACE_MCP_DATA_DIR: '', HOME: fakeHome, USERPROFILE: fakeHome },
    );
    expect(fwd(out).endsWith('/.trace')).toBe(true);
  });

  it('repairs the compatibility symlink a previous run failed to create (TRA-610)', () => {
    // Simulates the "renamed, then symlinkSync threw" case: the new home
    // exists, the legacy path does not. The move is one-shot, so without a
    // retry every pre-rename client config pointing at ~/.trace-mcp/bin/ would
    // stay broken forever.
    const fakeHome = mkdtempSync(join(tmpdir(), 'trace-fake-home-'));
    mkdirSync(join(fakeHome, '.trace'), { recursive: true });
    writeFileSync(join(fakeHome, '.trace', 'registry.json'), '{"projects":[]}');

    const out = runWithEnv(
      `import { TRACE_MCP_HOME } from './src/global.ts'; console.log(TRACE_MCP_HOME);`,
      { TRACE_MCP_DATA_DIR: '', HOME: fakeHome, USERPROFILE: fakeHome },
    );

    expect(out).toBe(join(fakeHome, '.trace'));
    expect(readFileSync(join(fakeHome, '.trace-mcp', 'registry.json'), 'utf-8')).toContain(
      'projects',
    );
  });

  it('leaves a real ~/.trace-mcp directory alone when ~/.trace already exists', () => {
    // Old and new versions run side by side. Merging two live state dirs is a
    // data-loss risk, so neither side may be touched.
    const fakeHome = mkdtempSync(join(tmpdir(), 'trace-fake-home-'));
    mkdirSync(join(fakeHome, '.trace'), { recursive: true });
    mkdirSync(join(fakeHome, '.trace-mcp'), { recursive: true });
    writeFileSync(join(fakeHome, '.trace', 'registry.json'), '{"projects":["new"]}');
    writeFileSync(join(fakeHome, '.trace-mcp', 'registry.json'), '{"projects":["old"]}');

    runWithEnv(`import { TRACE_MCP_HOME } from './src/global.ts'; console.log(TRACE_MCP_HOME);`, {
      TRACE_MCP_DATA_DIR: '',
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    });

    expect(readFileSync(join(fakeHome, '.trace', 'registry.json'), 'utf-8')).toContain('new');
    expect(readFileSync(join(fakeHome, '.trace-mcp', 'registry.json'), 'utf-8')).toContain('old');
  });

  it('moves a pre-rename ~/.trace-mcp to ~/.trace and symlinks it back (TRA-610)', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'trace-fake-home-'));
    const legacy = join(fakeHome, '.trace-mcp');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'registry.json'), '{"projects":[]}');

    const out = runWithEnv(
      `import { TRACE_MCP_HOME } from './src/global.ts'; console.log(TRACE_MCP_HOME);`,
      { TRACE_MCP_DATA_DIR: '', HOME: fakeHome, USERPROFILE: fakeHome },
    );

    expect(out).toBe(join(fakeHome, '.trace'));
    // Data moved…
    expect(readFileSync(join(fakeHome, '.trace', 'registry.json'), 'utf-8')).toContain('projects');
    // …and the old path still resolves, so launcher paths baked into existing
    // MCP client configs keep working.
    expect(readFileSync(join(legacy, 'registry.json'), 'utf-8')).toContain('projects');
  });
});

describe('TRACE_MCP_REPO_ROOT', () => {
  it('short-circuits findProjectRoot to the override path', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'trace-root-'));
    writeFileSync(join(tmp, 'package.json'), '{}'); // not strictly needed, but realistic
    const out = runWithEnv(
      `import { findProjectRoot } from './src/project-root.ts'; console.log(findProjectRoot());`,
      { TRACE_MCP_REPO_ROOT: tmp },
    );
    expect(out).toBe(resolve(tmp));
  });

  it('returns the override even when no marker file exists at the path', () => {
    // Whole point of the override: it bypasses the marker walk so a
    // scripted caller from any cwd lands on the right repo.
    const tmp = mkdtempSync(join(tmpdir(), 'trace-bare-'));
    const out = runWithEnv(
      `import { findProjectRoot } from './src/project-root.ts'; console.log(findProjectRoot());`,
      { TRACE_MCP_REPO_ROOT: tmp },
    );
    expect(out).toBe(resolve(tmp));
  });

  it('expands ~ in the override', () => {
    const out = runWithEnv(
      `import { findProjectRoot } from './src/project-root.ts'; console.log(findProjectRoot());`,
      { TRACE_MCP_REPO_ROOT: '~/some-repo' },
    );
    expect(fwd(out).endsWith('/some-repo')).toBe(true);
    expect(out).not.toBe('~/some-repo');
  });
});
