import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { Store } from '../../src/db/store.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { getFileOwnership, getSymbolOwnership } from '../../src/tools/git-ownership.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

function createStore(): Store {
  const db = initializeDatabase(':memory:');
  return new Store(db);
}

describe('getFileOwnership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty when not a git repo', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not a git repo');
    });
    expect(getFileOwnership('/project', ['src/a.ts'])).toEqual([]);
  });

  it('parses git shortlog output', () => {
    mockExecFileSync.mockImplementation((cmd: string, args: readonly string[] | undefined) => {
      const argList = args as string[];
      if (argList[0] === 'rev-parse') return Buffer.from('true');
      if (argList[0] === 'shortlog') {
        return Buffer.from([
          '    15\tAlice',
          '     8\tBob',
          '     2\tCharlie',
        ].join('\n'));
      }
      return Buffer.from('');
    });

    const result = getFileOwnership('/project', ['src/a.ts']);
    expect(result.length).toBe(1);
    expect(result[0].file).toBe('src/a.ts');
    expect(result[0].total_commits).toBe(25);
    expect(result[0].owners[0].author).toBe('Alice');
    expect(result[0].owners[0].commits).toBe(15);
    expect(result[0].owners[0].percentage).toBe(60);
  });
});

describe('getSymbolOwnership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when not a git repo', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not a git repo');
    });
    const store = createStore();
    expect(getSymbolOwnership(store, '/project', 'sym:foo')).toBeNull();
  });

  it('parses git blame porcelain output', () => {
    mockExecFileSync.mockImplementation((cmd: string, args: readonly string[] | undefined) => {
      const argList = args as string[];
      if (argList[0] === 'rev-parse') return Buffer.from('true');
      if (argList[0] === 'blame') {
        return Buffer.from([
          'abc123 1 1 3',
          'author Alice',
          'author-mail <alice@example.com>',
          'author-time 1700000000',
          'author-tz +0000',
          'summary initial commit',
          'filename src/a.ts',
          '\tfunction foo() {',
          'abc123 2 2',
          'author Alice',
          'author-mail <alice@example.com>',
          'author-time 1700000000',
          'author-tz +0000',
          'summary initial commit',
          'filename src/a.ts',
          '\t  return 42;',
          'def456 3 3',
          'author Bob',
          'author-mail <bob@example.com>',
          'author-time 1700100000',
          'author-tz +0000',
          'summary fix return',
          'filename src/a.ts',
          '\t}',
        ].join('\n'));
      }
      return Buffer.from('');
    });

    const store = createStore();
    const fileId = store.insertFile('src/a.ts', 'typescript', 'h1', 100);
    store.insertSymbol(fileId, {
      symbolId: 'sym:foo',
      name: 'foo',
      kind: 'function',
      byteStart: 0,
      byteEnd: 50,
      lineStart: 1,
      lineEnd: 3,
    });

    const result = getSymbolOwnership(store, '/project', 'sym:foo');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('foo');
    expect(result!.total_lines).toBe(3);
    expect(result!.owners[0].author).toBe('Alice');
    expect(result!.owners[0].lines).toBe(2);
    expect(result!.owners[1].author).toBe('Bob');
    expect(result!.owners[1].lines).toBe(1);
  });
});
