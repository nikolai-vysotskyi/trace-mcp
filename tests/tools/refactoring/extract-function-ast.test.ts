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

  // ─── Adversarial cases ──────────────────────────────────────────────────────

  it('SHADOWING: does not treat an inner-block-scoped name as the return value of an outer same-named usage', () => {
    // `x` is declared twice: once at outer-function scope (line 2), once inside
    // a nested block INSIDE the extracted slice (line 4). The `console.log(x)`
    // AFTER the slice (line 7) is back at outer-function scope, so it refers to
    // the OUTER `x` (still 10) — never touched by the extraction — not the
    // slice's inner `x` (20, block-scoped, already out of scope by line 7).
    //
    // Silently returning `x` here would generate `return x;` inside the helper
    // AFTER the inner block that declared it has closed — a dangling reference
    // (ReferenceError at runtime), and even if it "worked" it would be the
    // wrong value from the caller's perspective.
    const src = [
      'function outer() {', // 1
      '  const x = 10;', //     2
      '  {', //                 3 (slice start)
      '    const x = 20;', //   4
      '    console.log(x);', // 5
      '  }', //                 6 (slice end)
      '  console.log(x);', //   7 — refers to the OUTER x, not the slice's
      '}', //                   8
    ].join('\n');

    const res = plan(src, 3, 6);
    expect(isExtractError(res)).toBe(false);
    if (isExtractError(res)) return;
    // Must NOT claim the shadowed inner `x` as a return value.
    expect(res.returnValue).toBeUndefined();
    // The generated helper must not reference `x` outside the block it owns.
    expect(res.helperSource).not.toMatch(/return x;/);
  });

  it('LOOP VARIABLE: extracting from inside a for-loop captures the loop variable as a parameter', () => {
    const src = [
      'function sumSquares(arr: number[]) {', //      1
      '  let total = 0;', //                          2
      '  for (let i = 0; i < arr.length; i++) {', //  3
      '    const sq = arr[i] * arr[i];', //            4 (slice start)
      '    total += sq;', //                           5 (slice end)
      '  }', //                                        6
      '  return total;', //                            7
      '}', //                                          8
    ].join('\n');

    const res = plan(src, 4, 5);
    expect(isExtractError(res)).toBe(false);
    if (isExtractError(res)) return;
    // `i` (the for-loop's own declaration, outside the slice) is read in the
    // slice (`arr[i]`) and must become a captured parameter — not silently
    // dropped, which would make the helper reference an undeclared `i`.
    expect(res.params).toContain('i');
    expect(res.params).toContain('arr');
    expect(res.params).toContain('total');
    expect(res.helperSource).toContain('function helper(arr, i, total)');
  });

  it('MULTIPLE RETURN-RELEVANT BINDINGS: rejects extraction rather than silently dropping one', () => {
    // Both `a` and `b` are declared in the slice and used after it. The tool
    // supports only a single return value — it must reject this extraction
    // with a clear, actionable error, not silently return `a` while `b`
    // becomes a dangling reference at the call site (ReferenceError).
    const src = [
      'function calc(n: number) {', // 1
      '  const a = n + 1;', //         2 (slice start)
      '  const b = n + 2;', //         3 (slice end)
      '  console.log(a, b);', //       4 — both a and b are still needed
      '}', //                          5
    ].join('\n');

    const res = plan(src, 2, 3);
    expect(isExtractError(res)).toBe(true);
    if (!isExtractError(res)) return;
    expect(res.error).toContain('multiple values');
    expect(res.error).toContain('a');
    expect(res.error).toContain('b');
  });

  it('CONFIDENCE: is measurably lower for a shadowed case than a clean equivalent', () => {
    const cleanSrc = [
      'function f(p: number) {', //  1
      '  const total = p + 1;', //   2 (slice)
      '  console.log(total);', //    3
      '}', //                        4
    ].join('\n');
    const cleanRes = plan(cleanSrc, 2, 2);
    expect(isExtractError(cleanRes)).toBe(false);
    if (isExtractError(cleanRes)) return;
    expect(cleanRes.confidence).toBe('high');

    const shadowSrc = [
      'function outer() {', // 1
      '  const x = 10;', //     2
      '  {', //                 3 (slice start)
      '    const x = 20;', //   4
      '    console.log(x);', // 5
      '  }', //                 6 (slice end)
      '  console.log(x);', //   7
      '}', //                   8
    ].join('\n');
    const shadowRes = plan(shadowSrc, 3, 6);
    expect(isExtractError(shadowRes)).toBe(false);
    if (isExtractError(shadowRes)) return;
    expect(shadowRes.confidence).toBe('low');

    // The two must actually differ — not both defaulting to the same value.
    expect(shadowRes.confidence).not.toBe(cleanRes.confidence);
  });
});
