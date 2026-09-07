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

/**
 * TRA-1141: `__module__:foo` spans the whole file, so asking for it together
 * with a function inside it — which is what a changed-symbol review bundle does
 * on every commit that touches top-level code — shipped that function's body
 * twice. Measured on the PR-context benchmark's 13 losing PRs: 49 770 → 40 991
 * tokens across the set, worst case −136% → −52% against reading the files.
 */
describe('getContextBundle() — a container and its member ship one copy', () => {
  const MOD_SRC = [
    "const banner = 'top-level';",
    'export function inner() {',
    "  return 'INNER_BODY_MARKER';",
    '}',
    '',
  ].join('\n');
  let rootPath: string;
  let store: Store;

  beforeEach(() => {
    rootPath = createTmpFixture({ 'src/mod.ts': MOD_SRC });
    store = createTestStore();
    const fileId = store.insertFile('src/mod.ts', 'typescript', 'h-mod', MOD_SRC.length);
    store.insertSymbol(fileId, {
      symbolId: 'src/mod.ts::__module__#namespace',
      name: '__module__:mod',
      kind: 'namespace',
      fqn: '__module__:mod',
      byteStart: 0,
      byteEnd: MOD_SRC.length,
      lineStart: 1,
      lineEnd: 5,
      signature: '(module body) src/mod.ts',
    });
    store.insertSymbol(fileId, {
      symbolId: 'src/mod.ts::inner#function',
      name: 'inner',
      kind: 'function',
      fqn: 'inner',
      byteStart: MOD_SRC.indexOf('export function inner'),
      byteEnd: MOD_SRC.lastIndexOf('}') + 1,
      lineStart: 2,
      lineEnd: 4,
      signature: 'function inner()',
    });
  });

  afterEach(() => {
    removeTmpDir(rootPath);
  });

  it('emits the member body once, and still reports both symbols as delivered', () => {
    const result = getContextBundle(store, rootPath, {
      symbolIds: ['src/mod.ts::__module__#namespace', 'src/mod.ts::inner#function'],
      outputFormat: 'markdown',
      tokenBudget: 8000,
    });
    expect(result.isOk()).toBe(true);
    const bundle = result._unsafeUnwrap();
    const content = bundle.content ?? '';
    expect(content).toContain('INNER_BODY_MARKER');
    expect(content.split('INNER_BODY_MARKER').length - 1).toBe(1);
    // Both stay in the reported list: the member's bytes are inside the
    // container that replaced it, so it inherits that container's `detail`.
    expect(bundle.primary.map((p) => p.symbol_id).sort()).toEqual([
      'src/mod.ts::__module__#namespace',
      'src/mod.ts::inner#function',
    ]);
    expect(bundle.primary.every((p) => p.detail === 'full')).toBe(true);
  });
});

/**
 * Both cases below came out of review of the TRA-1141 change and are the two
 * ways it was still wrong: the reported delivery flag described what the bundle
 * asked the assembler for rather than what came back — TRA-1100 landed `detail`
 * for that in parallel, and these assert it stays true through the containment
 * rules — and containment was only ever checked in one direction.
 */
describe('getContextBundle() — delivery is reported, not requested', () => {
  const BIG = (marker: string) =>
    `export function ${marker}() {\n${`  // ${marker} filler line\n`.repeat(60)}  return '${marker}';\n}\n`;
  const A_SRC = BIG('bigA');
  const B_SRC = BIG('bigB');
  const CONTAINER_SRC = [
    'export class Container {',
    '  method() {',
    "    return 'METHOD_BODY_MARKER';",
    '  }',
    '}',
    '',
  ].join('\n');
  let rootPath: string;
  let store: Store;

  beforeEach(() => {
    rootPath = createTmpFixture({
      'src/a.ts': A_SRC,
      'src/b.ts': B_SRC,
      'src/container.ts': CONTAINER_SRC,
    });
    store = createTestStore();
    for (const [rel, src, name] of [
      ['src/a.ts', A_SRC, 'bigA'],
      ['src/b.ts', B_SRC, 'bigB'],
    ] as const) {
      const fileId = store.insertFile(rel, 'typescript', `h-${name}`, src.length);
      store.insertSymbol(fileId, {
        symbolId: `${rel}::${name}#function`,
        name,
        kind: 'function',
        fqn: name,
        byteStart: 0,
        byteEnd: src.length,
        lineStart: 1,
        lineEnd: src.split('\n').length,
        signature: `function ${name}()`,
      });
    }
    const containerFile = store.insertFile(
      'src/container.ts',
      'typescript',
      'h-container',
      CONTAINER_SRC.length,
    );
    const containerSym = store.insertSymbol(containerFile, {
      symbolId: 'src/container.ts::Container#class',
      name: 'Container',
      kind: 'class',
      fqn: 'Container',
      byteStart: 0,
      byteEnd: CONTAINER_SRC.indexOf('}\n', CONTAINER_SRC.indexOf('  }')) + 1,
      lineStart: 1,
      lineEnd: 5,
      signature: 'class Container',
    });
    const methodSym = store.insertSymbol(containerFile, {
      symbolId: 'src/container.ts::Container.method#method',
      name: 'method',
      kind: 'method',
      fqn: 'Container.method',
      byteStart: CONTAINER_SRC.indexOf('  method()'),
      byteEnd: CONTAINER_SRC.indexOf('  }') + 3,
      lineStart: 2,
      lineEnd: 4,
      signature: 'method()',
    });
    // The class surfaces as an import dependency of its own method — the shape
    // that shipped the method's body twice.
    store.insertEdge(
      store.getNodeId('symbol', methodSym)!,
      store.getNodeId('symbol', containerSym)!,
      'esm_imports',
      true,
      undefined,
      false,
      'ast_resolved',
    );
  });

  afterEach(() => {
    removeTmpDir(rootPath);
  });

  it('reports detail !== full when the budget left room for signatures only', () => {
    const result = getContextBundle(store, rootPath, {
      symbolIds: ['src/a.ts::bigA#function', 'src/b.ts::bigB#function'],
      outputFormat: 'markdown',
      tokenBudget: 60,
    });
    expect(result.isOk()).toBe(true);
    const bundle = result._unsafeUnwrap();
    expect(bundle.content ?? '').not.toContain('filler line');
    expect(bundle.primary.some((p) => p.detail === 'full')).toBe(false);
  });

  it('does not ship a primary twice inside a dependency that contains it', () => {
    const result = getContextBundle(store, rootPath, {
      symbolIds: ['src/container.ts::Container.method#method'],
      outputFormat: 'markdown',
      tokenBudget: 8000,
    });
    expect(result.isOk()).toBe(true);
    const bundle = result._unsafeUnwrap();
    // The containing class is present as a dependency — the guard is that its
    // body is not, because it would repeat the primary.
    expect(bundle.dependencies.map((d) => d.symbol_id)).toContain(
      'src/container.ts::Container#class',
    );
    const content = bundle.content ?? '';
    expect(content).toContain('METHOD_BODY_MARKER');
    expect(content.split('METHOD_BODY_MARKER').length - 1).toBe(1);
  });
});
