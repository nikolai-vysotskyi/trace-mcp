import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { getChurnRate, getHotspots, isGitRepo } from '../../src/tools/git/git-analysis.js';
import { createTestStore } from '../test-utils.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

function insertFileWithComplexity(store: Store, path: string, cyclomatic: number): number {
  const fileId = store.insertFile(path, 'typescript', `hash_${path}`, 100);
  store.insertSymbol(fileId, {
    symbolId: `sym:${path}::main`,
    name: 'main',
    kind: 'function',
    byteStart: 0,
    byteEnd: 100,
    metadata: { cyclomatic, max_nesting: 2, param_count: 1 },
  });
  return fileId;
}

describe('isGitRepo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when git succeeds', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('true'));
    expect(isGitRepo('/project')).toBe(true);
  });

  it('returns false when git fails', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not a git repo');
    });
    expect(isGitRepo('/project')).toBe(false);
  });
});

describe('getChurnRate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty when not a git repo', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not a git repo');
    });
    const result = getChurnRate('/project');
    expect(result).toEqual([]);
  });

  it('parses git log output into churn entries', () => {
    // First call: isGitRepo check
    mockExecFileSync.mockImplementation((cmd: string, args: readonly string[] | undefined) => {
      const argList = args as string[];
      if (argList[0] === 'rev-parse') return Buffer.from('true');
      if (argList[0] === 'log') {
        return Buffer.from(
          [
            '__COMMIT__abc123|2026-03-01T10:00:00Z|Alice',
            'src/a.ts',
            'src/b.ts',
            '',
            '__COMMIT__def456|2026-03-15T10:00:00Z|Bob',
            'src/a.ts',
            '',
            '__COMMIT__ghi789|2026-04-01T10:00:00Z|Alice',
            'src/a.ts',
            'src/c.ts',
          ].join('\n'),
        );
      }
      return Buffer.from('');
    });

    const result = getChurnRate('/project');

    // src/a.ts: 3 commits, 2 authors
    const a = result.find((r) => r.file === 'src/a.ts')!;
    expect(a).toBeDefined();
    expect(a.commits).toBe(3);
    expect(a.unique_authors).toBe(2);
    expect(a.first_seen).toBe('2026-03-01');
    expect(a.last_modified).toBe('2026-04-01');

    // src/b.ts: 1 commit
    const b = result.find((r) => r.file === 'src/b.ts')!;
    expect(b.commits).toBe(1);
    expect(b.unique_authors).toBe(1);
    expect(b.assessment).toBe('stable');

    // Sorted by commits desc
    expect(result[0].file).toBe('src/a.ts');
  });

  it('filters by file pattern', () => {
    mockExecFileSync.mockImplementation((cmd: string, args: readonly string[] | undefined) => {
      const argList = args as string[];
      if (argList[0] === 'rev-parse') return Buffer.from('true');
      if (argList[0] === 'log') {
        return Buffer.from(
          ['__COMMIT__abc|2026-03-01T10:00:00Z|Alice', 'src/a.ts', 'docs/readme.md'].join('\n'),
        );
      }
      return Buffer.from('');
    });

    const result = getChurnRate('/project', { filePattern: 'src/' });
    expect(result.length).toBe(1);
    expect(result[0].file).toBe('src/a.ts');
  });
});

describe('getHotspots', () => {
  beforeEach(() => vi.clearAllMocks());

  it('falls back to complexity-only when git unavailable', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not a git repo');
    });

    const store = createTestStore();
    insertFileWithComplexity(store, 'src/complex.ts', 15);
    insertFileWithComplexity(store, 'src/simple.ts', 2);

    const result = getHotspots(store, '/project');

    // Only src/complex.ts passes minCyclomatic=3
    expect(result.length).toBe(1);
    expect(result[0].file).toBe('src/complex.ts');
    expect(result[0].max_cyclomatic).toBe(15);
    expect(result[0].commits).toBe(0);
    expect(result[0].score).toBe(15); // complexity-only fallback
  });

  it('computes hotspot score = complexity × log(1+commits)', () => {
    mockExecFileSync.mockImplementation((cmd: string, args: readonly string[] | undefined) => {
      const argList = args as string[];
      if (argList[0] === 'rev-parse') return Buffer.from('true');
      if (argList[0] === 'log') {
        return Buffer.from(
          [
            '__COMMIT__a|2026-03-01T10:00:00Z|Alice',
            'src/hot.ts',
            '__COMMIT__b|2026-03-05T10:00:00Z|Bob',
            'src/hot.ts',
            '__COMMIT__c|2026-03-10T10:00:00Z|Alice',
            'src/hot.ts',
            '__COMMIT__d|2026-03-15T10:00:00Z|Bob',
            'src/hot.ts',
            '__COMMIT__e|2026-03-20T10:00:00Z|Alice',
            'src/hot.ts',
            '__COMMIT__f|2026-03-01T10:00:00Z|Alice',
            'src/cold.ts',
          ].join('\n'),
        );
      }
      return Buffer.from('');
    });

    const store = createTestStore();
    insertFileWithComplexity(store, 'src/hot.ts', 12);
    insertFileWithComplexity(store, 'src/cold.ts', 12);

    const result = getHotspots(store, '/project');

    // hot.ts: 12 × log(1+5) = 12 × 1.79 ≈ 21.5
    // cold.ts: 12 × log(1+1) = 12 × 0.69 ≈ 8.3
    expect(result.length).toBe(2);
    expect(result[0].file).toBe('src/hot.ts');
    expect(result[0].commits).toBe(5);
    expect(result[0].score).toBeGreaterThan(result[1].score);
    expect(result[0].assessment).toBe('high');
  });

  it('respects minCyclomatic filter', () => {
    mockExecFileSync.mockImplementation((cmd: string, args: readonly string[] | undefined) => {
      const argList = args as string[];
      if (argList[0] === 'rev-parse') return Buffer.from('true');
      return Buffer.from('');
    });

    const store = createTestStore();
    insertFileWithComplexity(store, 'src/simple.ts', 2);

    const result = getHotspots(store, '/project', { minCyclomatic: 5 });
    expect(result).toEqual([]);
  });
});
