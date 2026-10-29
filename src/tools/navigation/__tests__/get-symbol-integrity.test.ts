/**
 * Unit tests for the verify_against_git integrity path in getSymbol().
 *
 * Strategy:
 *   - Mock node:child_process execFileSync so no real git repo is needed.
 *   - Use a non-existent project root (/tmp/fake-root) so readSymbolSource
 *     throws on open, causing getSymbol to fall back to symbol.signature as
 *     the indexed source. Tests then control what "git HEAD" returns via the
 *     execFileSync mock and assert the mismatch flag accordingly.
 *
 * This keeps the tests hermetic: no disk, no git, no external processes.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../../../db/store.js';
import { getSymbol } from '../navigation.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

const mockedExecFileSync = vi.mocked(execFileSync);

// ─── minimal Store stub ───────────────────────────────────────────────────────

/** The signature text is what getSymbol falls back to when readSymbolSource fails. */
const SIGNATURE = 'function foo(): void';

function makeSymbol(prefix = '') {
  return {
    symbol_id: 'src/a.ts::foo#function',
    name: 'foo',
    kind: 'function',
    fqn: 'foo',
    file_id: 1,
    byte_start: prefix.length,
    byte_end: prefix.length + SIGNATURE.length,
    line_start: 1,
    line_end: 3,
    signature: SIGNATURE,
    summary: null,
    metadata: null,
  };
}

function makeFile() {
  return {
    id: 1,
    path: 'src/a.ts',
    language: 'typescript',
    hash: 'abc',
    size: 100,
    gitignored: 0,
  };
}

function makeStore(prefix = ''): Store {
  const sym = makeSymbol(prefix);
  const file = makeFile();
  return {
    getSymbolBySymbolId: () => sym,
    getSymbolByFqn: () => sym,
    getFileById: () => file,
  } as unknown as Store;
}

/**
 * Build a Buffer of 200 bytes where bytes [0, text.length) hold `text`.
 * This simulates what `git show HEAD:<file>` returns as a raw Buffer.
 * Cast to `string` to satisfy the mock's inferred return type — at
 * runtime the implementation calls `.slice()` on the returned value, which
 * works identically on a Buffer.
 */
function gitBuf(text: string): string {
  const buf = Buffer.alloc(200, 0);
  Buffer.from(text, 'utf8').copy(buf, 0);
  return buf as unknown as string;
}

// Project root that does not exist on disk — readSymbolSource will throw on
// openSync, so getSymbol falls back to symbol.signature as indexed source.
const PROJECT_ROOT = '/nonexistent/trace-mcp-test-' + Math.random().toString(36).slice(2);

// ─── tests ───────────────────────────────────────────────────────────────────

describe('getSymbol — verify_against_git', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('omits git_mismatch when verify_against_git is false', () => {
    const result = getSymbol(makeStore(), PROJECT_ROOT, {
      symbolId: 'src/a.ts::foo#function',
      verifyAgainstGit: false,
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().git_mismatch).toBeUndefined();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('omits git_mismatch when verify_against_git is not passed', () => {
    const result = getSymbol(makeStore(), PROJECT_ROOT, {
      symbolId: 'src/a.ts::foo#function',
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().git_mismatch).toBeUndefined();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('sets git_mismatch: true when HEAD slice differs from indexed source', () => {
    // git show returns different content in bytes [0, byte_end)
    mockedExecFileSync.mockReturnValueOnce(gitBuf('function foo(): string'));

    const result = getSymbol(makeStore(), PROJECT_ROOT, {
      symbolId: 'src/a.ts::foo#function',
      verifyAgainstGit: true,
    });

    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();
    expect(val.git_mismatch).toBe(true);
    expect(mockedExecFileSync).toHaveBeenCalledOnce();
    const [cmd, args] = mockedExecFileSync.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('git');
    expect(args).toContain('HEAD:src/a.ts');
  });

  it('omits git_mismatch when HEAD slice matches indexed source', () => {
    // git show returns the same text as the signature fallback source
    // bytes [0, SIGNATURE.length) must equal SIGNATURE exactly.
    mockedExecFileSync.mockReturnValueOnce(gitBuf(SIGNATURE));

    const result = getSymbol(makeStore(), PROJECT_ROOT, {
      symbolId: 'src/a.ts::foo#function',
      verifyAgainstGit: true,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().git_mismatch).toBeUndefined();
  });

  it('compares a UTF-16 range after a non-ASCII prefix in HEAD', () => {
    const prefix = '// 😀 漢字 é\n';
    mockedExecFileSync.mockReturnValueOnce(gitBuf(prefix + SIGNATURE));
    const result = getSymbol(makeStore(prefix), PROJECT_ROOT, {
      symbolId: 'src/a.ts::foo#function',
      verifyAgainstGit: true,
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().git_mismatch).toBeUndefined();
  });

  it('does not flag identical exported source after a Unicode prefix', () => {
    const root = mkdtempSync(join(tmpdir(), 'trace-git-unicode-'));
    const prefix = '// 😀 漢字 é\nexport ';
    const content = `${prefix}${SIGNATURE}`;
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.ts'), content);
    mockedExecFileSync.mockReturnValueOnce(Buffer.from(content) as unknown as string);
    try {
      const result = getSymbol(makeStore(prefix), root, {
        symbolId: 'src/a.ts::foo#function',
        verifyAgainstGit: true,
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().source).toBe(`export ${SIGNATURE}`);
      expect(result._unsafeUnwrap().git_mismatch).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('silently skips the check when git show throws (git unavailable)', () => {
    mockedExecFileSync.mockImplementationOnce(() => {
      throw new Error('git: command not found');
    });

    const result = getSymbol(makeStore(), PROJECT_ROOT, {
      symbolId: 'src/a.ts::foo#function',
      verifyAgainstGit: true,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().git_mismatch).toBeUndefined();
  });

  it('silently skips the check when the file is not tracked (non-zero exit code)', () => {
    const exitError = Object.assign(new Error('fatal: Path not in HEAD'), { status: 128 });
    mockedExecFileSync.mockImplementationOnce(() => {
      throw exitError;
    });

    const result = getSymbol(makeStore(), PROJECT_ROOT, {
      fqn: 'foo',
      verifyAgainstGit: true,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().git_mismatch).toBeUndefined();
  });

  it('passes safeGitEnv overrides to execFileSync', () => {
    mockedExecFileSync.mockReturnValueOnce(gitBuf(SIGNATURE));

    getSymbol(makeStore(), PROJECT_ROOT, {
      symbolId: 'src/a.ts::foo#function',
      verifyAgainstGit: true,
    });

    expect(mockedExecFileSync).toHaveBeenCalledOnce();
    const spawnOpts = mockedExecFileSync.mock.calls[0][2] as { env?: NodeJS.ProcessEnv };
    expect(spawnOpts.env).toBeDefined();
    expect(spawnOpts.env?.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(spawnOpts.env?.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('uses projectRoot as cwd when calling git', () => {
    mockedExecFileSync.mockReturnValueOnce(gitBuf(SIGNATURE));

    getSymbol(makeStore(), PROJECT_ROOT, {
      symbolId: 'src/a.ts::foo#function',
      verifyAgainstGit: true,
    });

    const spawnOpts = mockedExecFileSync.mock.calls[0][2] as { cwd?: string };
    expect(spawnOpts.cwd).toBe(PROJECT_ROOT);
  });
});
