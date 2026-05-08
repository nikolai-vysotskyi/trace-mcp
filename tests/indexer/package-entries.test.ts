import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findPackageJsonEntries } from '../../src/indexer/package-entries.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

function writePkg(dir: string, pkg: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
}

describe('findPackageJsonEntries', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir('package-entries-');
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('returns empty set for a non-existent root', () => {
    expect(findPackageJsonEntries(path.join(tmpDir, 'nope')).size).toBe(0);
  });

  it('returns empty set when no package.json files are present', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'));
    expect(findPackageJsonEntries(tmpDir).size).toBe(0);
  });

  it('resolves main, module, and bin (string + object) at the project root', () => {
    writePkg(tmpDir, {
      name: 'lodash-clone',
      main: 'lodash.js',
      module: './lodash.mjs',
      bin: {
        'cli-a': './bin/a.js',
        'cli-b': 'bin/b.js',
      },
    });

    const entries = findPackageJsonEntries(tmpDir);
    expect(entries).toContain('lodash.js');
    expect(entries).toContain('lodash.mjs');
    expect(entries).toContain('bin/a.js');
    expect(entries).toContain('bin/b.js');
  });

  it('resolves a string-form bin', () => {
    writePkg(tmpDir, { name: 'tool', main: 'index.js', bin: './bin/cli.js' });
    expect(findPackageJsonEntries(tmpDir)).toContain('bin/cli.js');
  });

  it('resolves nested workspace package.json entries with workspace-relative paths', () => {
    writePkg(path.join(tmpDir, 'packages', 'core'), {
      name: '@org/core',
      main: 'dist/index.js',
      module: './dist/index.mjs',
    });
    writePkg(path.join(tmpDir, 'packages', 'utils'), {
      name: '@org/utils',
      main: 'lib/utils.js',
    });

    const entries = findPackageJsonEntries(tmpDir);
    expect(entries).toContain('packages/core/dist/index.js');
    expect(entries).toContain('packages/core/dist/index.mjs');
    expect(entries).toContain('packages/utils/lib/utils.js');
  });

  it('resolves the full exports field (conditional + subpath + nested)', () => {
    writePkg(tmpDir, {
      name: 'modern',
      exports: {
        '.': {
          import: './dist/esm/index.js',
          require: './dist/cjs/index.js',
          types: './dist/index.d.ts',
        },
        './feature': {
          import: './dist/esm/feature.js',
          require: './dist/cjs/feature.js',
        },
      },
    });

    const entries = findPackageJsonEntries(tmpDir);
    expect(entries).toContain('dist/esm/index.js');
    expect(entries).toContain('dist/cjs/index.js');
    expect(entries).toContain('dist/index.d.ts');
    expect(entries).toContain('dist/esm/feature.js');
    expect(entries).toContain('dist/cjs/feature.js');
  });

  it('skips wildcard subpaths and wildcard targets', () => {
    writePkg(tmpDir, {
      name: 'wildcards',
      main: 'index.js',
      exports: {
        '.': './index.js',
        './feature/*': './dist/feature/*.js',
        './static/*.css': './dist/static/*.css',
      },
    });

    const entries = findPackageJsonEntries(tmpDir);
    expect(entries).toContain('index.js');
    // Wildcard entries must not leak into the set
    for (const e of entries) {
      expect(e).not.toContain('*');
    }
  });

  it('skips node_modules / vendor / dist / build / .* directories', () => {
    // Real package at root
    writePkg(tmpDir, { name: 'host', main: 'index.js' });

    // Decoy package.json files in directories we never want to index
    writePkg(path.join(tmpDir, 'node_modules', 'lodash'), {
      name: 'lodash',
      main: 'should-not-appear.js',
    });
    writePkg(path.join(tmpDir, 'vendor', 'thing'), {
      name: 'vendor-thing',
      main: 'vendor-main.js',
    });
    writePkg(path.join(tmpDir, 'dist'), {
      name: 'dist-pkg',
      main: 'dist-main.js',
    });
    writePkg(path.join(tmpDir, '.next'), {
      name: 'next-cache',
      main: 'next-main.js',
    });

    const entries = findPackageJsonEntries(tmpDir);
    expect(entries).toContain('index.js');
    expect(entries).not.toContain('node_modules/lodash/should-not-appear.js');
    expect(entries).not.toContain('vendor/thing/vendor-main.js');
    expect(entries).not.toContain('dist/dist-main.js');
    expect(entries).not.toContain('.next/next-main.js');
  });

  it('survives a malformed package.json without aborting the whole walk', () => {
    fs.mkdirSync(path.join(tmpDir, 'broken'));
    fs.writeFileSync(path.join(tmpDir, 'broken', 'package.json'), '{ this is not json }');
    writePkg(path.join(tmpDir, 'good'), { name: 'good', main: 'g.js' });

    // Should not throw, should still collect the good one
    const entries = findPackageJsonEntries(tmpDir);
    expect(entries).toContain('good/g.js');
  });

  it('returns paths with forward-slashes regardless of platform', () => {
    writePkg(path.join(tmpDir, 'a', 'b'), { name: 'nested', main: 'c/d.js' });
    const entries = findPackageJsonEntries(tmpDir);
    for (const e of entries) {
      expect(e).not.toContain('\\');
    }
    expect(entries).toContain('a/b/c/d.js');
  });
});
