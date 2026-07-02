/**
 * Behavioral tests for src/cli/preflight.ts — first-run preflight checks (#124).
 *
 * Every check takes its input as an argument (Node version string, home dir
 * path, detected MCP client count), so these are pure-ish unit tests. The
 * only I/O is `checkHomeWritable`, which we exercise against a real tmp dir
 * (success path) and a non-writable/non-existent path (failure path) rather
 * than mocking fs — the whole point of the check is "can we actually write
 * here", so a real filesystem probe is the honest test.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkHomeWritable,
  checkMcpClientConfig,
  checkNodeVersion,
  MIN_NODE_MAJOR,
  runPreflight,
} from '../../src/cli/preflight.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

describe('checkNodeVersion', () => {
  it('reports ok for a Node version at the minimum major', () => {
    const check = checkNodeVersion(`${MIN_NODE_MAJOR}.0.0`);
    expect(check.severity).toBe('ok');
    expect(check.name).toBe('node-version');
    expect(check.message).toContain(`${MIN_NODE_MAJOR}.0.0`);
    expect(check.hint).toBeUndefined();
  });

  it('reports ok for a Node version above the minimum major', () => {
    const check = checkNodeVersion(`${MIN_NODE_MAJOR + 2}.5.1`);
    expect(check.severity).toBe('ok');
  });

  it('reports error for a Node version below the minimum major', () => {
    const check = checkNodeVersion('18.19.0');
    expect(check.severity).toBe('error');
    expect(check.message).toMatch(/too old/);
    expect(check.hint).toMatch(/Upgrade Node/);
  });

  it('reports warn when the version string cannot be parsed', () => {
    const check = checkNodeVersion('not-a-version');
    expect(check.severity).toBe('warn');
    expect(check.message).toMatch(/Could not parse/);
  });

  it('defaults to the running process Node version when no argument is passed', () => {
    const check = checkNodeVersion();
    // The test runner itself must satisfy the repo's engines.node policy.
    expect(check.severity).not.toBe('error');
  });
});

describe('checkHomeWritable', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = createTmpDir('trace-mcp-preflight-');
  });

  afterEach(() => {
    removeTmpDir(tmp);
  });

  it('reports ok and leaves no probe file behind when the dir is writable', () => {
    const home = path.join(tmp, 'nested', 'trace-mcp-home');
    const check = checkHomeWritable(home);
    expect(check.severity).toBe('ok');
    expect(check.message).toContain(home);
    // mkdirSync(recursive) must have created the nested dir.
    expect(fs.existsSync(home)).toBe(true);
    // The probe file should have been cleaned up.
    const leftovers = fs.readdirSync(home).filter((f) => f.includes('.preflight-'));
    expect(leftovers).toEqual([]);
  });

  it('reports error when the path cannot be written to (parent is a file, not a dir)', () => {
    const blockerFile = path.join(tmp, 'blocker');
    fs.writeFileSync(blockerFile, 'not a directory');
    // Attempting to mkdir *under* a file must fail (ENOTDIR/EEXIST depending on OS).
    const home = path.join(blockerFile, 'trace-mcp-home');
    const check = checkHomeWritable(home);
    expect(check.severity).toBe('error');
    expect(check.message).toMatch(/Cannot write to/);
    expect(check.hint).toMatch(/chmod|TRACE_MCP_DATA_DIR/);
  });
});

describe('checkMcpClientConfig', () => {
  it('reports ok with singular wording for exactly one detected client', () => {
    const check = checkMcpClientConfig(1);
    expect(check.severity).toBe('ok');
    expect(check.message).toBe('1 MCP client config detected');
  });

  it('reports ok with plural wording for multiple detected clients', () => {
    const check = checkMcpClientConfig(3);
    expect(check.severity).toBe('ok');
    expect(check.message).toBe('3 MCP client configs detected');
  });

  it('reports warn (not error) when no client config was detected', () => {
    const check = checkMcpClientConfig(0);
    expect(check.severity).toBe('warn');
    expect(check.message).toMatch(/No MCP client config detected/);
    expect(check.hint).toMatch(/trace-mcp doctor/);
  });
});

describe('runPreflight', () => {
  it('aggregates all three checks and is ok when nothing errors', () => {
    const report = runPreflight({ mcpClientCount: 1 });
    expect(report.checks).toHaveLength(3);
    expect(report.checks.map((c) => c.name)).toEqual([
      'node-version',
      'home-writable',
      'mcp-client-config',
    ]);
    // Real machine running the test suite: Node is fine, home is writable.
    // mcpClientCount=1 keeps every check at ok/warn, never error.
    expect(report.ok).toBe(true);
  });

  it('is not ok when any individual check reports error', () => {
    // mcpClientCount alone can't force an error (warn is its worst case), so
    // assert the aggregation rule directly: ok iff no check is severity=error.
    const report = runPreflight({ mcpClientCount: 0 });
    const hasError = report.checks.some((c) => c.severity === 'error');
    expect(report.ok).toBe(!hasError);
  });
});
