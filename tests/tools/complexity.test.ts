import { describe, it, expect } from 'vitest';
import {
  computeCyclomatic,
  computeMaxNesting,
  computeParamCount,
  computeComplexity,
} from '../../src/tools/complexity.js';

describe('computeCyclomatic', () => {
  it('returns 1 for empty/simple function', () => {
    expect(computeCyclomatic('function foo() { return 1; }')).toBe(1);
  });

  it('counts if/else branches', () => {
    const src = `
      function foo(x) {
        if (x > 0) {
          return 1;
        } else if (x < 0) {
          return -1;
        }
        return 0;
      }
    `;
    // if + else if = 2 branches → cyclomatic = 3
    expect(computeCyclomatic(src)).toBe(3);
  });

  it('counts loops and logical operators', () => {
    const src = `
      function bar(arr) {
        for (const item of arr) {
          if (item && item.active || item.force) {
            process(item);
          }
        }
      }
    `;
    // for + if + && + || = 4 → cyclomatic = 5
    expect(computeCyclomatic(src)).toBe(5);
  });

  it('counts switch/case', () => {
    const src = `
      function baz(x) {
        switch (x) {
          case 1: return 'one';
          case 2: return 'two';
          case 3: return 'three';
        }
      }
    `;
    // switch + 3 case = 4 → cyclomatic = 5
    expect(computeCyclomatic(src)).toBe(5);
  });

  it('counts try/catch', () => {
    const src = `
      function safe() {
        try { doThing(); } catch (e) { handle(e); }
      }
    `;
    // catch = 1 → cyclomatic = 2
    expect(computeCyclomatic(src)).toBe(2);
  });

  it('ignores keywords inside strings and comments', () => {
    const src = `
      function foo() {
        // if this comment has keywords while for
        const s = "if else while for";
        return s;
      }
    `;
    expect(computeCyclomatic(src)).toBe(1);
  });

  it('uses Python keywords for python language', () => {
    const src = `
def foo(x):
    if x > 0:
        for i in range(x):
            while True:
                pass
    except ValueError:
        pass
    `;
    // if + for + while + except = 4 → cyclomatic = 5
    expect(computeCyclomatic(src, 'python')).toBe(5);
  });
});

describe('computeMaxNesting', () => {
  it('returns 0 for no braces', () => {
    expect(computeMaxNesting('const x = 1;')).toBe(0);
  });

  it('returns correct depth for nested braces', () => {
    const src = `
      function foo() {
        if (true) {
          for (;;) {
            doThing();
          }
        }
      }
    `;
    expect(computeMaxNesting(src)).toBe(3);
  });

  it('handles unbalanced braces gracefully', () => {
    expect(computeMaxNesting('{ { }')).toBe(2);
  });
});

describe('computeParamCount', () => {
  it('returns 0 for no signature', () => {
    expect(computeParamCount(null)).toBe(0);
    expect(computeParamCount(undefined)).toBe(0);
    expect(computeParamCount('')).toBe(0);
  });

  it('returns 0 for empty parens', () => {
    expect(computeParamCount('function foo()')).toBe(0);
  });

  it('returns 0 for void', () => {
    expect(computeParamCount('function foo(void)')).toBe(0);
  });

  it('counts simple params', () => {
    expect(computeParamCount('function foo(a, b, c)')).toBe(3);
  });

  it('handles typed params with generics', () => {
    expect(computeParamCount('function foo(a: Map<string, number>, b: string)')).toBe(2);
  });

  it('handles nested generics', () => {
    expect(computeParamCount('function foo(a: Map<string, Map<number, boolean>>, b: string)')).toBe(2);
  });

  it('handles destructured params', () => {
    expect(computeParamCount('function foo({ a, b }: Options, c: number)')).toBe(2);
  });

  it('handles malformed signatures with empty params', () => {
    expect(computeParamCount('function foo(, , )')).toBe(0);
  });

  it('handles trailing comma', () => {
    expect(computeParamCount('function foo(a, b, )')).toBe(2);
  });
});

describe('computeComplexity', () => {
  it('returns all metrics combined', () => {
    const src = `function foo(a, b) {
  if (a > 0) {
    for (const x of b) {
      process(x);
    }
  }
  return a;
}`;
    const result = computeComplexity(src, 'function foo(a, b)');
    expect(result.cyclomatic).toBe(3); // if + for
    expect(result.max_nesting).toBe(3);
    expect(result.param_count).toBe(2);
    expect(result.lines).toBe(8);
  });
});
