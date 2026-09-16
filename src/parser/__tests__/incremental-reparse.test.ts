/**
 * TRA-1540 — prototype `tree.edit()` incremental reparse for single-file
 * watcher edits.
 *
 * Each case parses `before`, reparses incrementally to `after` via
 * `parseIncremental`, and asserts the S-expression is identical to a full
 * `parse(after)` — the acceptance bar for "incremental reparse is correct".
 * Covers insertion, deletion, and symbol rename across three grammars.
 *
 * TRA-1577 extended the fixtures: the per-file Tree cache routes every
 * watcher edit through `parseIncremental`, so parity must also hold for
 * non-ASCII bytes (UTF-16 scan vs UTF-8 byte offsets), empty ↔ code
 * transitions, comment-only touches, block deletions, large-file appends,
 * chained edits, and the tsx grammar.
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

  it('multiline insertion in the middle matches full parse', async () => {
    const before = 'function a() {\n  return 1;\n}\n\nfunction c() {\n  return 3;\n}\n';
    const after =
      'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n\nfunction c() {\n  return 3;\n}\n';
    await expectIncrementalParity('typescript', before, after);
    await expectIncrementalParity('typescript', after, before);
  });

  it('whole-block deletion matches full parse', async () => {
    const before = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n';
    const after = 'function a() {\n  return 1;\n}\n';
    await expectIncrementalParity('typescript', before, after);
  });

  it('comment-only change matches full parse', async () => {
    const before = 'function foo() {\n  return 1;\n}\n';
    const after = '// edited by the watcher\nfunction foo() {\n  return 1;\n}\n';
    await expectIncrementalParity('typescript', before, after);
  });

  it('empty ↔ code transitions match full parse', async () => {
    const code = 'function foo() {\n  return 1;\n}\n';
    await expectIncrementalParity('typescript', '', code);
    await expectIncrementalParity('typescript', code, '');
  });

  it('non-ascii edits match full parse (UTF-16 units throughout)', async () => {
    // computeSingleEdit scans UTF-16 code units and reports UTF-16 offsets —
    // web-tree-sitter 0.27 feeds the parser UTF-16, so byte offsets here
    // would silently mis-reuse subtrees. Emoji (surrogate pair) and CJK
    // (3-byte) literals cover the conversion.
    const before = 'const greeting = "hello";\nfunction foo() {\n  return 1;\n}\n';
    const afterEmoji = 'const greeting = "hello 👋";\nfunction foo() {\n  return 1;\n}\n';
    await expectIncrementalParity('typescript', before, afterEmoji);
    await expectIncrementalParity('typescript', afterEmoji, before);
    const afterCjk = before.replace('foo', '関数');
    await expectIncrementalParity('typescript', before, afterCjk);
  });

  it('large-file append matches full parse', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) {
      lines.push(`export function f${i}(): number { return ${i}; }`);
    }
    const before = `${lines.join('\n')}\n`;
    const after = `${before}\nexport function appended(): number { return -1; }\n`;
    await expectIncrementalParity('typescript', before, after);
  });

  it('chained edits match full parse at every step', async () => {
    const versions = [
      'const a = 1;\n',
      'const a = 1;\nconst b = 2;\n',
      'const alpha = 1;\nconst b = 2;\n',
      'const alpha = 1;\n',
    ];
    let oldTree = await fullParse('typescript', versions[0]);
    let oldText = versions[0];
    try {
      for (let i = 1; i < versions.length; i++) {
        const newTree = await parseIncremental('typescript', oldTree, oldText, versions[i]);
        // The old tree was consumed by tree.edit() — free it now that the
        // new tree exists, and carry the new tree as the next link's base.
        if (newTree !== oldTree) oldTree.delete();
        oldTree = newTree;
        oldText = versions[i];
        const fresh = await fullParse('typescript', versions[i]);
        try {
          expect(newTree.rootNode.toString()).toBe(fresh.rootNode.toString());
        } finally {
          fresh.delete();
        }
      }
    } finally {
      oldTree.delete();
    }
  });

  it('tsx: insertion / rename match full parse', async () => {
    const base = 'export function App(): JSX.Element {\n  return <div />;\n}\n';
    const added = `${base}\nexport function Page(): JSX.Element {\n  return <span />;\n}\n`;
    await expectIncrementalParity('tsx', base, added);
    await expectIncrementalParity('tsx', added, base);
    await expectIncrementalParity('tsx', base, base.replace('App', 'AppRenamed'));
  });

  it('go: insertion / deletion match full parse', async () => {
    const base = 'package main\n\nfunc foo() int {\n\treturn 1\n}\n';
    const added = `${base}\nfunc bar() int {\n\treturn 2\n}\n`;
    await expectIncrementalParity('go', base, added);
    await expectIncrementalParity('go', added, base);
  });
});
