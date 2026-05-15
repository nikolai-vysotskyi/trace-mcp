/**
 * Behavioural coverage for `extractFunction()` (the `extract_function` MCP tool).
 * Uses dry_run exclusively so fixture files on disk are never mutated.
 *
 *  - dry_run preview produces edits + extractedFunction text containing the
 *    declaration with the chosen name
 *  - detects free variables (defined before the range) → emitted as parameters
 *    in a warning
 *  - detects defined-then-used-after variables → emitted as return values in a
 *    warning
 *  - invalid line range (end < start, OOB) returns a clean error string and
 *    success:false with no edits
 *  - missing file returns a clean "File not found" error
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractFunction } from '../../../src/tools/refactoring/refactor.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../../test-utils.js';

describe('extractFunction() — behavioural contract (dry_run path)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('dry_run preview returns edits with the new function declaration as new_text', () => {
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

    expect(result.success).toBe(true);
    expect(result.tool).toBe('extract_function');
    expect(result.edits.length).toBeGreaterThan(0);
    expect(result.edits[0].file).toBe('src/a.ts');
    expect(result.edits[0].new_text).toContain('function computeSum');
    expect(result.error).toBeUndefined();
  });

  it('detects free variables in the extracted body and surfaces them as parameters', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/b.ts': [
        'function caller() {',
        '  const x = 10;',
        '  const y = 20;',
        '  const z = x + y;', // line 4 — uses x and y from outer scope
        '  console.log(z);',
        '}',
      ].join('\n'),
    });

    const result = extractFunction(store, tmpDir, 'src/b.ts', 4, 4, 'addXY', true);

    expect(result.success).toBe(true);
    // Parameters are reported via warnings text — `x` and `y` are defined
    // before the range and read inside it.
    const paramWarning = result.warnings.find((w) => w.includes('parameter'));
    expect(paramWarning).toBeDefined();
    expect(paramWarning!).toMatch(/x|y/);
  });

  it('detects defined-then-used-after variables and surfaces them as return values', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/c.ts': [
        'function caller() {',
        '  const a = 1;',
        '  const result = a * 2;', // line 3 — defines `result`
        '  console.log(result);', // line 4 — uses `result` after the range
        '}',
      ].join('\n'),
    });

    const result = extractFunction(store, tmpDir, 'src/c.ts', 3, 3, 'doubleA', true);

    expect(result.success).toBe(true);
    const returnWarning = result.warnings.find((w) => w.includes('return'));
    expect(returnWarning).toBeDefined();
    expect(returnWarning!).toContain('result');
  });

  it('invalid line range (end < start, OOB) returns clean error and success:false', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/d.ts': 'const x = 1;\nconst y = 2;\n',
    });

    const reversed = extractFunction(store, tmpDir, 'src/d.ts', 2, 1, 'bad', true);
    expect(reversed.success).toBe(false);
    expect(reversed.error).toBeDefined();
    expect(reversed.error).toContain('Invalid line range');
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
    expect(result.edits).toEqual([]);
  });

  it('dry_run does NOT mutate the source file on disk', async () => {
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
    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(original);
    expect(fs.statSync(filePath).mtimeMs).toBe(beforeMtime);
  });
});
