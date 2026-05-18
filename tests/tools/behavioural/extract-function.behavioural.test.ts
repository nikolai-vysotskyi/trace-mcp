/**
 * Behavioural coverage for `extractFunction()` (the `extract_function` MCP tool).
 *
 * The tool is currently DISABLED pending an AST-aware rewrite — the previous
 * regex-based implementation produced unparseable output on non-trivial cases
 * (outer-scope identifiers misclassified as parameters; enclosing function
 * headers spliced into the new helper body). These tests pin the disabled
 * contract:
 *
 *  - on a valid file + line range the tool returns success:false with the
 *    sentinel `EXTRACT_FUNCTION_DISABLED_ERROR` and no edits
 *  - the source file is never mutated (no writes happen at all)
 *  - invalid line range (end < start, OOB) still returns the familiar
 *    "Invalid line range" error
 *  - missing file still returns a clean "File not found" error
 *
 * When the AST-aware rewrite lands these tests must be rewritten to assert
 * the new success contract — at that point the sentinel export goes away.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXTRACT_FUNCTION_DISABLED_ERROR,
  extractFunction,
} from '../../../src/tools/refactoring/refactor.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../../test-utils.js';

describe('extractFunction() — DISABLED behavioural contract', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('on a valid file + range returns the structured disabled error with no edits', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': [
        'function outer() {',
        '  const a = 1;',
        '  const b = 2;',
        '  const sum = a + b;',
        '  return sum;',
        '}',
      ].join('\n'),
    });

    const result = extractFunction(store, tmpDir, 'src/a.ts', 4, 4, 'computeSum', true);

    expect(result.success).toBe(false);
    expect(result.tool).toBe('extract_function');
    expect(result.edits).toEqual([]);
    expect(result.files_modified).toEqual([]);
    expect(result.error).toBe(EXTRACT_FUNCTION_DISABLED_ERROR);
    expect(result.error).toContain('extract_function-ast-rewrite');
  });

  it('returns the disabled error even when dry_run is false (no apply path)', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/b.ts': [
        'function caller() {',
        '  const x = 10;',
        '  const y = 20;',
        '  const z = x + y;',
        '  console.log(z);',
        '}',
      ].join('\n'),
    });
    const filePath = path.join(tmpDir, 'src/b.ts');
    const beforeContent = fs.readFileSync(filePath, 'utf-8');

    const result = extractFunction(store, tmpDir, 'src/b.ts', 4, 4, 'addXY', false);

    expect(result.success).toBe(false);
    expect(result.error).toBe(EXTRACT_FUNCTION_DISABLED_ERROR);
    // Hard guarantee: even the non-dry-run path must not touch the file.
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(beforeContent);
  });

  it('invalid line range (end < start, OOB) still returns the familiar "Invalid line range" error', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/d.ts': 'const x = 1;\nconst y = 2;\n',
    });

    const reversed = extractFunction(store, tmpDir, 'src/d.ts', 2, 1, 'bad', true);
    expect(reversed.success).toBe(false);
    expect(reversed.error).toBeDefined();
    expect(reversed.error).toContain('Invalid line range');
    expect(reversed.error).not.toContain('extract_function-ast-rewrite');
    expect(reversed.edits).toEqual([]);

    const oob = extractFunction(store, tmpDir, 'src/d.ts', 1, 99, 'bad', true);
    expect(oob.success).toBe(false);
    expect(oob.error).toContain('Invalid line range');
  });

  it('missing file returns clean error without throwing', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({ 'src/keep.ts': 'export const k = 1;\n' });

    const result = extractFunction(store, tmpDir, 'src/ghost.ts', 1, 1, 'f', true);

    expect(result.success).toBe(false);
    expect(result.error).toContain('File not found');
    expect(result.error).not.toContain('extract_function-ast-rewrite');
    expect(result.edits).toEqual([]);
  });

  it('source file mtime is unchanged after a disabled-path call', async () => {
    const store = createTestStore();
    const original = [
      'function f() {',
      '  const a = 1;',
      '  const b = a + 1;',
      '  return b;',
      '}',
      '',
    ].join('\n');
    tmpDir = createTmpFixture({ 'src/e.ts': original });
    const filePath = path.join(tmpDir, 'src/e.ts');
    const beforeMtime = fs.statSync(filePath).mtimeMs;
    await new Promise((r) => setTimeout(r, 5));

    const result = extractFunction(store, tmpDir, 'src/e.ts', 3, 3, 'addOne', true);
    expect(result.success).toBe(false);
    expect(result.error).toBe(EXTRACT_FUNCTION_DISABLED_ERROR);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(original);
    expect(fs.statSync(filePath).mtimeMs).toBe(beforeMtime);
  });
});
