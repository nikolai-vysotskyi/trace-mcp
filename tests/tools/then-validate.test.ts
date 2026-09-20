import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { applyRename } from '../../src/tools/refactoring/refactor.js';
import type { RefactorResult } from '../../src/tools/refactoring/shared.js';
import {
  assertFilesUnchanged,
  executeMutationThenValidate,
  symbolFileAbs,
  THEN_VALIDATE_FAILED,
  THEN_VALIDATE_SKIPPED,
  THEN_VALIDATE_SUCCEEDED,
  type ThenValidationReport,
  withFusedFileQueue,
} from '../../src/tools/refactoring/then-validate.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

function okResult(files: string[] = ['src/a.ts']): RefactorResult {
  return { success: true, tool: 'test', edits: [], files_modified: files, warnings: [] };
}

function failResult(): RefactorResult {
  return {
    success: false,
    tool: 'test',
    edits: [],
    files_modified: [],
    warnings: [],
    error: 'boom',
  };
}

function cleanReport(): ThenValidationReport {
  return { checker: 'tsc', total_errors: 0, files: [] };
}

function errorReport(): ThenValidationReport {
  return {
    checker: 'tsc',
    total_errors: 1,
    files: [
      {
        file: 'src/a.ts',
        total_file_errors: 1,
        truncated_in_file: 0,
        diagnostics: [
          {
            line: 1,
            column: 7,
            severity: 'error',
            message: "Type 'string' is not assignable to type 'number'.",
            code: 'TS2322',
          },
        ],
      },
    ],
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function insertFileSymbol(store: Store, filePath: string, name: string): void {
  const fileId = store.insertFile(filePath, 'typescript', `hash_${filePath}`, 100);
  store.insertSymbol(fileId, {
    symbolId: `${filePath}::${name}#function`,
    name,
    kind: 'function',
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 3,
    metadata: undefined,
  });
}

// ════════════════════════════════════════════════════════════════════════
// FLAG ABSENT → 1:1 PASSTHROUGH
// ════════════════════════════════════════════════════════════════════════

describe('executeMutationThenValidate — flag absent', () => {
  it('returns mutate() verbatim without calling validation', async () => {
    const runValidation = vi.fn(async () => cleanReport());
    const expected = okResult();
    const result = await executeMutationThenValidate({
      store: null,
      projectRoot: '/tmp',
      queueKey: undefined,
      thenValidate: undefined,
      dryRun: false,
      mutate: () => expected,
      runValidation,
    });
    expect(result).toBe(expected);
    expect('validation' in result).toBe(false);
    expect(runValidation).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════
// SKIP PATHS
// ════════════════════════════════════════════════════════════════════════

describe('executeMutationThenValidate — skip paths', () => {
  it('skips validation when the mutation fails', async () => {
    const runValidation = vi.fn(async () => cleanReport());
    const result = await executeMutationThenValidate({
      store: null,
      projectRoot: '/tmp',
      queueKey: undefined,
      thenValidate: true,
      dryRun: false,
      mutate: () => failResult(),
      runValidation,
    });
    expect(result.success).toBe(false);
    expect(result.validation?.marker).toBe(THEN_VALIDATE_SKIPPED);
    expect(runValidation).not.toHaveBeenCalled();
  });

  it('skips validation on dry_run preview', async () => {
    const runValidation = vi.fn(async () => cleanReport());
    const result = await executeMutationThenValidate({
      store: null,
      projectRoot: '/tmp',
      queueKey: undefined,
      thenValidate: true,
      dryRun: true,
      mutate: () => okResult(),
      runValidation,
    });
    expect(result.success).toBe(true);
    expect(result.validation?.marker).toBe(THEN_VALIDATE_SKIPPED);
    expect(result.validation?.reason).toContain('dry_run');
    expect(runValidation).not.toHaveBeenCalled();
  });

  it('skips validation when no files were modified', async () => {
    const runValidation = vi.fn(async () => cleanReport());
    const result = await executeMutationThenValidate({
      store: null,
      projectRoot: '/tmp',
      queueKey: undefined,
      thenValidate: true,
      dryRun: false,
      mutate: () => okResult([]),
      runValidation,
    });
    expect(result.validation?.marker).toBe(THEN_VALIDATE_SKIPPED);
    expect(runValidation).not.toHaveBeenCalled();
  });

  it('hashes after the mutation completes, so own writes do not trip the guard', async () => {
    const tmpDir = createTmpFixture({ 'src/a.ts': 'export const x = 1;\n' });
    try {
      const runValidation = vi.fn(async () => cleanReport());
      const result = await executeMutationThenValidate({
        store: null,
        projectRoot: tmpDir,
        queueKey: undefined,
        thenValidate: true,
        dryRun: false,
        mutate: () => {
          // Intervening change between the mutation and validation.
          fs.writeFileSync(path.join(tmpDir, 'src/a.ts'), 'export const x = 2;\n');
          return okResult();
        },
        runValidation,
      });
      // The mutate-write itself is the last write before hashing, so hashing is
      // stable — validation still runs. A genuine race (write between the two
      // hashes) is covered by assertFilesUnchanged's own seam below.
      expect(runValidation).toHaveBeenCalledTimes(1);
      expect(result.validation?.marker).toBe(THEN_VALIDATE_SUCCEEDED);
    } finally {
      removeTmpDir(tmpDir);
    }
  });

  it('fail-open: validation infra error keeps the mutation', async () => {
    const runValidation = vi.fn(async () => {
      throw new Error('tsc not installed');
    });
    const result = await executeMutationThenValidate({
      store: null,
      projectRoot: '/tmp',
      queueKey: undefined,
      thenValidate: true,
      dryRun: false,
      mutate: () => okResult(),
      runValidation,
    });
    expect(result.success).toBe(true);
    expect(result.validation?.marker).toBe(THEN_VALIDATE_SKIPPED);
    expect(result.warnings.some((w) => w.includes('then_validate skipped'))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// FUSED VALIDATION OUTCOMES
// ════════════════════════════════════════════════════════════════════════

describe('executeMutationThenValidate — fused outcomes', () => {
  let tmpDir = '';

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
    tmpDir = '';
  });

  it('attaches errors without rolling back the mutation', async () => {
    tmpDir = createTmpFixture({ 'src/a.ts': 'export const x = 1;\n' });
    const runValidation = vi.fn(async () => errorReport());
    const result = await executeMutationThenValidate({
      store: null,
      projectRoot: tmpDir,
      queueKey: undefined,
      thenValidate: true,
      dryRun: false,
      mutate: () => okResult(),
      runValidation,
    });
    expect(result.success).toBe(true);
    expect(result.validation?.marker).toBe(THEN_VALIDATE_FAILED);
    expect(result.validation?.checker).toBe('tsc');
    expect(result.validation?.total_errors).toBe(1);
    expect(result.validation?.files?.[0].file).toBe('src/a.ts');
    expect(result.warnings.some((w) => w.includes('mutation kept'))).toBe(true);
    // Mutation stands: no rollback attempted.
    expect(fs.readFileSync(path.join(tmpDir, 'src/a.ts'), 'utf-8')).toBe('export const x = 1;\n');
    expect(runValidation).toHaveBeenCalledTimes(1);
  });

  it('clean validation reports success', async () => {
    tmpDir = createTmpFixture({ 'src/a.ts': 'export const x = 1;\n' });
    const result = await executeMutationThenValidate({
      store: null,
      projectRoot: tmpDir,
      queueKey: undefined,
      thenValidate: true,
      dryRun: false,
      mutate: () => okResult(),
      runValidation: async () => cleanReport(),
    });
    expect(result.success).toBe(true);
    expect(result.validation?.marker).toBe(THEN_VALIDATE_SUCCEEDED);
    expect(result.validation?.total_errors).toBe(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('works without a queue key (fail-open when primary file unknown)', async () => {
    tmpDir = createTmpFixture({ 'src/a.ts': 'export const x = 1;\n' });
    const result = await executeMutationThenValidate({
      store: null,
      projectRoot: tmpDir,
      queueKey: undefined,
      thenValidate: true,
      dryRun: false,
      mutate: () => okResult(),
      runValidation: async () => cleanReport(),
    });
    expect(result.validation?.marker).toBe(THEN_VALIDATE_SUCCEEDED);
  });
});

// ════════════════════════════════════════════════════════════════════════
// PER-FILE QUEUE
// ════════════════════════════════════════════════════════════════════════

describe('withFusedFileQueue', () => {
  let tmpDir = '';

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
    tmpDir = '';
  });

  it('serializes concurrent fused calls on the same file', async () => {
    tmpDir = createTmpFixture({
      'src/a.ts': 'a',
      'src/b.ts': 'b',
    });
    // The queue guarantees mutual exclusion, not FIFO order: whichever call
    // acquires the slot first runs to completion before the other starts.
    const spans = new Map<string, { start: number; end: number }>();
    const fused = (tag: string): Promise<RefactorResult> =>
      executeMutationThenValidate({
        store: null,
        projectRoot: tmpDir,
        queueKey: path.join(tmpDir, 'src/a.ts'),
        thenValidate: true,
        dryRun: false,
        mutate: async () => {
          const start = Date.now();
          await sleep(30);
          spans.set(tag, { start, end: Date.now() });
          return okResult(['src/a.ts']);
        },
        runValidation: async () => cleanReport(),
      });

    const [r1, r2] = await Promise.all([fused('1'), fused('2')]);
    expect(r1.validation?.marker).toBe(THEN_VALIDATE_SUCCEEDED);
    expect(r2.validation?.marker).toBe(THEN_VALIDATE_SUCCEEDED);
    const a = spans.get('1');
    const b = spans.get('2');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.end <= b!.start || b!.end <= a!.start).toBe(true);
  });

  it('lets different files run concurrently', async () => {
    tmpDir = createTmpFixture({
      'src/a.ts': 'a',
      'src/b.ts': 'b',
    });
    let live = 0;
    let maxLive = 0;
    const fused = (key: string): Promise<RefactorResult> =>
      executeMutationThenValidate({
        store: null,
        projectRoot: tmpDir,
        queueKey: path.join(tmpDir, key),
        thenValidate: true,
        dryRun: false,
        mutate: async () => {
          live += 1;
          maxLive = Math.max(maxLive, live);
          await sleep(30);
          live -= 1;
          return okResult([key]);
        },
        runValidation: async () => cleanReport(),
      });

    await Promise.all([fused('src/a.ts'), fused('src/b.ts')]);
    expect(maxLive).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════
// HASH GUARD
// ════════════════════════════════════════════════════════════════════════

describe('assertFilesUnchanged', () => {
  let tmpDir = '';

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
    tmpDir = '';
  });

  it('passes when files are untouched', async () => {
    tmpDir = createTmpFixture({ 'src/a.ts': 'x' });
    await expect(assertFilesUnchanged([path.join(tmpDir, 'src/a.ts')])).resolves.toBeUndefined();
  });

  it('throws a skip marker on intervening change', async () => {
    tmpDir = createTmpFixture({ 'src/a.ts': 'x' });
    const abs = path.join(tmpDir, 'src/a.ts');
    await expect(
      assertFilesUnchanged([abs], async () => {
        fs.writeFileSync(abs, 'changed');
      }),
    ).rejects.toThrow(THEN_VALIDATE_SKIPPED);
  });

  it('throws a skip marker when the file vanishes', async () => {
    tmpDir = createTmpFixture({ 'src/a.ts': 'x' });
    const abs = path.join(tmpDir, 'src/a.ts');
    await expect(
      assertFilesUnchanged([abs], async () => {
        fs.rmSync(abs);
      }),
    ).rejects.toThrow(THEN_VALIDATE_SKIPPED);
  });
});

// ════════════════════════════════════════════════════════════════════════
// INTEGRATION WITH REAL MUTATION
// ════════════════════════════════════════════════════════════════════════

describe('then_validate with real applyRename', () => {
  let store: Store;
  let tmpDir = '';

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
    tmpDir = '';
  });

  it('fuses rename + validation; failure skips validation', async () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'export function oldName() {\n  return oldName;\n}\n',
    });
    insertFileSymbol(store, 'src/a.ts', 'oldName');

    const runValidation = vi.fn(async () => errorReport());
    const result = await executeMutationThenValidate({
      store,
      projectRoot: tmpDir,
      queueKey: symbolFileAbs(store, tmpDir, 'src/a.ts::oldName#function'),
      thenValidate: true,
      dryRun: false,
      mutate: () => applyRename(store, tmpDir, 'src/a.ts::oldName#function', 'newName', false),
      runValidation,
    });
    expect(result.success).toBe(true);
    expect(result.validation?.marker).toBe(THEN_VALIDATE_FAILED);
    expect(fs.readFileSync(path.join(tmpDir, 'src/a.ts'), 'utf-8')).toContain('newName');

    // Failed mutation → validation skipped, runner untouched.
    const runValidation2 = vi.fn(async () => cleanReport());
    const failed = await executeMutationThenValidate({
      store,
      projectRoot: tmpDir,
      queueKey: undefined,
      thenValidate: true,
      dryRun: false,
      mutate: () => applyRename(store, tmpDir, 'missing#function', 'x', false),
      runValidation: runValidation2,
    });
    expect(failed.success).toBe(false);
    expect(failed.validation?.marker).toBe(THEN_VALIDATE_SKIPPED);
    expect(runValidation2).not.toHaveBeenCalled();
  });

  it('symbolFileAbs resolves the definition file, undefined when unknown', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({ 'src/a.ts': 'export function foo() {}\n' });
    insertFileSymbol(store, 'src/a.ts', 'foo');
    expect(symbolFileAbs(store, tmpDir, 'src/a.ts::foo#function')).toBe(
      path.join(tmpDir, 'src/a.ts'),
    );
    expect(symbolFileAbs(store, tmpDir, 'nope#function')).toBeUndefined();
  });
});
