import { describe, expect, it } from 'vitest';
import { collectExportsTargets } from '../../src/tools/refactoring/dead-code.js';

describe('collectExportsTargets — package.json#exports walker', () => {
  it('handles string shorthand', () => {
    expect(collectExportsTargets('./dist/index.js')).toEqual(['./dist/index.js']);
  });

  it('returns empty for non-relative strings (package self-references)', () => {
    expect(collectExportsTargets('foo/bar')).toEqual([]);
  });

  it('handles a flat conditional object at root', () => {
    const result = collectExportsTargets({
      import: './dist/index.mjs',
      require: './dist/index.cjs',
      types: './dist/index.d.ts',
    });
    expect(result).toEqual(
      expect.arrayContaining(['./dist/index.mjs', './dist/index.cjs', './dist/index.d.ts']),
    );
    expect(result).toHaveLength(3);
  });

  it('handles a subpath map', () => {
    const result = collectExportsTargets({
      '.': './dist/index.js',
      './feature': './dist/feature.js',
      './internal': './dist/internal.js',
    });
    expect(result).toEqual(
      expect.arrayContaining(['./dist/index.js', './dist/feature.js', './dist/internal.js']),
    );
    expect(result).toHaveLength(3);
  });

  it('handles nested subpath + conditions (modern dual-package)', () => {
    const result = collectExportsTargets({
      '.': {
        import: './dist/esm/index.js',
        require: './dist/cjs/index.js',
        types: './dist/index.d.ts',
      },
      './feature': {
        import: './dist/esm/feature.js',
        require: './dist/cjs/feature.js',
      },
    });
    expect(result).toEqual(
      expect.arrayContaining([
        './dist/esm/index.js',
        './dist/cjs/index.js',
        './dist/index.d.ts',
        './dist/esm/feature.js',
        './dist/cjs/feature.js',
      ]),
    );
    expect(result).toHaveLength(5);
  });

  it('walks deeply nested condition trees', () => {
    const result = collectExportsTargets({
      '.': {
        node: {
          import: {
            default: './dist/node-esm.js',
          },
          require: './dist/node-cjs.js',
        },
        default: './dist/browser.js',
      },
    });
    expect(result).toEqual(
      expect.arrayContaining(['./dist/node-esm.js', './dist/node-cjs.js', './dist/browser.js']),
    );
    expect(result).toHaveLength(3);
  });

  it('walks every entry of a fallback array', () => {
    const result = collectExportsTargets([
      { import: './dist/preferred.mjs' },
      './dist/fallback.cjs',
    ]);
    expect(result).toEqual(expect.arrayContaining(['./dist/preferred.mjs', './dist/fallback.cjs']));
    expect(result).toHaveLength(2);
  });

  it('skips wildcard subpaths and wildcard targets', () => {
    const result = collectExportsTargets({
      '.': './dist/index.js',
      './feature/*': './dist/feature/*.js', // both wildcards skipped
      './static/*.css': './dist/static/*.css',
    });
    // Only the bare "." entry survives
    expect(result).toEqual(['./dist/index.js']);
  });

  it('returns empty for null / non-objects / numbers / booleans', () => {
    expect(collectExportsTargets(null)).toEqual([]);
    expect(collectExportsTargets(undefined)).toEqual([]);
    expect(collectExportsTargets(42)).toEqual([]);
    expect(collectExportsTargets(true)).toEqual([]);
  });

  it('mixed conditions + subpaths under the same root yield distinct entries', () => {
    const result = collectExportsTargets({
      '.': {
        import: './a.mjs',
        require: './a.cjs',
      },
      './sub': {
        default: './b.js',
      },
    });
    expect(result).toEqual(expect.arrayContaining(['./a.mjs', './a.cjs', './b.js']));
    expect(result).toHaveLength(3);
  });
});
