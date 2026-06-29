/**
 * Behavioural coverage for the AST-aware engine of `applyCodemod()`.
 *
 * The codemod engine is backed by `@ast-grep/napi` for supported code files.
 * The defining property versus the old regex engine: an ast-grep pattern only
 * matches real syntax nodes — never text inside string literals or comments.
 *
 * These tests prove:
 *   - a call-expression pattern (`foo($$$ARGS)`) matches real calls and rewrites
 *     them, building the replacement string from captured metavariables
 *   - the SAME identifier appearing inside a string literal or a comment is NOT
 *     matched (the regression that motivated the rewrite)
 *   - single named metavariables (`$A`) and `$$$ARGS` splices both substitute
 *   - positional `$1`/`$2` placeholders map to ordered metavariables
 *   - dry_run never writes; apply mode rewrites only real nodes on disk
 *   - regex patterns still work on code files (fallback) and on non-AST files
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyCodemod } from '../../../src/tools/refactoring/refactor.js';
import { createTmpFixture, removeTmpDir } from '../../test-utils.js';

describe('applyCodemod() — AST engine (ast-grep)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('rewrites real call expressions but NOT string/comment occurrences', async () => {
    tmpDir = createTmpFixture({
      'src/a.ts': [
        'const a = foo(1, 2);',
        '// foo(9, 9) inside a comment must be left alone',
        'const s = "foo(7, 7) inside a string must be left alone";',
        'const b = bar(foo(3, 4));',
      ].join('\n'),
    });

    const result = await applyCodemod(tmpDir, 'foo($$$ARGS)', 'baz($$$ARGS)', 'src/**/*.ts', {
      dryRun: false,
      engine: 'ast',
    });

    expect(result.success).toBe(true);
    expect(result.engine_used).toBe('ast');
    // Only the two real call sites — the comment and string are untouched.
    expect(result.total_replacements).toBe(2);

    const out = fs.readFileSync(path.join(tmpDir, 'src/a.ts'), 'utf-8');
    expect(out).toContain('const a = baz(1, 2);');
    expect(out).toContain('const b = bar(baz(3, 4));');
    // The string + comment lines are byte-for-byte preserved.
    expect(out).toContain('// foo(9, 9) inside a comment must be left alone');
    expect(out).toContain('"foo(7, 7) inside a string must be left alone"');
  });

  it('substitutes a single named metavariable ($A) into the replacement', async () => {
    tmpDir = createTmpFixture({
      'src/log.ts': 'console.log("x");\nconsole.log(y);\n',
    });

    const result = await applyCodemod(
      tmpDir,
      'console.log($A)',
      'logger.debug($A)',
      'src/**/*.ts',
      { dryRun: false, engine: 'ast' },
    );

    expect(result.success).toBe(true);
    expect(result.total_replacements).toBe(2);
    const out = fs.readFileSync(path.join(tmpDir, 'src/log.ts'), 'utf-8');
    expect(out).toContain('logger.debug("x");');
    expect(out).toContain('logger.debug(y);');
  });

  it('maps positional $1/$2 placeholders in the replacement to ordered metavariables', async () => {
    tmpDir = createTmpFixture({
      'src/swap.ts': 'pair(a, b);\n',
    });

    // ast-grep patterns use named metavars ($A, $B). In the replacement,
    // positional $1/$2 alias the pattern's ordered named metavars — so this
    // swaps the two captures.
    const result = await applyCodemod(tmpDir, 'pair($A, $B)', 'pair($2, $1)', 'src/**/*.ts', {
      dryRun: false,
      engine: 'ast',
    });

    expect(result.success).toBe(true);
    expect(result.total_replacements).toBe(1);
    const out = fs.readFileSync(path.join(tmpDir, 'src/swap.ts'), 'utf-8');
    expect(out).toContain('pair(b, a);');
  });

  it('dry_run with the AST engine previews matches without writing', async () => {
    tmpDir = createTmpFixture({
      'src/d.ts': 'const a = foo(1);\nconst s = "foo(1)";\n',
    });
    const before = fs.readFileSync(path.join(tmpDir, 'src/d.ts'), 'utf-8');

    const result = await applyCodemod(tmpDir, 'foo($A)', 'baz($A)', 'src/**/*.ts', {
      dryRun: true,
      engine: 'ast',
    });

    expect(result.success).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.engine_used).toBe('ast');
    expect(result.total_replacements).toBe(1); // string occurrence excluded
    expect(result.files_modified).toEqual([]);
    expect(result.matches.length).toBeGreaterThan(0);
    // Nothing written.
    expect(fs.readFileSync(path.join(tmpDir, 'src/d.ts'), 'utf-8')).toBe(before);
  });

  it('auto engine: a valid ast-grep pattern uses AST and skips string/comment hits', async () => {
    tmpDir = createTmpFixture({
      'src/auto.ts': ['doThing(x);', '// doThing(x) commented', 'const note = "doThing(x)";'].join(
        '\n',
      ),
    });

    // engine defaults to 'auto'; the pattern is a valid ast-grep call pattern.
    const result = await applyCodemod(tmpDir, 'doThing($A)', 'doOther($A)', 'src/**/*.ts', {
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.engine_used).toBe('ast');
    expect(result.total_replacements).toBe(1);
  });

  it('auto engine: a regex-only pattern falls back to the regex engine', async () => {
    tmpDir = createTmpFixture({
      'src/rx.ts': 'const x = needle;\n',
    });

    // `\bneedle\b` is a regex, not an ast-grep pattern — must fall back.
    const result = await applyCodemod(tmpDir, '\\bneedle\\b', 'haystack', 'src/**/*.ts', {
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.engine_used).toBe('regex');
    expect(result.total_replacements).toBe(1);
  });

  it('non-AST file types always use the regex engine', async () => {
    tmpDir = createTmpFixture({
      'README.md': 'call foo(1) in prose\n',
    });

    const result = await applyCodemod(tmpDir, 'foo\\(1\\)', 'bar(1)', '**/*.md', {
      dryRun: true,
      engine: 'auto',
    });

    expect(result.success).toBe(true);
    expect(result.engine_used).toBe('regex');
    expect(result.total_replacements).toBe(1);
  });
});
