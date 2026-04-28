import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getComplexityTrend } from '../../src/tools/analysis/complexity-trend.js';
import { createTestStore } from '../test-utils.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

describe('getComplexityTrend', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when not a git repo', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not a git repo');
    });
    const store = createTestStore();
    const fId = store.insertFile('src/a.ts', 'typescript', 'h1', 100);
    store.insertSymbol(fId, {
      symbolId: 'sym:foo',
      name: 'foo',
      kind: 'function',
      byteStart: 0,
      byteEnd: 100,
      metadata: { cyclomatic: 5, max_nesting: 2, param_count: 1 },
    });
    expect(getComplexityTrend(store, '/project', 'src/a.ts')).toBeNull();
  });

  it('returns trend with current and historical snapshots', () => {
    const simpleSource = 'function foo() {\n  return 1;\n}\n';
    const complexSource =
      'function foo(x) {\n  if (x > 0) {\n    for (const i of arr) {\n      if (i && valid) {\n        process(i);\n      }\n    }\n  }\n  return x;\n}\n';

    mockExecFileSync.mockImplementation((cmd: string, args: readonly string[] | undefined) => {
      const argList = args as string[];
      if (argList[0] === 'rev-parse') return Buffer.from('true');
      if (argList[0] === 'log') {
        return Buffer.from(['abc123|2026-03-01', 'def456|2026-01-15'].join('\n'));
      }
      if (argList[0] === 'show') {
        const ref = argList[1];
        if (ref.startsWith('abc123:')) return Buffer.from(complexSource);
        if (ref.startsWith('def456:')) return Buffer.from(simpleSource);
        return Buffer.from(simpleSource);
      }
      return Buffer.from('');
    });

    const store = createTestStore();
    const fId = store.insertFile('src/a.ts', 'typescript', 'h1', 100);
    // Current: high complexity
    store.insertSymbol(fId, {
      symbolId: 'sym:foo',
      name: 'foo',
      kind: 'function',
      byteStart: 0,
      byteEnd: 200,
      metadata: { cyclomatic: 8, max_nesting: 3, param_count: 1 },
    });

    const result = getComplexityTrend(store, '/project', 'src/a.ts');
    expect(result).not.toBeNull();
    expect(result!.file).toBe('src/a.ts');
    expect(result!.current.max_cyclomatic).toBe(8);
    expect(result!.historical.length).toBeGreaterThan(0);
    expect(result!.trend).toBeDefined();
    expect(typeof result!.delta).toBe('number');
  });

  it('returns null when file has no complexity data', () => {
    mockExecFileSync.mockImplementation((cmd: string, args: readonly string[] | undefined) => {
      const argList = args as string[];
      if (argList[0] === 'rev-parse') return Buffer.from('true');
      return Buffer.from('');
    });

    const store = createTestStore();
    store.insertFile('src/empty.ts', 'typescript', 'h1', 100);
    // No symbols with complexity
    expect(getComplexityTrend(store, '/project', 'src/empty.ts')).toBeNull();
  });
});
