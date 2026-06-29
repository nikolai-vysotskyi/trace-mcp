/**
 * Unit coverage for the ast-grep codemod engine primitives.
 */

import { describe, expect, it } from 'vitest';
import {
  astLangForFile,
  looksLikeAstPattern,
  runAstCodemodOnSource,
} from '../../../src/tools/refactoring/codemod-ast.js';
import { Lang } from '@ast-grep/napi';

describe('astLangForFile', () => {
  it('maps supported code extensions to an ast-grep Lang', () => {
    expect(astLangForFile('a.ts')).not.toBeNull();
    expect(astLangForFile('a.tsx')).not.toBeNull();
    expect(astLangForFile('a.js')).not.toBeNull();
    expect(astLangForFile('a.jsx')).not.toBeNull();
    expect(astLangForFile('a.mjs')).not.toBeNull();
  });

  it('returns null for non-AST file types', () => {
    expect(astLangForFile('a.md')).toBeNull();
    expect(astLangForFile('a.py')).toBeNull(); // not bundled in @ast-grep/napi
    expect(astLangForFile('a.json')).toBeNull();
    expect(astLangForFile('Makefile')).toBeNull();
  });
});

describe('looksLikeAstPattern', () => {
  it('accepts concrete patterns with metavariables', () => {
    expect(looksLikeAstPattern('foo($$$ARGS)')).toBe(true);
    expect(looksLikeAstPattern('console.log($A)')).toBe(true);
    expect(looksLikeAstPattern('await $X')).toBe(true);
  });

  it('rejects raw regex patterns', () => {
    expect(looksLikeAstPattern('\\bfoo\\b')).toBe(false);
    expect(looksLikeAstPattern('foo\\(1\\)')).toBe(false);
    expect(looksLikeAstPattern('[a-z]+')).toBe(false);
    expect(looksLikeAstPattern('^needle$')).toBe(false);
    expect(looksLikeAstPattern('.*')).toBe(false);
  });

  it('rejects a bare snippet with no metavariable (ambiguous → regex)', () => {
    expect(looksLikeAstPattern('foo')).toBe(false);
  });
});

describe('runAstCodemodOnSource', () => {
  it('does not match inside string literals or comments', () => {
    const src = ['foo(1);', '// foo(2) comment', 'const s = "foo(3)";', 'bar(foo(4));'].join('\n');
    const res = runAstCodemodOnSource(Lang.TypeScript, src, 'foo($A)', 'baz($A)');
    expect(res.matchCount).toBe(2);
    expect(res.newSource).toContain('baz(1);');
    expect(res.newSource).toContain('bar(baz(4));');
    expect(res.newSource).toContain('// foo(2) comment');
    expect(res.newSource).toContain('"foo(3)"');
  });

  it('splices $$$ARGS variadic captures', () => {
    const res = runAstCodemodOnSource(
      Lang.TypeScript,
      'sum(a, b, c);\n',
      'sum($$$ARGS)',
      'total($$$ARGS)',
    );
    expect(res.matchCount).toBe(1);
    expect(res.newSource).toContain('total(a, b, c);');
  });

  it('reports 1-based line numbers for matches', () => {
    const res = runAstCodemodOnSource(
      Lang.TypeScript,
      'const x = 1;\nconst y = drop(x);\n',
      'drop($A)',
      'keep($A)',
    );
    expect(res.matchCount).toBe(1);
    expect(res.matches[0].line).toBe(2);
  });

  it('returns the source unchanged when nothing matches', () => {
    const src = 'const x = 1;\n';
    const res = runAstCodemodOnSource(Lang.TypeScript, src, 'nope($A)', 'yep($A)');
    expect(res.matchCount).toBe(0);
    expect(res.newSource).toBe(src);
  });
});
