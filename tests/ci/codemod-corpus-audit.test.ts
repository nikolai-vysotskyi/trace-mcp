import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain .mjs analysis script, no type declarations
import { classify } from '../../scripts/codemod-corpus-audit.mjs';

/**
 * The TRA-862 gate turned on this classifier's output, so the classifier itself
 * has to be pinned. Two directions matter and they are not symmetric:
 *
 *  - a FALSE "expressible" inflates the case for building codemods,
 *  - a FALSE "novel" only understates it.
 *
 * So the sharp cases here are the ones asserting `novel`.
 */
describe('codemod corpus audit classifier', () => {
  it('detects a consistent identifier substitution as a rename', () => {
    expect(classify('const foo = getFoo(foo);', 'const bar = getFoo(bar);').cls).toBe('rename');
  });

  it('detects a literal swap', () => {
    expect(classify('className="sz-small"', 'className="sz-regular"').cls).toBe('literal-swap');
  });

  it('detects an argument appended after a nested call', () => {
    // The shape that a preceding-token test misses: the insertion point sits
    // after ')', not after '(' or ','.
    expect(
      classify('d = root(mode, cfg.get("enc"))', 'd = root(mode, cfg.get("enc"), maxLen)').cls,
    ).toBe('arg-insert');
  });

  it('detects a parameter added across a line break', () => {
    expect(
      classify(
        'def f(mode: str, enc: str = A) -> Path:',
        'def f(mode: str, enc: str = A,\n      n: int = B) -> Path:',
      ).cls,
    ).toBe('arg-insert');
  });

  it('detects a pure deletion', () => {
    expect(classify('a();\nb();\nc();', 'a();\nc();').cls).toBe('pure-delete');
  });

  it('treats a PARTIAL substitution as novel, not a rename', () => {
    // Only one of two occurrences changed — which one is a judgement call, so
    // no deterministic transform expresses it.
    expect(classify('f(x, x)', 'f(y, x)').cls).toBe('novel');
  });

  it('treats a multi-pair substitution as novel', () => {
    expect(classify('f(a, b)', 'g(a, c)').cls).toBe('novel');
  });

  it('treats a large insertion as novel rather than an argument', () => {
    const added = 'if (!x) { throw new Error("nope"); } const y = compute(x); log(y);';
    expect(classify('const x = 1;', `const x = 1;\n${added}`).cls).toBe('novel');
  });

  it('treats writing a new function body as novel', () => {
    expect(
      classify(
        'def count(model):',
        'def targets_for(enc) -> list:\n    """Docstring."""\n    return []',
      ).cls,
    ).toBe('novel');
  });

  it('reports whitespace-only reflow as formatting', () => {
    expect(classify('f(a,   b)', 'f(a, b)').cls).toBe('formatting');
  });

  it('keys equal transforms equally so they group across files', () => {
    const a = classify('call(oldName)', 'call(newName)');
    const b = classify('other(oldName);', 'other(newName);');
    expect(a.key).toBe(b.key);
  });

  it('keys pure deletions by content, not by length', () => {
    const a = classify('x();\nfoo();', 'x();');
    const b = classify('x();\nbar();', 'x();');
    expect(a.cls).toBe('pure-delete');
    expect(a.key).not.toBe(b.key);
  });
});
