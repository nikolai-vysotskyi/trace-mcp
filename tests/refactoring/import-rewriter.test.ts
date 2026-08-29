/**
 * Tests for the import-path rewriter behind `apply_move`.
 *
 * This module edits the user's own source files: when a file moves, every
 * importer gets its specifier rewritten on disk. A miss here does not throw —
 * it silently leaves a dangling import behind, which is the worst possible
 * failure mode for a refactoring tool.
 *
 * Covers the two ends of the path: `computeRelativeSpecifier` (the pure
 * specifier arithmetic) and `rewriteImportForMovedTarget` (find → compute →
 * write, against real files on disk).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeRelativeSpecifier,
  rewriteImportForMovedTarget,
} from '../../src/tools/refactoring/import-rewriter.js';

describe('computeRelativeSpecifier', () => {
  it('prefixes a same-directory target with ./ and strips the extension', () => {
    expect(computeRelativeSpecifier('/p/src/a.ts', '/p/src/b.ts')).toBe('./b');
  });

  it('keeps ../ for a parent-directory target', () => {
    expect(computeRelativeSpecifier('/p/src/deep/a.ts', '/p/src/b.ts')).toBe('../b');
  });

  it('walks up and back down for a sibling directory', () => {
    expect(computeRelativeSpecifier('/p/src/a/x.ts', '/p/src/b/y.ts')).toBe('../b/y');
  });

  it('collapses a barrel file to its directory', () => {
    expect(computeRelativeSpecifier('/p/src/a.ts', '/p/src/utils/index.ts')).toBe('./utils');
  });

  it('leaves a non-JS extension alone', () => {
    expect(computeRelativeSpecifier('/p/src/a.ts', '/p/src/schema.json')).toBe('./schema.json');
  });
});

describe('rewriteImportForMovedTarget', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-import-rewriter-'));
    fs.mkdirSync(path.join(root, 'src', 'utils'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'moved'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, body: string): string {
    const abs = path.join(root, rel);
    fs.writeFileSync(abs, body);
    return abs;
  }

  it('rewrites an extensionless relative import and writes it to disk', () => {
    const importer = write('src/app.ts', "import { helper } from './utils/helper';\n");
    const oldTarget = write('src/utils/helper.ts', 'export const helper = 1;\n');
    const newTarget = path.join(root, 'src', 'moved', 'helper.ts');

    const edits = rewriteImportForMovedTarget(importer, oldTarget, newTarget, root, false);

    expect(edits).toHaveLength(1);
    expect(edits[0].new_text).toBe("import { helper } from './moved/helper';");
    expect(fs.readFileSync(importer, 'utf-8')).toContain("from './moved/helper'");
  });

  it('rewrites an ESM .js specifier that points at a .ts file, keeping the extension', () => {
    // NodeNext/ESM convention: the specifier carries `.js`, the file on disk is
    // `.ts`. Missing this leaves the importer pointing at the old location, and
    // dropping the extension on the way out breaks the NodeNext resolver.
    const importer = write('src/app.ts', "import { helper } from './utils/helper.js';\n");
    const oldTarget = write('src/utils/helper.ts', 'export const helper = 1;\n');
    const newTarget = path.join(root, 'src', 'moved', 'helper.ts');

    const edits = rewriteImportForMovedTarget(importer, oldTarget, newTarget, root, false);

    expect(edits).toHaveLength(1);
    expect(fs.readFileSync(importer, 'utf-8')).toContain("from './moved/helper.js'");
  });

  it('leaves the file untouched in dry-run mode', () => {
    const importer = write('src/app.ts', "import { helper } from './utils/helper';\n");
    const oldTarget = write('src/utils/helper.ts', 'export const helper = 1;\n');
    const newTarget = path.join(root, 'src', 'moved', 'helper.ts');

    const edits = rewriteImportForMovedTarget(importer, oldTarget, newTarget, root, true);

    expect(edits).toHaveLength(1);
    expect(fs.readFileSync(importer, 'utf-8')).toContain("from './utils/helper'");
  });

  it('returns no edits when the importer does not reference the moved file', () => {
    const importer = write('src/app.ts', "import { other } from './utils/other';\n");
    write('src/utils/other.ts', 'export const other = 1;\n');
    const oldTarget = write('src/utils/helper.ts', 'export const helper = 1;\n');
    const newTarget = path.join(root, 'src', 'moved', 'helper.ts');

    expect(rewriteImportForMovedTarget(importer, oldTarget, newTarget, root, false)).toEqual([]);
  });

  it('rewrites require() and dynamic import() call sites too', () => {
    const importer = write(
      'src/app.ts',
      [
        "const { helper } = require('./utils/helper');",
        "const lazy = () => import('./utils/helper');",
        '',
      ].join('\n'),
    );
    const oldTarget = write('src/utils/helper.ts', 'export const helper = 1;\n');
    const newTarget = path.join(root, 'src', 'moved', 'helper.ts');

    const edits = rewriteImportForMovedTarget(importer, oldTarget, newTarget, root, false);

    expect(edits).toHaveLength(2);
    const after = fs.readFileSync(importer, 'utf-8');
    expect(after).not.toContain('./utils/helper');
    expect(after).toContain("require('./moved/helper')");
    expect(after).toContain("import('./moved/helper')");
  });
});
