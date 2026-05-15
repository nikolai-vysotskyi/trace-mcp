/**
 * Behavioural coverage for `detectAstClones()`.
 *
 * Asserts:
 *  - Two structurally identical functions in different files form one clone
 *    group with size=2 and `symbols` listing both.
 *  - `min_loc` filter excludes function pairs below the LOC threshold.
 *  - An empty fixture returns zero groups.
 *  - The group shape carries { hash, size, loc, symbols }.
 *
 * detectAstClones reads files from disk and re-parses with tree-sitter, so
 * fixtures must be written to disk and the symbol byte ranges must line up.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { detectAstClones } from '../../../src/tools/analysis/ast-clones.js';
import { createTestStore } from '../../test-utils.js';

const TEST_DIR = path.join(tmpdir(), `trace-mcp-ast-clones-behav-${process.pid}`);

// A non-trivial body — large enough to clear the default min_nodes=30 filter
// after the identifier/literal placeholder pass.
function cloneBody(name: string): string {
  return [
    `export function ${name}(items, predicate) {`,
    '  const out = [];',
    '  for (let i = 0; i < items.length; i++) {',
    '    const item = items[i];',
    '    if (predicate(item)) {',
    '      out.push(item);',
    '    } else {',
    '      out.push(null);',
    '    }',
    '  }',
    '  for (const x of out) {',
    '    if (x === null) continue;',
    '    console.log(x);',
    '  }',
    '  return out;',
    '}',
    '',
  ].join('\n');
}

function writeAndInsert(store: Store, relPath: string, body: string, fnName: string): void {
  const absPath = path.join(TEST_DIR, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, body, 'utf-8');
  const fileId = store.insertFile(relPath, 'typescript', `h_${relPath}`, body.length);
  store.insertSymbol(fileId, {
    symbolId: `${relPath}::${fnName}#function`,
    name: fnName,
    kind: 'function',
    fqn: fnName,
    byteStart: 0,
    byteEnd: body.length,
    lineStart: 1,
    lineEnd: body.split('\n').length,
    signature: `function ${fnName}(items, predicate)`,
  });
}

describe('detect_ast_clones — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createTestStore();
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('two structurally identical functions in different files form one clone group', async () => {
    writeAndInsert(store, 'src/a.ts', cloneBody('first'), 'first');
    writeAndInsert(store, 'src/b.ts', cloneBody('second'), 'second');

    const result = await detectAstClones(store, TEST_DIR, {});
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.total_groups).toBeGreaterThanOrEqual(1);
    const group = data.groups[0];
    expect(group.size).toBe(2);
    const files = group.symbols.map((s) => s.file).sort();
    expect(files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('min_loc filter excludes function pairs below the LOC threshold', async () => {
    writeAndInsert(store, 'src/a.ts', cloneBody('first'), 'first');
    writeAndInsert(store, 'src/b.ts', cloneBody('second'), 'second');

    // Bodies are ~16 lines; min_loc=500 should exclude everything.
    const result = await detectAstClones(store, TEST_DIR, { min_loc: 500 });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.total_groups).toBe(0);
    expect(data.groups).toEqual([]);
  });

  it('empty fixture returns no groups', async () => {
    const result = await detectAstClones(store, TEST_DIR, {});
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.total_groups).toBe(0);
    expect(data.total_duplicated_symbols).toBe(0);
  });

  it('clone group carries documented shape { hash, size, loc, symbols }', async () => {
    writeAndInsert(store, 'src/a.ts', cloneBody('first'), 'first');
    writeAndInsert(store, 'src/b.ts', cloneBody('second'), 'second');

    const result = await detectAstClones(store, TEST_DIR, {});
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.groups.length).toBeGreaterThanOrEqual(1);
    const group = data.groups[0];
    expect(typeof group.hash).toBe('string');
    expect(group.hash.length).toBeGreaterThan(0);
    expect(typeof group.size).toBe('number');
    expect(typeof group.loc).toBe('number');
    expect(Array.isArray(group.symbols)).toBe(true);
    for (const s of group.symbols) {
      expect(typeof s.symbol_id).toBe('string');
      expect(typeof s.name).toBe('string');
      expect(typeof s.file).toBe('string');
      expect(typeof s.line_start).toBe('number');
      expect(typeof s.line_end).toBe('number');
    }
  });

  it('result envelope includes _methodology disclosure', async () => {
    const result = await detectAstClones(store, TEST_DIR, {});
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data._methodology).toBeDefined();
    expect(typeof data._methodology.algorithm).toBe('string');
    expect(Array.isArray(data._methodology.languages)).toBe(true);
  });
});
