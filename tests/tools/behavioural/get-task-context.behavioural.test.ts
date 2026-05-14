/**
 * Behavioural coverage for `getTaskContext()`. Builds an in-memory Store +
 * a tmp fixture dir so the source-reader can resolve byte ranges. Asserts the
 * documented output shape ({ task, intent, sections, totalTokens, truncated,
 * seedCount, graphNodesExplored }) and that focus, includeTests and tokenBudget
 * options affect the result as documented.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getTaskContext } from '../../../src/tools/navigation/task-context.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../../test-utils.js';

interface Fixture {
  store: Store;
  rootPath: string;
}

const SERVICE_SRC = `export class PaymentService {
  charge(amount: number): Promise<Receipt> {
    return processCharge(amount);
  }
}
`;

const TEST_SRC = `import { PaymentService } from './payment.service';
describe('PaymentService.charge', () => {
  it('charges', () => {
    new PaymentService().charge(100);
  });
});
`;

function seed(): Fixture {
  const rootPath = createTmpFixture({
    'src/payment.service.ts': SERVICE_SRC,
    'tests/payment.test.ts': TEST_SRC,
  });

  const store = createTestStore();
  const srcFile = store.insertFile('src/payment.service.ts', 'typescript', 'h-pay', 200);
  store.insertSymbol(srcFile, {
    symbolId: 'src/payment.service.ts::PaymentService#class',
    name: 'PaymentService',
    kind: 'class',
    fqn: 'PaymentService',
    byteStart: 0,
    byteEnd: SERVICE_SRC.length,
    lineStart: 1,
    lineEnd: 5,
    signature: 'class PaymentService',
  });
  store.insertSymbol(srcFile, {
    symbolId: 'src/payment.service.ts::charge#method',
    name: 'charge',
    kind: 'method',
    fqn: 'PaymentService.charge',
    byteStart: SERVICE_SRC.indexOf('charge'),
    byteEnd: SERVICE_SRC.indexOf('  }'),
    lineStart: 2,
    lineEnd: 4,
    signature: 'charge(amount: number): Promise<Receipt>',
  });

  const testFile = store.insertFile('tests/payment.test.ts', 'typescript', 'h-test', 200);
  store.insertSymbol(testFile, {
    symbolId: 'tests/payment.test.ts::charges#test',
    name: 'charges',
    kind: 'test',
    fqn: 'charges',
    byteStart: 0,
    byteEnd: TEST_SRC.length,
    lineStart: 1,
    lineEnd: 6,
    signature: "it('charges')",
  });

  return { store, rootPath };
}

describe('getTaskContext() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  afterEach(() => {
    removeTmpDir(ctx.rootPath);
  });

  it('returns shape { task, intent, sections, totalTokens, truncated, seedCount, graphNodesExplored }', async () => {
    const result = await getTaskContext(ctx.store, ctx.rootPath, {
      task: 'understand the PaymentService charge flow',
    });
    expect(result.task).toBe('understand the PaymentService charge flow');
    expect(['bugfix', 'new_feature', 'refactor', 'understand']).toContain(result.intent);
    expect(result.sections).toBeDefined();
    expect(Array.isArray(result.sections.primary)).toBe(true);
    expect(Array.isArray(result.sections.dependencies)).toBe(true);
    expect(Array.isArray(result.sections.callers)).toBe(true);
    expect(Array.isArray(result.sections.tests)).toBe(true);
    expect(Array.isArray(result.sections.types)).toBe(true);
    expect(typeof result.totalTokens).toBe('number');
    expect(typeof result.truncated).toBe('boolean');
    expect(typeof result.seedCount).toBe('number');
    expect(typeof result.graphNodesExplored).toBe('number');
  });

  it('classifies intent from task verbs', async () => {
    const fix = await getTaskContext(ctx.store, ctx.rootPath, {
      task: 'fix bug in PaymentService charge',
    });
    expect(fix.intent).toBe('bugfix');

    const feat = await getTaskContext(ctx.store, ctx.rootPath, {
      task: 'add new charge method to PaymentService',
    });
    expect(feat.intent).toBe('new_feature');
  });

  it('focus=minimal returns <= number of primary items than focus=broad', async () => {
    const minimal = await getTaskContext(ctx.store, ctx.rootPath, {
      task: 'understand PaymentService charge',
      focus: 'minimal',
    });
    const broad = await getTaskContext(ctx.store, ctx.rootPath, {
      task: 'understand PaymentService charge',
      focus: 'broad',
    });
    expect(minimal.seedCount).toBeLessThanOrEqual(broad.seedCount);
  });

  it('includeTests=false strips test items', async () => {
    const noTests = await getTaskContext(ctx.store, ctx.rootPath, {
      task: 'understand PaymentService charge',
      includeTests: false,
    });
    // Test files might still surface as deps in some intents, but the test
    // section's budget is zeroed when includeTests=false.
    expect(noTests.sections.tests.length).toBe(0);
  });

  it('respects tokenBudget — totalTokens stays within budget', async () => {
    const tight = await getTaskContext(ctx.store, ctx.rootPath, {
      task: 'understand PaymentService charge',
      tokenBudget: 300,
    });
    expect(tight.totalTokens).toBeLessThanOrEqual(300);
  });

  it('returns empty sections for a no-match task', async () => {
    const result = await getTaskContext(ctx.store, ctx.rootPath, {
      task: 'zzzNonExistentSymbolReferenceXYZZZ',
    });
    expect(result.sections.primary).toEqual([]);
    expect(result.sections.dependencies).toEqual([]);
    expect(result.sections.callers).toEqual([]);
    expect(result.totalTokens).toBe(0);
  });
});
