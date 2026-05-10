/**
 * Regression tests for the path-traversal validators introduced in 32bcda7
 * (`fix(security): keep hook source lookup inside the trace-mcp install
 * tree`). They are pure helpers that gate `findHookSource` / `findAuxFile`
 * — a bug here would let a hostile working directory inject a hook script
 * during `trace-mcp init`. No fs mocks: these functions are pure (string
 * arithmetic plus path.relative / path.isAbsolute).
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findHookSource, isSafeFilename, isWithin } from '../../src/init/hooks.js';

describe('isSafeFilename', () => {
  it('accepts ordinary basenames', () => {
    expect(isSafeFilename('reindex')).toBe(true);
    expect(isSafeFilename('precompact-snapshot')).toBe(true);
    expect(isSafeFilename('hook_v2.cmd')).toBe(true);
  });

  it('rejects empty / oversized basenames', () => {
    expect(isSafeFilename('')).toBe(false);
    expect(isSafeFilename('a'.repeat(201))).toBe(false);
  });

  it('rejects basenames containing path separators', () => {
    expect(isSafeFilename('foo/bar')).toBe(false);
    expect(isSafeFilename('foo\\bar')).toBe(false);
    expect(isSafeFilename('../etc/passwd')).toBe(false);
    expect(isSafeFilename('..\\..\\windows\\system32\\cmd.exe')).toBe(false);
  });

  it('rejects parent-directory tokens', () => {
    expect(isSafeFilename('.')).toBe(false);
    expect(isSafeFilename('..')).toBe(false);
  });

  it('rejects absolute paths', () => {
    expect(isSafeFilename('/etc/passwd')).toBe(false);
    if (process.platform === 'win32') {
      expect(isSafeFilename('C:\\Windows\\System32\\cmd.exe')).toBe(false);
    }
  });
});

describe('isWithin', () => {
  it('accepts the parent itself', () => {
    expect(isWithin('/opt/trace-mcp', '/opt/trace-mcp')).toBe(true);
  });

  it('accepts paths nested inside the parent', () => {
    expect(isWithin('/opt/trace-mcp', '/opt/trace-mcp/hooks/reindex.sh')).toBe(true);
    expect(isWithin('/opt/trace-mcp', '/opt/trace-mcp/dist/cli.js')).toBe(true);
  });

  it('rejects paths that escape via ..', () => {
    expect(isWithin('/opt/trace-mcp', '/opt/trace-mcp/../other/script.sh')).toBe(false);
    expect(isWithin('/opt/trace-mcp', '/etc/passwd')).toBe(false);
  });

  it('rejects siblings with a confusable prefix', () => {
    // `/opt/trace-mcp-evil` shares a prefix with `/opt/trace-mcp` but is
    // not under it — path.relative produces `../trace-mcp-evil/...`.
    expect(isWithin('/opt/trace-mcp', '/opt/trace-mcp-evil/hooks/x.sh')).toBe(false);
  });

  it('rejects an absolute path that is unrelated to the parent', () => {
    expect(isWithin('/opt/trace-mcp', '/tmp/exploit.sh')).toBe(false);
  });
});

describe('findHookSource', () => {
  it('refuses unsafe script names before any filesystem lookup', () => {
    expect(() => findHookSource('../etc/passwd')).toThrow(/unsafe script name/);
    expect(() => findHookSource('foo/bar')).toThrow(/unsafe script name/);
    expect(() => findHookSource('')).toThrow(/unsafe script name/);
    expect(() => findHookSource('..')).toThrow(/unsafe script name/);
  });

  it('refuses absolute-path script names', () => {
    expect(() => findHookSource(path.resolve('/etc/passwd'))).toThrow(/unsafe script name/);
  });

  it('throws a corruption error for safe names that do not exist', () => {
    // A safe basename that is not shipped with trace-mcp should fail with
    // the "installation may be corrupted" message — never a path-traversal
    // success that returns something outside the install tree.
    expect(() => findHookSource('definitely-not-a-real-hook-name-xyz')).toThrow(
      /installation may be corrupted/,
    );
  });
});
