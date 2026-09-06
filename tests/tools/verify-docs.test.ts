import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { extractDocRefs, verifyDocs } from '../../src/tools/quality/verify-docs.js';
import { createTestStore } from '../test-utils.js';

describe('extractDocRefs', () => {
  test('carries the heading path of the owning section', () => {
    const refs = extractDocRefs(
      ['# Title', '', '## Budgets', '', '### Defaults', '', 'See `src/a.ts`.'].join('\n'),
    );
    expect(refs).toEqual([
      { token: 'src/a.ts', kind: 'path', heading: 'Title > Budgets > Defaults', line: 7 },
    ]);
  });

  test('a sibling heading drops the deeper level', () => {
    const refs = extractDocRefs(['## A', '### A1', '`src/a.ts`', '## B', '`src/b.ts`'].join('\n'));
    expect(refs.map((r) => r.heading)).toEqual(['A > A1', 'B']);
  });

  test('skips fenced blocks and front matter', () => {
    const md = [
      '---',
      'title: `src/frontmatter.ts`',
      '---',
      '`src/real.ts`',
      '```ts',
      'import x from `src/fenced.ts`;',
      '```',
      '~~~',
      '`src/tilde.ts`',
      '~~~',
    ].join('\n');
    expect(extractDocRefs(md).map((r) => r.token)).toEqual(['src/real.ts']);
  });

  test('prose backticks are not code references', () => {
    const md = '`--watch` `latest` `key = value` `https://x.dev/a/b` `a*b` `node:fs` `~/.trace`';
    expect(extractDocRefs(md).map((r) => r.token)).toEqual(['latest']);
  });

  test('strips citation decoration', () => {
    const refs = extractDocRefs('`src/a.ts:42`, `./src/b.ts`, `getFile()`');
    expect(refs).toEqual([
      { token: 'src/a.ts', kind: 'path', heading: '', line: 1 },
      { token: 'src/b.ts', kind: 'path', heading: '', line: 1 },
      { token: 'getFile', kind: 'symbol', heading: '', line: 1 },
    ]);
  });

  test('a dotted config key is not read as a file path', () => {
    expect(extractDocRefs('`config.tools.preset`')).toEqual([
      { token: 'config.tools.preset', kind: 'symbol', heading: '', line: 1 },
    ]);
  });
});

describe('verifyDocs', () => {
  let store: Store;
  let root: string;

  beforeEach(() => {
    store = createTestStore();
    root = mkdtempSync(join(tmpdir(), 'verify-docs-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function seed() {
    const fileId = store.insertFile('src/budget.ts', 'typescript', 'h1', 100);
    store.insertSymbol(fileId, {
      symbolId: 'src/budget.ts::computeBudget',
      name: 'computeBudget',
      kind: 'function',
      fqn: 'budget.computeBudget',
      byteStart: 0,
      byteEnd: 10,
      metadata: { exported: true },
    });
    return fileId;
  }

  test('forward: reports only the refs that do not resolve, with their section', () => {
    seed();
    writeFileSync(
      join(root, 'doc.md'),
      [
        '## Budgets',
        '`src/budget.ts` defines `computeBudget`.',
        '',
        '## Gone',
        '`src/old.ts`',
      ].join('\n'),
    );

    const res = verifyDocs(store, { path: 'doc.md', projectRoot: root });
    expect(res.forward?.checked).toBe(3);
    expect(res.forward?.resolved).toBe(2);
    expect(res.forward?.misses).toEqual([
      { token: 'src/old.ts', kind: 'path', heading: 'Gone', line: 5 },
    ]);
  });

  test('forward: an unindexed file that exists on disk is not drift', () => {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'guide.md'), '');
    writeFileSync(join(root, 'doc.md'), '`docs/guide.md`');

    const res = verifyDocs(store, { path: 'doc.md', projectRoot: root });
    expect(res.forward?.misses).toEqual([]);
    expect(res.forward?.verified?.[0].via).toBe('filesystem');
  });

  test('compact drops the verified list but keeps the counts', () => {
    seed();
    writeFileSync(join(root, 'doc.md'), '`src/budget.ts` `src/old.ts`');

    const res = verifyDocs(store, { path: 'doc.md', projectRoot: root, compact: true });
    expect(res.forward?.verified).toBeUndefined();
    expect(res.forward).toMatchObject({ checked: 2, resolved: 1 });
    expect(res.forward?.misses).toHaveLength(1);
  });

  test('reverse: lists public symbols the document never names', () => {
    const fileId = seed();
    store.insertSymbol(fileId, {
      symbolId: 'src/budget.ts::trimOutput',
      name: 'trimOutput',
      kind: 'function',
      fqn: 'budget.trimOutput',
      byteStart: 20,
      byteEnd: 30,
      metadata: { exported: true },
    });
    writeFileSync(join(root, 'doc.md'), 'The budget is computed by `computeBudget`.');

    const res = verifyDocs(store, {
      path: 'doc.md',
      projectRoot: root,
      direction: 'reverse',
      scope: 'src/',
    });
    expect(res.reverse?.public_symbols).toBe(2);
    expect(res.reverse?.mentioned).toBe(1);
    expect(res.reverse?.unmentioned.map((s) => s.name)).toEqual(['trimOutput']);
  });

  test('refuses a document outside the project root', () => {
    expect(() => verifyDocs(store, { path: '../escape.md', projectRoot: root })).toThrow(
      /escapes the project root/,
    );
  });
});
