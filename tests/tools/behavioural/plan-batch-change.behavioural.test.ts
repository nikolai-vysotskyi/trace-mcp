/**
 * Behavioural coverage for `planBatchChange()` in
 * `src/tools/project/batch-changes.ts` (the implementation behind the
 * `plan_batch_change` MCP tool). Generates an impact report + PR
 * template for upgrading a dependency. Output envelope:
 *   { package, from_version, to_version, affected_files, affected_count,
 *     breaking_changes, pr_template, risk_level }
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { planBatchChange } from '../../../src/tools/project/batch-changes.js';
import { createTestStore } from '../../test-utils.js';

/**
 * Seed a small file with a symbol whose metadata points at the target
 * package. The implementation matches via `metadata LIKE '%"module":"<pkg>%'`
 * so we have to embed the module in metadata to be picked up as
 * "imports this package".
 */
function seedExpressUser(store: Store): void {
  const f = store.insertFile('src/server.ts', 'typescript', 'h-srv', 400);
  store.insertSymbol(f, {
    symbolId: 'src/server.ts::router#variable',
    name: 'router',
    kind: 'variable',
    byteStart: 0,
    byteEnd: 30,
    lineStart: 3,
    lineEnd: 3,
    signature: 'const router = Router()',
    metadata: { module: 'express' },
  });
  // A symbol whose NAME contains the package — matched by the "directRefs" branch.
  const f2 = store.insertFile('src/express-helper.ts', 'typescript', 'h-h', 200);
  store.insertSymbol(f2, {
    symbolId: 'src/express-helper.ts::expressMiddleware#function',
    name: 'expressMiddleware',
    kind: 'function',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 5,
    signature: 'function expressMiddleware()',
  });
}

describe('planBatchChange() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('rejects empty package name', () => {
    const result = planBatchChange(store, { package: '' });
    expect(result.isErr()).toBe(true);
  });

  it('returns the documented envelope shape for a known package', () => {
    seedExpressUser(store);
    const result = planBatchChange(store, {
      package: 'express',
      fromVersion: '4.18.0',
      toVersion: '5.0.0',
    });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const v = result.value;
    expect(v.package).toBe('express');
    expect(v.from_version).toBe('4.18.0');
    expect(v.to_version).toBe('5.0.0');
    expect(Array.isArray(v.affected_files)).toBe(true);
    expect(typeof v.affected_count).toBe('number');
    expect(Array.isArray(v.breaking_changes)).toBe(true);
    expect(typeof v.pr_template).toBe('string');
    expect(['low', 'medium', 'high']).toContain(v.risk_level);
  });

  it('each affected file has { file, imports, symbols_using, line_references }', () => {
    seedExpressUser(store);
    const result = planBatchChange(store, { package: 'express' });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.affected_files.length).toBeGreaterThan(0);
    for (const af of result.value.affected_files) {
      expect(typeof af.file).toBe('string');
      expect(Array.isArray(af.imports)).toBe(true);
      expect(Array.isArray(af.symbols_using)).toBe(true);
      expect(Array.isArray(af.line_references)).toBe(true);
      // line_references should be numeric and sorted ascending
      for (let i = 1; i < af.line_references.length; i++) {
        expect(af.line_references[i]).toBeGreaterThanOrEqual(af.line_references[i - 1]);
      }
    }
    // affected_count tracks affected_files length
    expect(result.value.affected_count).toBe(result.value.affected_files.length);
  });

  it('breaking_changes are passed through and surface in pr_template', () => {
    seedExpressUser(store);
    const result = planBatchChange(store, {
      package: 'express',
      fromVersion: '4',
      toVersion: '5',
      breakingChanges: ['Removed res.json() default charset', 'Path-to-regexp v6 syntax'],
    });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.breaking_changes).toEqual([
      'Removed res.json() default charset',
      'Path-to-regexp v6 syntax',
    ]);
    expect(result.value.pr_template).toContain('Breaking Changes');
    expect(result.value.pr_template).toContain('Removed res.json() default charset');
    expect(result.value.pr_template).toContain('Path-to-regexp v6 syntax');
  });

  it('empty index returns a clear envelope with no affected files and low risk', () => {
    const result = planBatchChange(store, { package: 'totally-unused-pkg' });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.affected_files).toEqual([]);
    expect(result.value.affected_count).toBe(0);
    expect(result.value.risk_level).toBe('low');
    expect(result.value.pr_template).toContain('Update');
    expect(result.value.pr_template).toContain('totally-unused-pkg');
  });
});
