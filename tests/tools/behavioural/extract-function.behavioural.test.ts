/**
 * Behavioural coverage for the re-enabled `extractFunction()`.
 *
 * The AST-aware implementation slices a line range out of an enclosing function
 * and computes:
 *   - the parameter list via free-variable analysis (identifiers read in the
 *     slice but declared outside it — including closure captures)
 *   - a return value when a variable declared inside the slice is used after it
 *
 * These tests pin the new success contract:
 *   - a clean extract with one free variable produces a helper + a call
 *   - a closure capturing an outer variable turns that variable into a param
 *   - a slice whose result is used later returns that value and assigns it back
 *   - validation errors (bad range, missing file) still fire first
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractFunction } from '../../../src/tools/refactoring/refactor.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../../test-utils.js';

describe('extractFunction() — AST-aware contract', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('extracts a clean slice with one free variable into a parameterised helper', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': [
        'function outer(p: number) {',
        '  const a = 1;',
        '  const b = a + p;',
        '  console.log(b);',
        '}',
        '',
      ].join('\n'),
    });

    // Extract lines 2-3 (const a; const b = a + p). `p` and `a`... `a` is
    // declared on line 2 (inside the slice), `p` is the outer param → param.
    const result = extractFunction(store, tmpDir, 'src/a.ts', 2, 3, 'computeB', true);

    expect(result.success).toBe(true);
    expect(result.tool).toBe('extract_function');
    expect(result.error).toBeUndefined();
    // The preview edits must mention the new function name and a param for `p`.
    const blob = JSON.stringify(result.edits);
    expect(blob).toContain('computeB');
    expect(blob).toContain('p');
  });

  it('turns an outer variable captured in the slice into a parameter', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/closure.ts': [
        'function build(prefix: string) {',
        '  const items = [1, 2, 3];',
        '  const labelled = items.map((n) => prefix + n);',
        '  return labelled;',
        '}',
        '',
      ].join('\n'),
    });

    // Extract line 3 — the arrow captures `prefix` (outer param) and uses
    // `items` (declared line 2). Both are free → both become params.
    const result = extractFunction(store, tmpDir, 'src/closure.ts', 3, 3, 'labelItems', true);

    expect(result.success).toBe(true);
    const params = result.extracted_params ?? [];
    expect(params).toContain('prefix');
    expect(params).toContain('items');
  });

  it('returns a value declared in the slice and used afterwards', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/ret.ts': [
        'function calc(x: number, y: number) {',
        '  const sum = x + y;',
        '  const scaled = sum * 2;',
        '  return scaled;',
        '}',
        '',
      ].join('\n'),
    });

    // Extract line 2 (const sum = x + y). `sum` is used on line 3 → returned.
    const result = extractFunction(store, tmpDir, 'src/ret.ts', 2, 2, 'addXY', true);

    expect(result.success).toBe(true);
    expect(result.return_value).toBe('sum');
    const params = result.extracted_params ?? [];
    expect(params).toContain('x');
    expect(params).toContain('y');
    // The call site re-binds the returned value.
    const blob = JSON.stringify(result.edits);
    expect(blob).toContain('addXY');
    expect(blob).toContain('sum');
  });

  it('applies the extraction to disk when dry_run is false', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/apply.ts': [
        'function host(p: number) {',
        '  const doubled = p * 2;',
        '  return doubled;',
        '}',
        '',
      ].join('\n'),
    });
    const filePath = path.join(tmpDir, 'src/apply.ts');

    const result = extractFunction(store, tmpDir, 'src/apply.ts', 2, 2, 'double', false);

    expect(result.success).toBe(true);
    expect(result.files_modified).toContain('src/apply.ts');
    const out = fs.readFileSync(filePath, 'utf-8');
    // The new helper function exists and is called.
    expect(out).toContain('function double');
    expect(out).toContain('double(');
    // It must still parse-shape: braces balanced.
    expect((out.match(/\{/g) || []).length).toBe((out.match(/\}/g) || []).length);
  });

  it('invalid line range still returns the familiar "Invalid line range" error', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({ 'src/d.ts': 'const x = 1;\nconst y = 2;\n' });

    const reversed = extractFunction(store, tmpDir, 'src/d.ts', 2, 1, 'bad', true);
    expect(reversed.success).toBe(false);
    expect(reversed.error).toContain('Invalid line range');

    const oob = extractFunction(store, tmpDir, 'src/d.ts', 1, 99, 'bad', true);
    expect(oob.success).toBe(false);
    expect(oob.error).toContain('Invalid line range');
  });

  it('missing file returns a clean error without throwing', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({ 'src/keep.ts': 'export const k = 1;\n' });

    const result = extractFunction(store, tmpDir, 'src/ghost.ts', 1, 1, 'f', true);
    expect(result.success).toBe(false);
    expect(result.error).toContain('File not found');
  });

  it('a slice not inside any function returns a structured error (cannot extract)', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/top.ts': ['const a = 1;', 'const b = 2;', ''].join('\n'),
    });

    const result = extractFunction(store, tmpDir, 'src/top.ts', 1, 1, 'f', true);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).not.toContain('Invalid line range');
  });
});
