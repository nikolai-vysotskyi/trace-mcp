/**
 * Behavioural coverage for the `get_tests_for` MCP tool (`getTestsFor()`).
 *
 * The existing tests/tools/get_tests_for.test.ts covers heuristic path
 * matching in detail; this file complements it by asserting the cross-cutting
 * contract a caller of the MCP tool relies on:
 *
 *  - Positive: symbol with a matching test file (foo.ts + foo.test.ts) is
 *    returned via the heuristic path strategy.
 *  - Positive: file_path query returns tests touching that file.
 *  - Negative: no test → empty `tests` array (not null, not throw).
 *  - test_covers graph edges are surfaced with edge_type='test_covers'.
 *  - The result envelope shape (target/tests/total) stays stable.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { getTestsFor } from '../../../src/tools/framework/tests.js';
import { createTestStore } from '../../test-utils.js';

describe('get_tests_for — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('returns the matching test file via heuristic path (foo.ts → foo.test.ts)', () => {
    const srcFileId = store.insertFile('src/foo.ts', 'typescript', 'h1', 100);
    store.insertSymbol(srcFileId, {
      symbolId: 'src/foo.ts::Foo#class',
      name: 'Foo',
      kind: 'class',
      byteStart: 0,
      byteEnd: 100,
    });
    store.insertFile('tests/foo.test.ts', 'typescript', 'h2', 60);

    const result = getTestsFor(store, { symbolId: 'src/foo.ts::Foo#class' });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.tests).toHaveLength(1);
    expect(data.tests[0].test_file).toBe('tests/foo.test.ts');
    expect(data.total).toBe(1);
    expect(data.target.symbol_id).toBe('src/foo.ts::Foo#class');
    expect(data.target.file).toBe('src/foo.ts');
  });

  it('file_path query returns tests touching that file', () => {
    store.insertFile('src/util.ts', 'typescript', 'h1', 100);
    store.insertFile('tests/util.test.ts', 'typescript', 'h2', 50);

    const result = getTestsFor(store, { filePath: 'src/util.ts' });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.tests).toHaveLength(1);
    expect(data.tests[0].test_file).toBe('tests/util.test.ts');
    expect(data.target.file).toBe('src/util.ts');
    // symbol_id is undefined for file-only queries.
    expect(data.target.symbol_id).toBeUndefined();
  });

  it('returns an empty array (not null, not throw) when no test exists', () => {
    const srcFileId = store.insertFile('src/lone.ts', 'typescript', 'h1', 80);
    store.insertSymbol(srcFileId, {
      symbolId: 'src/lone.ts::lone#function',
      name: 'lone',
      kind: 'function',
      byteStart: 0,
      byteEnd: 30,
    });

    const result = getTestsFor(store, { symbolId: 'src/lone.ts::lone#function' });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(Array.isArray(data.tests)).toBe(true);
    expect(data.tests).toEqual([]);
    expect(data.total).toBe(0);
  });

  it('test_covers graph edges are surfaced with edge_type="test_covers"', () => {
    const srcFileId = store.insertFile('src/auth.ts', 'typescript', 'h1', 100);
    const symId = store.insertSymbol(srcFileId, {
      symbolId: 'src/auth.ts::authenticate#function',
      name: 'authenticate',
      kind: 'function',
      byteStart: 0,
      byteEnd: 80,
    });
    // Test file lives in a directory whose name does not contain "auth", so
    // the heuristic path matcher will not pick it up. The edge is the only
    // signal.
    const testFileId = store.insertFile(
      'tests/integration/login-flow.spec.ts',
      'typescript',
      'h2',
      50,
    );

    const testFileNid = store.getNodeId('file', testFileId)!;
    const targetSymNid = store.getNodeId('symbol', symId)!;
    store.insertEdge(
      testFileNid,
      targetSymNid,
      'test_covers',
      true,
      undefined,
      false,
      'ast_resolved',
    );

    const result = getTestsFor(store, { symbolId: 'src/auth.ts::authenticate#function' });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.tests.length).toBeGreaterThanOrEqual(1);
    const edgeBacked = data.tests.find((t) => t.edge_type === 'test_covers');
    expect(edgeBacked).toBeDefined();
    expect(edgeBacked!.test_file).toBe('tests/integration/login-flow.spec.ts');
  });

  it('result envelope: target / tests / total fields are present and consistent', () => {
    store.insertFile('src/util.ts', 'typescript', 'h1', 100);
    store.insertFile('tests/util.test.ts', 'typescript', 'h2', 50);

    const result = getTestsFor(store, { filePath: 'src/util.ts' });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data).toHaveProperty('target');
    expect(data).toHaveProperty('tests');
    expect(data).toHaveProperty('total');
    expect(data.total).toBe(data.tests.length);
    for (const t of data.tests) {
      expect(typeof t.test_file).toBe('string');
      expect(typeof t.edge_type).toBe('string');
    }
  });
});
