/**
 * Behavioural coverage for `getDataflow()`. Stages a tmp source file with
 * a function whose parameter flows into a downstream call + a mutation,
 * seeds the symbol with its signature, then exercises:
 *   - flows_to populated with { target, line }
 *   - multiple params tracked separately
 *   - direction options accepted (forward / backward / both)
 *   - unknown symbol surfaces a clear error envelope
 *   - output shape: { symbol, parameters, returns, localAssignments }
 *
 * NOTE: The brief calls the param array `params` with field name `flows`,
 * but the live contract uses `parameters` and `flows_to`. We assert
 * against the live contract.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getDataflow } from '../../../src/tools/analysis/dataflow.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../../test-utils.js';

interface Fixture {
  store: Store;
  projectRoot: string;
  processOrderSymbolId: string;
  multiParamSymbolId: string;
}

const PROCESS_ORDER_SRC = `function processOrder(order) {
  order.status = 'processing';
  validate(order);
  const result = persist(order);
  return result;
}
`;

const MULTI_PARAM_SRC = `function combine(left, right) {
  emitLeft(left);
  emitRight(right);
  return left;
}
`;

function seed(): Fixture {
  const projectRoot = createTmpFixture({
    'src/process.ts': PROCESS_ORDER_SRC,
    'src/combine.ts': MULTI_PARAM_SRC,
  });
  const store = createTestStore();

  const pFid = store.insertFile('src/process.ts', 'typescript', 'h-p', PROCESS_ORDER_SRC.length);
  store.insertSymbol(pFid, {
    symbolId: 'src/process.ts::processOrder#function',
    name: 'processOrder',
    kind: 'function',
    fqn: 'processOrder',
    signature: 'function processOrder(order)',
    byteStart: 0,
    byteEnd: PROCESS_ORDER_SRC.length,
    lineStart: 1,
    lineEnd: 6,
  });

  const cFid = store.insertFile('src/combine.ts', 'typescript', 'h-c', MULTI_PARAM_SRC.length);
  store.insertSymbol(cFid, {
    symbolId: 'src/combine.ts::combine#function',
    name: 'combine',
    kind: 'function',
    fqn: 'combine',
    signature: 'function combine(left, right)',
    byteStart: 0,
    byteEnd: MULTI_PARAM_SRC.length,
    lineStart: 1,
    lineEnd: 5,
  });

  return {
    store,
    projectRoot,
    processOrderSymbolId: 'src/process.ts::processOrder#function',
    multiParamSymbolId: 'src/combine.ts::combine#function',
  };
}

describe('getDataflow() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  afterEach(() => {
    removeTmpDir(ctx.projectRoot);
  });

  it('param flowing into a call surfaces as a flows_to sink with { target, line }', () => {
    const result = getDataflow(ctx.store, ctx.projectRoot, {
      symbolId: ctx.processOrderSymbolId,
    });
    expect(result.isOk()).toBe(true);
    const out = result._unsafeUnwrap();
    expect(out.parameters.length).toBe(1);
    const orderParam = out.parameters[0];
    expect(orderParam.name).toBe('order');
    const targets = orderParam.flows_to.map((f) => f.target);
    expect(targets).toContain('validate');
    expect(targets).toContain('persist');
    // Each sink must have a line number.
    for (const f of orderParam.flows_to) {
      expect(typeof f.line).toBe('number');
      expect(f.line).toBeGreaterThan(0);
    }
    // The order.status = 'processing' assignment must be captured as a mutation.
    expect(orderParam.mutations.length).toBeGreaterThan(0);
    expect(orderParam.mutations[0].property).toBe('status');
  });

  it('multiple parameters are tracked separately', () => {
    const result = getDataflow(ctx.store, ctx.projectRoot, {
      symbolId: ctx.multiParamSymbolId,
    });
    expect(result.isOk()).toBe(true);
    const out = result._unsafeUnwrap();
    const names = out.parameters.map((p) => p.name).sort();
    expect(names).toEqual(['left', 'right']);
    const leftParam = out.parameters.find((p) => p.name === 'left')!;
    const rightParam = out.parameters.find((p) => p.name === 'right')!;
    const leftTargets = leftParam.flows_to.map((f) => f.target);
    const rightTargets = rightParam.flows_to.map((f) => f.target);
    expect(leftTargets).toContain('emitLeft');
    expect(leftTargets).not.toContain('emitRight');
    expect(rightTargets).toContain('emitRight');
    expect(rightTargets).not.toContain('emitLeft');
  });

  it('direction options (forward/backward/both) are accepted without error', () => {
    for (const direction of ['forward', 'backward', 'both'] as const) {
      const result = getDataflow(ctx.store, ctx.projectRoot, {
        symbolId: ctx.processOrderSymbolId,
        direction,
      });
      expect(result.isOk()).toBe(true);
      const out = result._unsafeUnwrap();
      // Core shape is independent of direction for the intra-function pass.
      expect(out.parameters.length).toBe(1);
    }
  });

  it('unknown symbol returns a NOT_FOUND-style error envelope', () => {
    const result = getDataflow(ctx.store, ctx.projectRoot, {
      symbolId: 'src/nope.ts::ghost#function',
    });
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(typeof e.code).toBe('string');
    expect(e.code.length).toBeGreaterThan(0);
  });

  it('output shape: { symbol, parameters, returns, localAssignments }', () => {
    const result = getDataflow(ctx.store, ctx.projectRoot, {
      symbolId: ctx.processOrderSymbolId,
    });
    expect(result.isOk()).toBe(true);
    const out = result._unsafeUnwrap();
    expect(out.symbol).toBeDefined();
    expect(out.symbol.symbolId).toBe(ctx.processOrderSymbolId);
    expect(Array.isArray(out.parameters)).toBe(true);
    expect(Array.isArray(out.returns)).toBe(true);
    expect(Array.isArray(out.localAssignments)).toBe(true);
    // `return result;` should be captured.
    expect(out.returns.length).toBeGreaterThan(0);
    const returnExpr = out.returns[0].expression;
    expect(returnExpr).toContain('result');
    // `const result = persist(order)` should be a local assignment.
    const assignNames = out.localAssignments.map((a) => a.name);
    expect(assignNames).toContain('result');
  });
});
