import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { relativizeUnderRoot } from '../../src/utils/path-relativize.js';

describe('relativizeUnderRoot', () => {
  const root = path.resolve('/Users/nikolai/repos/sample');

  it('relativises an absolute path inside root', () => {
    const abs = path.join(root, 'src', 'foo.ts');
    expect(relativizeUnderRoot(abs, root)).toBe('src/foo.ts');
  });

  it('leaves an absolute path outside root unchanged', () => {
    const abs = '/Users/nikolai/.claude/projects/other/state.json';
    expect(relativizeUnderRoot(abs, root)).toBe(abs);
  });

  it('leaves an already-relative path unchanged', () => {
    expect(relativizeUnderRoot('src/foo.ts', root)).toBe('src/foo.ts');
  });

  it('passes null and undefined through unchanged', () => {
    expect(relativizeUnderRoot(null, root)).toBeNull();
    expect(relativizeUnderRoot(undefined, root)).toBeUndefined();
  });

  it('does not return parent traversal', () => {
    const parent = '/Users/nikolai/repos/other/file.ts';
    const out = relativizeUnderRoot(parent, root);
    // Outside root → returned unchanged, no `../other/file.ts` leak
    expect(out).toBe(parent);
  });

  it('normalises Windows separators when relativising', () => {
    if (process.platform !== 'win32') return; // path.resolve uses platform separator
    const winRoot = 'C:\\Users\\dev\\sample';
    const winAbs = 'C:\\Users\\dev\\sample\\src\\foo.ts';
    expect(relativizeUnderRoot(winAbs, winRoot)).toBe('src/foo.ts');
  });

  it('returns the input unchanged when target equals root', () => {
    // path.relative(root, root) === '' — caller should not see a stored "" path
    expect(relativizeUnderRoot(root, root)).toBe(root);
  });
});
