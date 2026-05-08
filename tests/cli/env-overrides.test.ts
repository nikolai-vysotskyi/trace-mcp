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
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');

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
    expect(out.endsWith('/custom-trace-mcp')).toBe(true);
    expect(out).not.toBe('~/custom-trace-mcp'); // expansion must have happened
  });

  it('falls back to ~/.trace-mcp when env var is empty', () => {
    const out = runWithEnv(
      `import { TRACE_MCP_HOME } from './src/global.ts'; console.log(TRACE_MCP_HOME);`,
      { TRACE_MCP_DATA_DIR: '' },
    );
    expect(out.endsWith('/.trace-mcp')).toBe(true);
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
    expect(out.endsWith('/some-repo')).toBe(true);
    expect(out).not.toBe('~/some-repo');
  });
});
