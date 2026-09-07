/**
 * Behavioural coverage for `getTechDebt()` in
 * `src/tools/analysis/predictive-intelligence.ts` (the implementation
 * behind the `get_tech_debt` MCP tool). Returns a per-module tech-debt
 * score / grade derived from complexity, coupling, test gap, and churn.
 *
 * The implementation calls `getGitFileStatsWithFixes` which uses
 * `execFileSync` under the hood. We force the non-git branch via
 * `isGitRepo === false` semantics — easier than mocking git here — so the
 * focus stays on the scoring/grading contract.
 */

import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getTechDebt } from '../../../src/tools/analysis/predictive-intelligence.js';
import { createTestStore } from '../../test-utils.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

/** Force the "not a git repo" branch — keeps churn signals at zero. */
function mockNonGit(): void {
  mockExecFileSync.mockImplementation((cmd: string, args: readonly string[] | undefined) => {
    const argList = (args ?? []) as string[];
    if (argList[0] === 'rev-parse') {
      throw new Error('not a git repository');
    }
    return Buffer.from('');
  });
}

function insertFile(store: Store, filePath: string): number {
  return store.insertFile(filePath, 'typescript', `h-${filePath}`, 100);
}

function insertFn(store: Store, fileId: number, name: string, cyclomatic: number): number {
  return store.insertSymbol(fileId, {
    symbolId: `sym:file${fileId}::${name}`,
    name,
    kind: 'function',
    byteStart: 0,
    byteEnd: 50,
    metadata: { cyclomatic },
  });
}

/**
 * Seed a "tools/foo.ts" and "tools/bar.ts" pair under a single `src/tools`
 * module plus a "lib/leaf.ts" in a separate `src/lib` module. With
 * moduleDepth=2 (default) this yields the modules "src/tools" and
 * "src/lib".
 */
function seedTwoModuleProject(store: Store): void {
  const fFoo = insertFile(store, 'src/tools/foo.ts');
  const fBar = insertFile(store, 'src/tools/bar.ts');
  const fLeaf = insertFile(store, 'src/lib/leaf.ts');

  // High complexity in src/tools.
  insertFn(store, fFoo, 'hotFn', 18);
  insertFn(store, fBar, 'warmFn', 12);

  // Low complexity in src/lib.
  insertFn(store, fLeaf, 'simpleFn', 2);

  // Padding above MIN_SYMBOLS_FOR_GRADE (TRA-1057) — cyclomatic 0 so these
  // don't skew the complexity average, they exist only to keep this fixture
  // past the "enough data to grade" floor the other tests below exercise.
  for (let i = 0; i < 20; i++) insertFn(store, fFoo, `helper${i}`, 0);
}

describe('getTechDebt() — behavioural contract (get_tech_debt)', () => {
  let store: Store;

  beforeEach(() => {
    vi.clearAllMocks();
    mockNonGit();
    store = createTestStore();
  });

  it('returns ok envelope with project_score + project_grade + modules[]', () => {
    seedTwoModuleProject(store);

    const result = getTechDebt(store, '/project');
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();

    expect(typeof value.project_score).toBe('number');
    expect(['A', 'B', 'C', 'D', 'F']).toContain(value.project_grade);
    expect(Array.isArray(value.modules)).toBe(true);
    expect(value.modules.length).toBeGreaterThan(0);

    for (const m of value.modules) {
      expect(typeof m.module).toBe('string');
      expect(['A', 'B', 'C', 'D', 'F']).toContain(m.grade);
      expect(typeof m.score).toBe('number');
      expect(m.breakdown).toHaveProperty('complexity');
      expect(m.breakdown).toHaveProperty('coupling');
      expect(m.breakdown).toHaveProperty('test_gap');
      expect(m.breakdown).toHaveProperty('churn');
      expect(typeof m.file_count).toBe('number');
      expect(Array.isArray(m.recommendations)).toBe(true);
    }
  });

  it('modules are sorted by score descending (worst debt first)', () => {
    seedTwoModuleProject(store);

    const value = getTechDebt(store, '/project')._unsafeUnwrap();
    for (let i = 1; i < value.modules.length; i++) {
      expect(value.modules[i - 1].score).toBeGreaterThanOrEqual(value.modules[i].score);
    }
    // src/tools (high complexity) should rank above src/lib (low complexity).
    const idxTools = value.modules.findIndex((m) => m.module === 'src/tools');
    const idxLib = value.modules.findIndex((m) => m.module === 'src/lib');
    expect(idxTools).toBeGreaterThanOrEqual(0);
    expect(idxLib).toBeGreaterThanOrEqual(0);
    expect(idxTools).toBeLessThan(idxLib);
  });

  it('`module` option restricts output to that single module', () => {
    seedTwoModuleProject(store);

    const value = getTechDebt(store, '/project', { module: 'src/tools' })._unsafeUnwrap();
    expect(value.modules.length).toBe(1);
    expect(value.modules[0].module).toBe('src/tools');
  });

  it('recommendations surface complexity > threshold with high priority', () => {
    // Crank cyclomatic high enough to drive sComplexity > 0.7 (clampNormalize / 15).
    const fHot = insertFile(store, 'src/tools/heavy.ts');
    insertFn(store, fHot, 'monster', 30);

    const value = getTechDebt(store, '/project')._unsafeUnwrap();
    const tools = value.modules.find((m) => m.module === 'src/tools');
    expect(tools).toBeDefined();
    expect(tools!.breakdown.complexity).toBeGreaterThan(0.7);
    const complexityRec = tools!.recommendations.find((r) =>
      r.action.toLowerCase().includes('complexity'),
    );
    expect(complexityRec).toBeDefined();
    expect(complexityRec!.priority).toBe('high');
  });

  it('empty index returns ok envelope with empty modules + no grade (TRA-1057)', () => {
    const empty = createTestStore();
    const value = getTechDebt(empty, '/project')._unsafeUnwrap();
    expect(value.modules).toEqual([]);
    expect(value.project_score).toBe(0);
    // No modules → nothing was scored. `null`, not the "A" a naive
    // mean-of-zero would produce — an empty project isn't a healthy one.
    expect(value.project_grade).toBeNull();
  });

  it('a handful of symbols scores modules but withholds project_grade (TRA-1057)', () => {
    // 1 file / 1 symbol — same shape as the real `tra925proj` fixture that
    // shipped a grade B on essentially no data.
    const fLeaf = insertFile(store, 'src/lib/leaf.ts');
    insertFn(store, fLeaf, 'simpleFn', 2);

    const value = getTechDebt(store, '/project')._unsafeUnwrap();
    // The module itself is still scored/returned — useful detail for anyone
    // calling get_tech_debt directly — only the project-level rollup grade
    // is withheld for being too small a sample to mean anything.
    expect(value.modules.length).toBeGreaterThan(0);
    expect(value.project_grade).toBeNull();
  });
});
