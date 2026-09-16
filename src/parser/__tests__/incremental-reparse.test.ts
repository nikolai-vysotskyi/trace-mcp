/**
 * TRA-1540 — prototype `tree.edit()` incremental reparse for single-file
 * watcher edits.
 *
 * Each case parses `before`, reparses incrementally to `after` via
 * `parseIncremental`, and asserts the S-expression is identical to a full
 * `parse(after)` — the acceptance bar for "incremental reparse is correct".
 * Covers insertion, deletion, and symbol rename across three grammars.
 */

import { describe, expect, it } from 'vitest';
import type { Tree } from 'web-tree-sitter';
import { computeSingleEdit, getParser, parseIncremental } from '../tree-sitter.js';

async function fullParse(language: string, text: string): Promise<Tree> {
  const parser = await getParser(language);
  return parser.parse(text);
}

async function expectIncrementalParity(
  language: string,
  before: string,
  after: string,
): Promise<void> {
  const oldTree = await fullParse(language, before);
  try {
    const newTree = await parseIncremental(language, oldTree, before, after);
    try {
      const fresh = await fullParse(language, after);
      try {
        expect(newTree.rootNode.toString()).toBe(fresh.rootNode.toString());
      } finally {
        fresh.delete();
      }
    } finally {
      if (newTree !== oldTree) newTree.delete();
    }
  } finally {
    oldTree.delete();
  }
}

describe('computeSingleEdit', () => {
  it('returns null for identical texts', () => {
    expect(computeSingleEdit('foo()', 'foo()')).toBeNull();
  });

  it('describes a pure insertion with an empty old range', () => {
    const edit = computeSingleEdit('ab', 'axb');
    expect(edit).not.toBeNull();
    expect(edit!.startIndex).toBe(1);
    expect(edit!.oldEndIndex).toBe(1);
    expect(edit!.newEndIndex).toBe(2);
  });
});

describe('parseIncremental', () => {
  it('returns the same tree without reparsing when nothing changed', async () => {
    const text = 'function foo() {\n  return 1;\n}\n';
    const oldTree = await fullParse('typescript', text);
    try {
      const same = await parseIncremental('typescript', oldTree, text, text);
      expect(same).toBe(oldTree);
    } finally {
      oldTree.delete();
    }
  });

  it('typescript: insertion / deletion / rename match full parse', async () => {
    const base = 'function foo() {\n  return 1;\n}\n';
    const added = `${base}\nexport function bar() {\n  return 2;\n}\n`;
    await expectIncrementalParity('typescript', base, added);
    await expectIncrementalParity('typescript', added, base);
    await expectIncrementalParity('typescript', base, base.replace('foo', 'fooRenamed'));
  });

  it('python: insertion / deletion / rename match full parse', async () => {
    const base = 'def foo():\n    return 1\n';
    const added = `${base}\ndef bar():\n    return 2\n`;
    await expectIncrementalParity('python', base, added);
    await expectIncrementalParity('python', added, base);
    await expectIncrementalParity('python', base, base.replace('foo', 'foo_renamed'));
  });

  it('rust: insertion matches full parse', async () => {
    const base = 'fn foo() -> i32 {\n    1\n}\n';
    const added = `${base}\nfn bar() -> i32 {\n    2\n}\n`;
    await expectIncrementalParity('rust', base, added);
  });

  it('tracks changed ranges through the edit', async () => {
    const before = 'function foo() {\n  return 1;\n}\n';
    // Structural change (plain literal → call expression), not just a new
    // token value: getChangedRanges reports structure, so a `1` → `2` swap
    // correctly yields zero ranges.
    const after = 'function foo() {\n  return bar(1);\n}\n';
    const oldTree = await fullParse('typescript', before);
    try {
      const newTree = await parseIncremental('typescript', oldTree, before, after);
      try {
        // The edit was applied to the old tree, so diffing old vs new must
        // report the changed span rather than an empty range list.
        expect(oldTree.getChangedRanges(newTree).length).toBeGreaterThan(0);
      } finally {
        if (newTree !== oldTree) newTree.delete();
      }
    } finally {
      oldTree.delete();
    }
  });
});
