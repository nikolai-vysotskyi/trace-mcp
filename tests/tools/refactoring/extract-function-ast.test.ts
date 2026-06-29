/**
 * Unit coverage for the extract_function free-variable analyser.
 */

import { describe, expect, it } from 'vitest';
import {
  isExtractError,
  planExtractFunction,
} from '../../../src/tools/refactoring/extract-function-ast.js';

function plan(src: string, start: number, end: number, name = 'helper') {
  return planExtractFunction('src/x.ts', src, start, end, name);
}

describe('planExtractFunction', () => {
  it('treats outer params/vars read in the slice as parameters', () => {
    const src = [
      'function outer(p: number) {', // 1
      '  const base = 100;', //          2
      '  const total = base + p;', //    3 (slice)
      '  console.log(total);', //        4
      '}', //                            5
    ].join('\n');

    const res = plan(src, 3, 3);
    expect(isExtractError(res)).toBe(false);
    if (isExtractError(res)) return;
    // `base` (line 2) and `p` (param) are declared outside the slice → params.
    expect(res.params).toEqual(expect.arrayContaining(['base', 'p']));
    // `total` is declared in the slice and used on line 4 → return value.
    expect(res.returnValue).toBe('total');
  });

  it('does NOT pass variables local to the slice as parameters', () => {
    const src = [
      'function f() {', //               1
      '  const a = 1;', //               2 (slice start)
      '  const b = a + 1;', //           3 (slice end) — a is local to slice
      '  return b;', //                  4
      '}', //                            5
    ].join('\n');

    const res = plan(src, 2, 3);
    expect(isExtractError(res)).toBe(false);
    if (isExtractError(res)) return;
    // `a` is declared inside the slice — must NOT be a param.
    expect(res.params).not.toContain('a');
    // `b` is used after the slice → returned.
    expect(res.returnValue).toBe('b');
  });

  it('excludes well-known globals from the parameter list', () => {
    const src = [
      'function g(value: number) {', //  1
      '  const msg = `v=${value}`;', //  2 (slice)
      '  console.log(msg);', //          3
      '}', //                            4
    ].join('\n');

    const res = plan(src, 2, 2);
    expect(isExtractError(res)).toBe(false);
    if (isExtractError(res)) return;
    expect(res.params).toContain('value');
    expect(res.params).not.toContain('console');
  });

  it('captures a closure variable referenced inside an arrow function', () => {
    const src = [
      'function build(prefix: string) {', //                 1
      '  const items = [1, 2, 3];', //                        2
      '  const out = items.map((n) => prefix + n);', //       3 (slice)
      '  return out;', //                                     4
      '}', //                                                 5
    ].join('\n');

    const res = plan(src, 3, 3);
    expect(isExtractError(res)).toBe(false);
    if (isExtractError(res)) return;
    // The arrow captures `prefix` (outer param) and uses `items` (line 2).
    expect(res.params).toEqual(expect.arrayContaining(['prefix', 'items']));
    expect(res.returnValue).toBe('out');
  });

  it('errors when the slice is not inside a function', () => {
    const src = ['const a = 1;', 'const b = 2;'].join('\n');
    const res = plan(src, 1, 1);
    expect(isExtractError(res)).toBe(true);
  });

  it('errors for unsupported (non-JS/TS) languages', () => {
    const res = planExtractFunction('src/main.py', 'x = 1\n', 1, 1, 'f');
    expect(isExtractError(res)).toBe(true);
    if (!isExtractError(res)) return;
    expect(res.error).toContain('TypeScript/JavaScript');
  });
});
