import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIN_NODE_MAJOR,
  checkHomeWritable,
  checkMcpClientConfig,
  checkNodeVersion,
} from '../preflight.js';

// Issue #124: first-run friction. Preflight turns environment problems into
// actionable messages instead of mid-init stack traces.

describe('checkNodeVersion', () => {
  it('passes on a supported Node version', () => {
    const c = checkNodeVersion(`${MIN_NODE_MAJOR}.5.0`);
    expect(c.severity).toBe('ok');
  });

  it('errors (with an upgrade hint) on an unsupported version', () => {
    const c = checkNodeVersion(`${MIN_NODE_MAJOR - 2}.0.0`);
    expect(c.severity).toBe('error');
    expect(c.hint).toMatch(/upgrade/i);
  });

  it('warns when the version string is unparseable', () => {
    const c = checkNodeVersion('not-a-version');
    expect(c.severity).toBe('warn');
  });
});

describe('checkMcpClientConfig', () => {
  it('passes when at least one client is detected', () => {
    expect(checkMcpClientConfig(2).severity).toBe('ok');
  });

  it('warns (not errors) when none is detected', () => {
    const c = checkMcpClientConfig(0);
    expect(c.severity).toBe('warn');
    expect(c.hint).toMatch(/doctor/i);
  });
});

describe('checkHomeWritable', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-preflight-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('passes for a writable directory (creating it if missing)', () => {
    const home = path.join(tmp, 'nested', 'trace-mcp');
    const c = checkHomeWritable(home);
    expect(c.severity).toBe('ok');
    expect(fs.existsSync(home)).toBe(true);
  });

  it('errors with an actionable hint when the directory is not writable', () => {
    // Simulate an unwritable location: a path under a regular file (ENOTDIR).
    const file = path.join(tmp, 'a-file');
    fs.writeFileSync(file, 'x');
    const c = checkHomeWritable(path.join(file, 'trace-mcp'));
    expect(c.severity).toBe('error');
    expect(c.hint).toMatch(/permission|TRACE_MCP_DATA_DIR/i);
  });
});
