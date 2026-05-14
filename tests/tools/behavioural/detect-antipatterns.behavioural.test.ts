/**
 * Behavioural coverage for `detectAntipatterns()`. Focuses on the size /
 * complexity detectors that operate on any indexed symbol — god_class,
 * long_method, long_parameter_list, deep_nesting — because the ORM-scoped
 * detectors require an active ORM plugin. Asserts the documented output
 * contract (findings carry { id, category, severity, file, line, fix,
 * confidence }) and that category + severity_threshold filters work.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { detectAntipatterns } from '../../../src/tools/quality/antipatterns.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../../test-utils.js';

interface Fixture {
  store: Store;
  rootPath: string;
}

/**
 * Build a fixture that triggers god_class, long_method, long_parameter_list,
 * and deep_nesting in one in-memory Store + tmp dir. deep_nesting must read
 * the source file from disk, so the file path/byte ranges have to line up
 * with the on-disk content.
 */
function seed(): Fixture {
  // Body with >= DEEP_NESTING_THRESHOLD (5) levels of 2-space indent
  const deepBody = `function deeplyNested(x) {
  if (x > 0) {
    if (x > 1) {
      if (x > 2) {
        if (x > 3) {
          if (x > 4) {
            if (x > 5) {
              return x;
            }
          }
        }
      }
    }
  }
  return 0;
}
`;

  // 70-line long method body (>= LONG_METHOD_LOC_THRESHOLD = 60)
  const longMethodLines = ['function longy() {'];
  for (let i = 0; i < 70; i++) longMethodLines.push(`  const v${i} = ${i};`);
  longMethodLines.push('  return 0;');
  longMethodLines.push('}');
  const longMethodBody = longMethodLines.join('\n') + '\n';

  // Many-param function (>= 6 params)
  const wideSrc = 'function wide(a, b, c, d, e, f, g) { return a; }\n';

  // God class — also dump 26 method symbols pointing at it
  const godClassHeader = 'class GodClass {\n';
  const godClassMethodLines: string[] = [];
  for (let i = 0; i < 26; i++) godClassMethodLines.push(`  m${i}() { return ${i}; }`);
  const godClassSrc = godClassHeader + godClassMethodLines.join('\n') + '\n}\n';

  const rootPath = createTmpFixture({
    'src/deep.ts': deepBody,
    'src/long.ts': longMethodBody,
    'src/wide.ts': wideSrc,
    'src/god.ts': godClassSrc,
  });

  const store = createTestStore();

  // deep_nesting fixture
  const deepFile = store.insertFile('src/deep.ts', 'typescript', 'h-deep', deepBody.length);
  store.insertSymbol(deepFile, {
    symbolId: 'src/deep.ts::deeplyNested#function',
    name: 'deeplyNested',
    kind: 'function',
    fqn: 'deeplyNested',
    byteStart: 0,
    byteEnd: deepBody.length,
    lineStart: 1,
    lineEnd: deepBody.split('\n').length,
    signature: 'function deeplyNested(x)',
  });

  // long_method fixture
  const longFile = store.insertFile('src/long.ts', 'typescript', 'h-long', longMethodBody.length);
  store.insertSymbol(longFile, {
    symbolId: 'src/long.ts::longy#function',
    name: 'longy',
    kind: 'function',
    fqn: 'longy',
    byteStart: 0,
    byteEnd: longMethodBody.length,
    lineStart: 1,
    lineEnd: longMethodBody.split('\n').length,
    signature: 'function longy()',
  });

  // long_parameter_list fixture
  const wideFile = store.insertFile('src/wide.ts', 'typescript', 'h-wide', wideSrc.length);
  store.insertSymbol(wideFile, {
    symbolId: 'src/wide.ts::wide#function',
    name: 'wide',
    kind: 'function',
    fqn: 'wide',
    byteStart: 0,
    byteEnd: wideSrc.length,
    lineStart: 1,
    lineEnd: 1,
    signature: 'function wide(a, b, c, d, e, f, g)',
  });

  // god_class fixture: insert the class as a parent_id target for 26 method children
  const godFile = store.insertFile('src/god.ts', 'typescript', 'h-god', godClassSrc.length);
  store.insertSymbol(godFile, {
    symbolId: 'src/god.ts::GodClass#class',
    name: 'GodClass',
    kind: 'class',
    fqn: 'GodClass',
    byteStart: 0,
    byteEnd: godClassSrc.length,
    lineStart: 1,
    lineEnd: godClassSrc.split('\n').length,
    signature: 'class GodClass',
  });
  for (let i = 0; i < 26; i++) {
    store.insertSymbol(godFile, {
      symbolId: `src/god.ts::m${i}#method`,
      name: `m${i}`,
      kind: 'method',
      fqn: `GodClass.m${i}`,
      byteStart: 0,
      byteEnd: 10,
      lineStart: 2 + i,
      lineEnd: 2 + i,
      signature: `m${i}()`,
      parentSymbolId: 'src/god.ts::GodClass#class',
    });
  }

  return { store, rootPath };
}

describe('detectAntipatterns() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  afterEach(() => {
    removeTmpDir(ctx.rootPath);
  });

  it('god_class detector fires on a class with 25+ child methods', () => {
    const result = detectAntipatterns(ctx.store, ctx.rootPath, { category: ['god_class'] });
    expect(result.isOk()).toBe(true);
    const findings = result._unsafeUnwrap().findings;
    const hits = findings.filter((f) => f.category === 'god_class');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].file).toBe('src/god.ts');
    expect(hits[0].related_symbols).toContain('src/god.ts::GodClass#class');
  });

  it('long_method detector fires on methods with 60+ LOC', () => {
    const result = detectAntipatterns(ctx.store, ctx.rootPath, { category: ['long_method'] });
    expect(result.isOk()).toBe(true);
    const findings = result._unsafeUnwrap().findings;
    const hits = findings.filter((f) => f.category === 'long_method');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.related_symbols?.includes('src/long.ts::longy#function'))).toBe(true);
  });

  it('long_parameter_list detector fires on 6+ params', () => {
    const result = detectAntipatterns(ctx.store, ctx.rootPath, {
      category: ['long_parameter_list'],
    });
    expect(result.isOk()).toBe(true);
    const findings = result._unsafeUnwrap().findings;
    const hits = findings.filter((f) => f.category === 'long_parameter_list');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].related_symbols).toContain('src/wide.ts::wide#function');
  });

  it('deep_nesting detector fires on functions with 5+ indent levels', () => {
    const result = detectAntipatterns(ctx.store, ctx.rootPath, { category: ['deep_nesting'] });
    expect(result.isOk()).toBe(true);
    const findings = result._unsafeUnwrap().findings;
    const hits = findings.filter((f) => f.category === 'deep_nesting');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].related_symbols).toContain('src/deep.ts::deeplyNested#function');
  });

  it('findings carry documented shape', () => {
    const result = detectAntipatterns(ctx.store, ctx.rootPath, {
      category: ['long_parameter_list', 'long_method'],
    });
    expect(result.isOk()).toBe(true);
    const findings = result._unsafeUnwrap().findings;
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(typeof f.id).toBe('string');
      expect(typeof f.category).toBe('string');
      expect(['critical', 'high', 'medium', 'low']).toContain(f.severity);
      expect(typeof f.title).toBe('string');
      expect(typeof f.description).toBe('string');
      expect(typeof f.file).toBe('string');
      expect(typeof f.fix).toBe('string');
      expect(typeof f.confidence).toBe('number');
    }
  });

  it("severity_threshold='high' excludes lower-severity findings", () => {
    // long_parameter_list with 7 params yields 'medium' severity (>=10 → high).
    // With threshold 'high' that medium finding must be filtered out.
    const result = detectAntipatterns(ctx.store, ctx.rootPath, {
      category: ['long_parameter_list'],
      severity_threshold: 'high',
    });
    expect(result.isOk()).toBe(true);
    const findings = result._unsafeUnwrap().findings;
    for (const f of findings) {
      expect(['critical', 'high']).toContain(f.severity);
    }
  });

  it('category filter narrows scope to requested detectors only', () => {
    const result = detectAntipatterns(ctx.store, ctx.rootPath, {
      category: ['long_parameter_list'],
    });
    expect(result.isOk()).toBe(true);
    const findings = result._unsafeUnwrap().findings;
    for (const f of findings) {
      expect(f.category).toBe('long_parameter_list');
    }
  });
});
