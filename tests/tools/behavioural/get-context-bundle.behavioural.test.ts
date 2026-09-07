/**
 * Behavioural coverage for `getContextBundle()`. Builds primary symbol + shared
 * import dependency + a caller fixture so we can verify output shape
 * ({ primary, dependencies, callers, totalTokens, truncated }), batch shared-
 * import deduplication, includeCallers, tokenBudget, and outputFormat='markdown'.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getContextBundle } from '../../../src/tools/navigation/context-bundle.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../../test-utils.js';

interface Fixture {
  store: Store;
  rootPath: string;
  primaryAId: string;
  primaryBId: string;
  sharedDepId: string;
}

const SHARED_SRC = 'export function shared() { return 1; }\n';
const A_SRC = 'export function consumerA() { return shared(); }\n';
const B_SRC = 'export function consumerB() { return shared(); }\n';
const CALLER_SRC = 'import { consumerA } from "./a"; export function caller() { consumerA(); }\n';

function seed(): Fixture {
  const rootPath = createTmpFixture({
    'src/shared.ts': SHARED_SRC,
    'src/a.ts': A_SRC,
    'src/b.ts': B_SRC,
    'src/caller.ts': CALLER_SRC,
  });

  const store = createTestStore();

  const sharedFile = store.insertFile('src/shared.ts', 'typescript', 'h-shared', SHARED_SRC.length);
  const sharedSymInternalId = store.insertSymbol(sharedFile, {
    symbolId: 'src/shared.ts::shared#function',
    name: 'shared',
    kind: 'function',
    fqn: 'shared',
    byteStart: 0,
    byteEnd: SHARED_SRC.length,
    lineStart: 1,
    lineEnd: 1,
    signature: 'function shared()',
  });
  const sharedNid = store.getNodeId('symbol', sharedSymInternalId)!;

  const aFile = store.insertFile('src/a.ts', 'typescript', 'h-a', A_SRC.length);
  const aSym = store.insertSymbol(aFile, {
    symbolId: 'src/a.ts::consumerA#function',
    name: 'consumerA',
    kind: 'function',
    fqn: 'consumerA',
    byteStart: 0,
    byteEnd: A_SRC.length,
    lineStart: 1,
    lineEnd: 1,
    signature: 'function consumerA()',
  });
  const aNid = store.getNodeId('symbol', aSym)!;

  const bFile = store.insertFile('src/b.ts', 'typescript', 'h-b', B_SRC.length);
  const bSym = store.insertSymbol(bFile, {
    symbolId: 'src/b.ts::consumerB#function',
    name: 'consumerB',
    kind: 'function',
    fqn: 'consumerB',
    byteStart: 0,
    byteEnd: B_SRC.length,
    lineStart: 1,
    lineEnd: 1,
    signature: 'function consumerB()',
  });
  const bNid = store.getNodeId('symbol', bSym)!;

  // Both consumers import the same shared symbol (deduplication target).
  store.insertEdge(aNid, sharedNid, 'esm_imports', true, undefined, false, 'ast_resolved');
  store.insertEdge(bNid, sharedNid, 'esm_imports', true, undefined, false, 'ast_resolved');

  // Add a caller of consumerA so includeCallers has something to surface.
  const callerFile = store.insertFile('src/caller.ts', 'typescript', 'h-caller', CALLER_SRC.length);
  const callerSym = store.insertSymbol(callerFile, {
    symbolId: 'src/caller.ts::caller#function',
    name: 'caller',
    kind: 'function',
    fqn: 'caller',
    byteStart: 0,
    byteEnd: CALLER_SRC.length,
    lineStart: 1,
    lineEnd: 1,
    signature: 'function caller()',
  });
  const callerNid = store.getNodeId('symbol', callerSym)!;
  store.insertEdge(callerNid, aNid, 'calls', true, undefined, false, 'ast_resolved');

  return {
    store,
    rootPath,
    primaryAId: 'src/a.ts::consumerA#function',
    primaryBId: 'src/b.ts::consumerB#function',
    sharedDepId: 'src/shared.ts::shared#function',
  };
}

describe('getContextBundle() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  afterEach(() => {
    removeTmpDir(ctx.rootPath);
  });

  it('single symbol returns shape { primary, dependencies, callers, totalTokens, truncated }', () => {
    const result = getContextBundle(ctx.store, ctx.rootPath, {
      symbolIds: [ctx.primaryAId],
    });
    expect(result.isOk()).toBe(true);
    const bundle = result._unsafeUnwrap();
    expect(Array.isArray(bundle.primary)).toBe(true);
    expect(Array.isArray(bundle.dependencies)).toBe(true);
    expect(Array.isArray(bundle.callers)).toBe(true);
    expect(typeof bundle.totalTokens).toBe('number');
    expect(typeof bundle.truncated).toBe('boolean');
    expect(bundle.primary.map((p) => p.symbol_id)).toContain(ctx.primaryAId);
  });

  it('batch symbol_ids deduplicates shared imports', () => {
    const result = getContextBundle(ctx.store, ctx.rootPath, {
      symbolIds: [ctx.primaryAId, ctx.primaryBId],
    });
    expect(result.isOk()).toBe(true);
    const bundle = result._unsafeUnwrap();
    // shared appears as a dep only once even though both consumers import it
    const sharedHits = bundle.dependencies.filter((d) => d.symbol_id === ctx.sharedDepId);
    expect(sharedHits.length).toBe(1);
    expect(bundle.primary.length).toBe(2);
  });

  it('includeCallers=true surfaces incoming-call references', () => {
    const result = getContextBundle(ctx.store, ctx.rootPath, {
      symbolIds: [ctx.primaryAId],
      includeCallers: true,
    });
    expect(result.isOk()).toBe(true);
    const bundle = result._unsafeUnwrap();
    const callerNames = bundle.callers.map((c) => c.name);
    expect(callerNames).toContain('caller');
  });

  it('includeCallers default (false) returns empty callers list', () => {
    const result = getContextBundle(ctx.store, ctx.rootPath, {
      symbolIds: [ctx.primaryAId],
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().callers).toEqual([]);
  });

  it('respects tokenBudget — totalTokens stays within budget', () => {
    const result = getContextBundle(ctx.store, ctx.rootPath, {
      symbolIds: [ctx.primaryAId, ctx.primaryBId],
      tokenBudget: 100,
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().totalTokens).toBeLessThanOrEqual(100);
  });

  /**
   * TRA-1090: the markdown bundle carried only signatures for three months —
   * `FileReadCache` used a bare `require('node:fs')`, which throws under ESM
   * and was swallowed by a catch. Nothing asserted that a body ever reached
   * the caller, so the PR-context benchmark measured a source-free context and
   * reported it as 90.6% savings. Assert on the body, not on the shape.
   */
  it('markdown output carries the primary symbol body, not just its signature', () => {
    const result = getContextBundle(ctx.store, ctx.rootPath, {
      symbolIds: [ctx.primaryAId],
      outputFormat: 'markdown',
      tokenBudget: 8000,
    });
    expect(result.isOk()).toBe(true);
    const content = result._unsafeUnwrap().content ?? '';
    expect(content).toContain('return shared();');
  });

  it('unknown symbol_id returns err with NOT_FOUND', () => {
    const result = getContextBundle(ctx.store, ctx.rootPath, {
      symbolIds: ['src/does-not-exist.ts::nope#function'],
    });
    expect(result.isErr()).toBe(true);
  });

  /**
   * TRA-1100 code review: a dependency assembly drops entirely (no source,
   * no signature — `tryAssemble` returns null) must not appear in the
   * returned `dependencies` array, and must not shift a later, valid
   * dependency out of the list. A count-based slice of the pre-assembly
   * list gets this wrong: it keeps the first N *requested* deps regardless
   * of which ones assembly actually kept, so metadata can list a dropped
   * symbol and omit a rendered one.
   */
  it('a dependency assembly drops entirely is excluded, without displacing a later one', () => {
    const primarySrc = `import { depBefore } from "./before";\nimport { depGhost } from "./ghost";\nimport { depAfter } from "./after";\nexport function primary() { return depBefore() + depAfter(); }\n`;
    const beforeSrc = 'export function depBefore() { return 1; }\n';
    const afterSrc = 'export function depAfter() { return 2; }\n';
    const rootPath = createTmpFixture({
      'src/primary.ts': primarySrc,
      'src/before.ts': beforeSrc,
      'src/after.ts': afterSrc,
      // 'src/ghost.ts' deliberately not written — its symbol has no readable
      // source, and (below) no signature either, so it can't be assembled.
    });
    const store = createTestStore();

    const primaryFile = store.insertFile('src/primary.ts', 'typescript', 'h-p', primarySrc.length);
    const primaryInternalId = store.insertSymbol(primaryFile, {
      symbolId: 'src/primary.ts::primary#function',
      name: 'primary',
      kind: 'function',
      fqn: 'primary',
      byteStart: 0,
      byteEnd: primarySrc.length,
      lineStart: 1,
      lineEnd: 1,
      signature: 'function primary()',
    });
    const primaryNid = store.getNodeId('symbol', primaryInternalId)!;

    const beforeFile = store.insertFile('src/before.ts', 'typescript', 'h-b', beforeSrc.length);
    const beforeInternalId = store.insertSymbol(beforeFile, {
      symbolId: 'src/before.ts::depBefore#function',
      name: 'depBefore',
      kind: 'function',
      fqn: 'depBefore',
      byteStart: 0,
      byteEnd: beforeSrc.length,
      lineStart: 1,
      lineEnd: 1,
      signature: 'function depBefore()',
    });
    const beforeNid = store.getNodeId('symbol', beforeInternalId)!;

    // No file written on disk for 'src/ghost.ts' and no `signature` given —
    // tryAssemble has neither source nor signature to fall back to.
    const ghostFile = store.insertFile('src/ghost.ts', 'typescript', 'h-g', 0);
    const ghostInternalId = store.insertSymbol(ghostFile, {
      symbolId: 'src/ghost.ts::depGhost#function',
      name: 'depGhost',
      kind: 'function',
      fqn: 'depGhost',
      byteStart: 0,
      byteEnd: 0,
      lineStart: 1,
      lineEnd: 1,
    });
    const ghostNid = store.getNodeId('symbol', ghostInternalId)!;

    const afterFile = store.insertFile('src/after.ts', 'typescript', 'h-a', afterSrc.length);
    const afterInternalId = store.insertSymbol(afterFile, {
      symbolId: 'src/after.ts::depAfter#function',
      name: 'depAfter',
      kind: 'function',
      fqn: 'depAfter',
      byteStart: 0,
      byteEnd: afterSrc.length,
      lineStart: 1,
      lineEnd: 1,
      signature: 'function depAfter()',
    });
    const afterNid = store.getNodeId('symbol', afterInternalId)!;

    store.insertEdge(primaryNid, beforeNid, 'esm_imports', true, undefined, false, 'ast_resolved');
    store.insertEdge(primaryNid, ghostNid, 'esm_imports', true, undefined, false, 'ast_resolved');
    store.insertEdge(primaryNid, afterNid, 'esm_imports', true, undefined, false, 'ast_resolved');

    try {
      const result = getContextBundle(store, rootPath, {
        symbolIds: ['src/primary.ts::primary#function'],
        outputFormat: 'markdown',
        tokenBudget: 8000,
      });
      expect(result.isOk()).toBe(true);
      const bundle = result._unsafeUnwrap();

      const depIds = bundle.dependencies.map((d) => d.symbol_id);
      expect(depIds).not.toContain('src/ghost.ts::depGhost#function');
      expect(depIds).toContain('src/before.ts::depBefore#function');
      expect(depIds).toContain('src/after.ts::depAfter#function');
      expect(bundle.dependencies.every((d) => d.detail === 'full')).toBe(true);

      const content = bundle.content ?? '';
      expect(content).toContain('return 1;');
      expect(content).toContain('return 2;');
    } finally {
      removeTmpDir(rootPath);
    }
  });
});
