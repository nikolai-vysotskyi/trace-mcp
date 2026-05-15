/**
 * Behavioural coverage for `getSymbolOwnership()` in
 * `src/tools/git/git-ownership.ts` (the implementation behind the
 * `get_symbol_owners` MCP tool). Per-symbol ownership via `git blame
 * --porcelain -L start,end`. `node:child_process.execFileSync` is mocked
 * so the suite runs offline and is deterministic.
 */

import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getSymbolOwnership } from '../../../src/tools/git/git-ownership.js';
import { createTestStore } from '../../test-utils.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

interface BlameLine {
  author: string;
}

/**
 * Build a porcelain blame block. Each input line yields the header lines
 * (author, mail, time, summary, filename) followed by a `\t<content>` line
 * that the parser counts as one ownership tick for `author`.
 */
function blamePorcelain(lines: BlameLine[]): string {
  const out: string[] = [];
  lines.forEach((l, i) => {
    const sha = `sha${i + 1}`;
    out.push(`${sha} ${i + 1} ${i + 1}`);
    out.push(`author ${l.author}`);
    out.push(`author-mail <${l.author.toLowerCase()}@example.com>`);
    out.push(`author-time 170000000${i}`);
    out.push(`author-tz +0000`);
    out.push(`summary commit ${i + 1}`);
    out.push(`filename src/file.ts`);
    out.push(`\tcontent line ${i + 1}`);
  });
  return out.join('\n');
}

function mockGitBlame(blameOutput: string): void {
  mockExecFileSync.mockImplementation((cmd: string, args: readonly string[] | undefined) => {
    const argList = (args ?? []) as string[];
    if (argList[0] === 'rev-parse') return Buffer.from('true');
    if (argList[0] === 'blame') return Buffer.from(blameOutput);
    return Buffer.from('');
  });
}

function mockNonGit(): void {
  mockExecFileSync.mockImplementation((cmd: string, args: readonly string[] | undefined) => {
    const argList = (args ?? []) as string[];
    if (argList[0] === 'rev-parse') {
      throw new Error('not a git repository');
    }
    return Buffer.from('');
  });
}

/**
 * Seed a file + symbol with a known line range so getSymbolOwnership can
 * resolve its file path and -L bounds.
 */
function seedSymbol(
  store: Store,
  filePath: string,
  symbolId: string,
  range: { start: number; end: number },
): void {
  const fileId = store.insertFile(filePath, 'typescript', `h-${filePath}`, 100);
  store.insertSymbol(fileId, {
    symbolId,
    name: symbolId.split(/[:#]/).filter(Boolean).pop() ?? 'sym',
    kind: 'function',
    byteStart: 0,
    byteEnd: 50,
    lineStart: range.start,
    lineEnd: range.end,
  });
}

describe('getSymbolOwnership() — behavioural contract (get_symbol_owners)', () => {
  let store: Store;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createTestStore();
  });

  it('returns owners with author/lines/percentage from git blame porcelain output', () => {
    seedSymbol(store, 'src/file.ts', 'sym:multiAuthor', { start: 1, end: 4 });
    mockGitBlame(
      blamePorcelain([
        { author: 'Alice' },
        { author: 'Alice' },
        { author: 'Alice' },
        { author: 'Bob' },
      ]),
    );

    const result = getSymbolOwnership(store, '/project', 'sym:multiAuthor');
    expect(result).not.toBeNull();
    expect(result!.symbol_id).toBe('sym:multiAuthor');
    expect(result!.total_lines).toBe(4);
    expect(result!.file).toBe('src/file.ts');
    expect(result!.lines).toEqual({ start: 1, end: 4 });
    // Sorted by lines descending.
    expect(result!.owners[0]).toEqual({ author: 'Alice', lines: 3, percentage: 75 });
    expect(result!.owners[1]).toEqual({ author: 'Bob', lines: 1, percentage: 25 });
  });

  it('single-author history returns one owner with 100%', () => {
    seedSymbol(store, 'src/single.ts', 'sym:single', { start: 10, end: 12 });
    mockGitBlame(blamePorcelain([{ author: 'Alice' }, { author: 'Alice' }, { author: 'Alice' }]));

    const result = getSymbolOwnership(store, '/project', 'sym:single');
    expect(result).not.toBeNull();
    expect(result!.owners).toEqual([{ author: 'Alice', lines: 3, percentage: 100 }]);
    expect(result!.total_lines).toBe(3);
  });

  it('owners are sorted by lines descending', () => {
    seedSymbol(store, 'src/many.ts', 'sym:many', { start: 1, end: 6 });
    mockGitBlame(
      blamePorcelain([
        { author: 'Carol' },
        { author: 'Alice' },
        { author: 'Alice' },
        { author: 'Bob' },
        { author: 'Bob' },
        { author: 'Bob' },
      ]),
    );

    const result = getSymbolOwnership(store, '/project', 'sym:many');
    expect(result).not.toBeNull();
    const sortedAuthors = result!.owners.map((o) => o.author);
    expect(sortedAuthors).toEqual(['Bob', 'Alice', 'Carol']);
    // Strictly non-increasing by lines.
    for (let i = 1; i < result!.owners.length; i++) {
      expect(result!.owners[i - 1].lines).toBeGreaterThanOrEqual(result!.owners[i].lines);
    }
  });

  it('unknown symbol_id returns null (clear empty envelope)', () => {
    // Mock git as a valid repo — but the symbol isn't in the store at all.
    mockGitBlame('');
    const result = getSymbolOwnership(store, '/project', 'sym:does-not-exist');
    expect(result).toBeNull();
  });

  it('non-git directory returns null (per fallback contract)', () => {
    seedSymbol(store, 'src/file.ts', 'sym:any', { start: 1, end: 3 });
    mockNonGit();
    const result = getSymbolOwnership(store, '/not-a-repo', 'sym:any');
    expect(result).toBeNull();
  });

  it('passes the symbol line range as -L<start>,<end> to git blame', () => {
    seedSymbol(store, 'src/file.ts', 'sym:bounds', { start: 42, end: 99 });
    mockGitBlame(blamePorcelain([{ author: 'Alice' }]));

    getSymbolOwnership(store, '/project', 'sym:bounds');

    const blameCall = mockExecFileSync.mock.calls.find((c) => {
      const args = (c[1] ?? []) as string[];
      return args[0] === 'blame';
    });
    expect(blameCall).toBeDefined();
    const argList = (blameCall![1] ?? []) as string[];
    expect(argList).toContain('--porcelain');
    expect(argList.some((a) => a === '-L42,99')).toBe(true);
    // Path passed after `--`.
    const dashIdx = argList.indexOf('--');
    expect(dashIdx).toBeGreaterThan(-1);
    expect(argList[dashIdx + 1]).toBe('src/file.ts');
  });
});
