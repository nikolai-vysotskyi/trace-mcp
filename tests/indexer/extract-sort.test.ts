/**
 * Phase 2.4 — sortByExtension clusters same-language files so workers reuse
 * their parser cache instead of re-loading WASM grammars on each switch.
 */
import { describe, expect, it } from 'vitest';
import { sortByExtension } from '../../src/indexer/pipeline.js';

describe('sortByExtension', () => {
  it('groups files by extension', () => {
    const input = [
      'src/a.ts',
      'src/foo.py',
      'src/b.ts',
      'README.md',
      'src/bar.py',
      'src/c.ts',
      'src/baz.go',
    ];
    const sorted = sortByExtension(input.slice());
    // After sort, all .ts run together, all .py together, etc. Verify by
    // checking the run-length of each extension equals its frequency.
    const exts = sorted.map((p) => p.slice(p.lastIndexOf('.')));
    let i = 0;
    const runs: Record<string, number> = {};
    while (i < exts.length) {
      const e = exts[i];
      let j = i;
      while (j < exts.length && exts[j] === e) j++;
      runs[e] = (runs[e] ?? 0) + (j - i);
      // Each extension must appear in exactly one contiguous run.
      expect(runs[e]).toBe(exts.filter((x) => x === e).length);
      i = j;
    }
  });

  it('is in-place and returns the same array reference', () => {
    const arr = ['z.ts', 'a.py', 'b.ts'];
    const out = sortByExtension(arr);
    expect(out).toBe(arr);
  });

  it('breaks ties by full path so order is deterministic', () => {
    const out = sortByExtension(['src/z.ts', 'src/a.ts', 'src/m.ts']);
    expect(out).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
  });

  it('handles files without an extension', () => {
    const out = sortByExtension(['Makefile', 'README', 'src/a.ts', 'b.ts']);
    // Files without an extension produce '' from path.extname — they cluster
    // before any dotted extension thanks to localeCompare.
    expect(out.slice(0, 2)).toEqual(['Makefile', 'README']);
    expect(out.slice(2)).toEqual(['b.ts', 'src/a.ts']);
  });

  it('produces same output for already-sorted input (idempotent)', () => {
    const input = ['a.go', 'b.py', 'c.ts'];
    const once = sortByExtension(input.slice());
    const twice = sortByExtension(once.slice());
    expect(twice).toEqual(once);
  });
});
