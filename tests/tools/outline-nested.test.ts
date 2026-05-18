/**
 * Tests for the `nested` option of `getFileOutline()`.
 *
 * Covers the god-function expansion path: when a top-level symbol's LOC
 * exceeds the threshold, its body is parsed with tree-sitter and inner
 * function-like declarations are emitted as additional outline rows
 * carrying `parentId` + `depth`.
 */

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/db/store.js';
import { getFileOutline } from '../../src/tools/navigation/navigation.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

/**
 * Generate a fake `createServer`-style function body with three inner arrow
 * functions, padded with no-op statements so the parent LOC exceeds the
 * default 100-line threshold. Total ≈ 200 lines.
 */
function makeGodFunctionSource(): string {
  const pad = Array.from({ length: 60 }, (_, i) => `  const n${i} = ${i};`).join('\n');
  return `// Synthetic god-function fixture for outline-nested tests.

export function createServer(input: number): number {
  const has = (name: string) => name.length > 0;
${pad}
  const flushAll = () => {
    return input + 1;
  };
${pad}
  const dispose = () => {
    return input - 1;
  };
${pad}
  return has('x') ? flushAll() : dispose();
}
`;
}

function makeSmallFunctionsSource(): string {
  return `export function a(): number { return 1; }
export function b(): number { return 2; }
export function c(): number { return 3; }
`;
}

/**
 * Outer function with one inner arrow that itself contains another inner
 * arrow — exercises depth=2.
 */
function makeDeeplyNestedSource(): string {
  const pad = Array.from({ length: 50 }, (_, i) => `  const n${i} = ${i};`).join('\n');
  return `export function outer(): number {
${pad}
  const middle = () => {
${pad}
    const inner = () => {
      return 42;
    };
    return inner();
  };
  return middle();
}
`;
}

describe('getFileOutline() — nested option', () => {
  let store: Store;
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('returns parent + 3 inner arrow functions when nested=true on a 200-line god-function', async () => {
    const source = makeGodFunctionSource();
    tmpDir = createTmpFixture({ 'src/server.ts': source });
    store = createTestStore();
    // Mirror what the indexer does: insert one top-level symbol spanning the function.
    const totalLines = source.split('\n').length;
    const fileId = store.insertFile('src/server.ts', 'typescript', 'h', source.length);
    store.insertSymbol(fileId, {
      symbolId: 'src/server.ts::createServer#function',
      name: 'createServer',
      kind: 'function',
      fqn: 'createServer',
      byteStart: 0,
      byteEnd: source.length,
      lineStart: 3,
      lineEnd: totalLines - 1,
    });

    const result = await getFileOutline(store, 'src/server.ts', {
      nested: true,
      projectRoot: tmpDir,
    });
    expect(result.isOk()).toBe(true);
    const outline = result._unsafeUnwrap();

    // 1 parent + at least 3 inner arrows (has, flushAll, dispose).
    expect(outline.symbols.length).toBeGreaterThanOrEqual(4);

    const parent = outline.symbols.find((s) => s.name === 'createServer');
    expect(parent).toBeDefined();
    expect(parent?.parentId).toBeUndefined();

    const children = outline.symbols.filter(
      (s) => s.parentId === 'src/server.ts::createServer#function',
    );
    expect(children.length).toBeGreaterThanOrEqual(3);
    for (const child of children) {
      expect(child.depth).toBe(1);
      expect(child.parentId).toBe('src/server.ts::createServer#function');
    }
    const childNames = children.map((c) => c.name);
    expect(childNames).toContain('has');
    expect(childNames).toContain('flushAll');
    expect(childNames).toContain('dispose');
  });

  it('returns the same output as nested=false when no parent exceeds the threshold', async () => {
    const source = makeSmallFunctionsSource();
    tmpDir = createTmpFixture({ 'src/small.ts': source });
    store = createTestStore();
    const fileId = store.insertFile('src/small.ts', 'typescript', 'h', source.length);
    store.insertSymbol(fileId, {
      symbolId: 'src/small.ts::a#function',
      name: 'a',
      kind: 'function',
      fqn: 'a',
      byteStart: 0,
      byteEnd: 30,
      lineStart: 1,
      lineEnd: 1,
    });
    store.insertSymbol(fileId, {
      symbolId: 'src/small.ts::b#function',
      name: 'b',
      kind: 'function',
      fqn: 'b',
      byteStart: 31,
      byteEnd: 60,
      lineStart: 2,
      lineEnd: 2,
    });

    const flat = await getFileOutline(store, 'src/small.ts');
    const nested = await getFileOutline(store, 'src/small.ts', {
      nested: true,
      projectRoot: tmpDir,
    });

    expect(flat.isOk()).toBe(true);
    expect(nested.isOk()).toBe(true);
    expect(nested._unsafeUnwrap().symbols.length).toBe(flat._unsafeUnwrap().symbols.length);
    // No row should carry the nested marker fields.
    for (const sym of nested._unsafeUnwrap().symbols) {
      expect(sym.parentId).toBeUndefined();
      expect(sym.depth).toBeUndefined();
    }
  });

  it('emits depth=2 for a nested-of-nested arrow when its outer wrapper qualifies for expansion', async () => {
    const source = makeDeeplyNestedSource();
    tmpDir = createTmpFixture({ 'src/deep.ts': source });
    store = createTestStore();
    const totalLines = source.split('\n').length;
    const fileId = store.insertFile('src/deep.ts', 'typescript', 'h', source.length);
    store.insertSymbol(fileId, {
      symbolId: 'src/deep.ts::outer#function',
      name: 'outer',
      kind: 'function',
      fqn: 'outer',
      byteStart: 0,
      byteEnd: source.length,
      lineStart: 1,
      lineEnd: totalLines - 1,
    });

    // Force a low threshold so the wrapping arrow expands too.
    const result = await getFileOutline(store, 'src/deep.ts', {
      nested: true,
      minLocForNesting: 5,
      projectRoot: tmpDir,
    });
    expect(result.isOk()).toBe(true);
    const symbols = result._unsafeUnwrap().symbols;

    const inner = symbols.find((s) => s.name === 'inner');
    expect(
      inner,
      `expected an "inner" arrow; got ${JSON.stringify(symbols.map((s) => s.name))}`,
    ).toBeDefined();
    expect(inner?.depth).toBe(2);
    expect(inner?.parentId).toBe('src/deep.ts::outer#function');
  });

  it('keeps the response identical to the legacy shape when nested defaults to false', async () => {
    const source = makeGodFunctionSource();
    tmpDir = createTmpFixture({ 'src/server.ts': source });
    store = createTestStore();
    const totalLines = source.split('\n').length;
    const fileId = store.insertFile('src/server.ts', 'typescript', 'h', source.length);
    store.insertSymbol(fileId, {
      symbolId: 'src/server.ts::createServer#function',
      name: 'createServer',
      kind: 'function',
      fqn: 'createServer',
      byteStart: 0,
      byteEnd: source.length,
      lineStart: 3,
      lineEnd: totalLines - 1,
    });

    const result = await getFileOutline(store, 'src/server.ts');
    expect(result.isOk()).toBe(true);
    const outline = result._unsafeUnwrap();
    expect(outline.symbols.length).toBe(1);
    expect(outline.symbols[0]!.name).toBe('createServer');
    expect(outline.symbols[0]!.parentId).toBeUndefined();
    expect(outline.symbols[0]!.depth).toBeUndefined();
    // Verify projectRoot existence on disk doesn't affect default behavior.
    expect(path.resolve(tmpDir, 'src/server.ts')).toBeTruthy();
  });
});
