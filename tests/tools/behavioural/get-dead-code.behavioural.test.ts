/**
 * Behavioural coverage for the `get_dead_code` MCP tool. The implementation
 * has two modes exposed as separate functions:
 *   - `getDeadCodeV2`            — multi-signal default mode
 *   - `getDeadCodeReachability`  — BFS from entry points
 *
 * The existing tests/tools/dead-code.test.ts covers the multi-signal
 * algorithm in detail. This file complements it by asserting the
 * cross-cutting contract surface a caller of the MCP tool relies on:
 *   - V2 reports a symbol that is exported but never imported / called /
 *     re-exported with confidence ≥ threshold and a `_methodology` envelope.
 *   - V2 respects the `threshold` knob (0.99 returns fewer items than 0.0).
 *   - V2 respects `filePattern` (narrows scope to matched files only).
 *   - Reachability mode picks up only symbols *not* reachable from the
 *     supplied entry points, and reports the entry-point count.
 *   - The result envelope shape stays stable (mode, dead_symbols, totals,
 *     _methodology).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import {
  getDeadCodeReachability,
  getDeadCodeV2,
} from '../../../src/tools/refactoring/dead-code.js';
import { createTestStore } from '../../test-utils.js';

function insertFile(store: Store, filePath: string, lang = 'typescript'): number {
  return store.insertFile(filePath, lang, `h_${filePath}`, 100);
}

function insertExported(store: Store, fileId: number, name: string, kind = 'function'): number {
  return store.insertSymbol(fileId, {
    symbolId: `sym:${name}`,
    name,
    kind,
    byteStart: 0,
    byteEnd: 50,
    metadata: { exported: true },
  });
}

describe('get_dead_code — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('multi-signal mode: an exported-but-unused symbol scores high confidence', () => {
    const fA = insertFile(store, 'src/orphan.ts');
    insertExported(store, fA, 'orphanFn');

    const result = getDeadCodeV2(store);
    expect(result.total_exports).toBe(1);
    expect(result.total_dead).toBe(1);
    expect(result.dead_symbols[0].name).toBe('orphanFn');
    expect(result.dead_symbols[0].confidence).toBeGreaterThanOrEqual(0.5);
    // Default mode envelope: _methodology must be present.
    expect(result._methodology).toBeDefined();
  });

  it('multi-signal mode: higher threshold returns fewer items than lower threshold', () => {
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    insertExported(store, fA, 'fnA');
    insertExported(store, fB, 'fnB');
    // fnB is imported from B → it loses signal 1 (notImported = false),
    // so confidence drops to ~0.67. A 0.99 threshold should exclude it.
    const nodeB = store.getNodeId('file', fB)!;
    const nodeA = store.getNodeId('file', fA)!;
    store.insertEdge(nodeA, nodeB, 'esm_imports', true, { specifiers: ['fnB'] });

    const low = getDeadCodeV2(store, { threshold: 0.0 });
    const high = getDeadCodeV2(store, { threshold: 0.99 });
    expect(low.total_dead).toBeGreaterThanOrEqual(high.total_dead);
    // fnA has all 3 signals firing (confidence 1.0), so even a strict
    // threshold of 0.99 must still pick it up.
    expect(high.dead_symbols.some((d) => d.name === 'fnA')).toBe(true);
    expect(high.threshold).toBe(0.99);
  });

  it('multi-signal mode: filePattern narrows scope to matching files only', () => {
    const fLib = insertFile(store, 'src/lib/widget.ts');
    const fUtil = insertFile(store, 'src/util/helper.ts');
    insertExported(store, fLib, 'widgetFn');
    insertExported(store, fUtil, 'helperFn');

    const result = getDeadCodeV2(store, { filePattern: 'src/lib/%' });
    expect(result.file_pattern).toBe('src/lib/%');
    // Only widgetFn lives under src/lib — helperFn must not appear.
    for (const item of result.dead_symbols) {
      expect(item.file.startsWith('src/lib/')).toBe(true);
    }
    expect(result.dead_symbols.some((d) => d.name === 'widgetFn')).toBe(true);
    expect(result.dead_symbols.some((d) => d.name === 'helperFn')).toBe(false);
  });

  it('reachability mode: BFS from supplied entry points marks unreached exports dead', () => {
    // Entry file contains `entryFn` that calls `reachedFn` in lib.
    const entryFile = insertFile(store, 'src/entry.ts');
    const libFile = insertFile(store, 'src/lib.ts');

    const entrySymId = insertExported(store, entryFile, 'entryFn');
    const reachedSymId = insertExported(store, libFile, 'reachedFn');
    // `orphanFn` lives in lib but nothing reaches it.
    insertExported(store, libFile, 'orphanFn');

    const entryNid = store.getNodeId('symbol', entrySymId)!;
    const reachedNid = store.getNodeId('symbol', reachedSymId)!;
    store.insertEdge(entryNid, reachedNid, 'calls', true, undefined, false, 'ast_resolved');

    const result = getDeadCodeReachability(store, {
      entryPoints: ['src/entry.ts'],
    });
    expect(result.mode).toBe('reachability');
    expect(result._methodology).toBeDefined();
    expect(result.entry_points.total).toBeGreaterThan(0);
    // orphanFn is unreachable and must appear; reachedFn must not.
    const deadNames = result.dead_symbols.map((d) => d.name);
    expect(deadNames).toContain('orphanFn');
    expect(deadNames).not.toContain('reachedFn');
    for (const item of result.dead_symbols) {
      expect(item.reason).toBe('unreachable_from_entry_points');
    }
  });

  it('multi-signal mode envelope: dead_symbols is an array and totals are numeric', () => {
    const result = getDeadCodeV2(store);
    expect(Array.isArray(result.dead_symbols)).toBe(true);
    expect(typeof result.total_exports).toBe('number');
    expect(typeof result.total_dead).toBe('number');
    expect(typeof result.threshold).toBe('number');
    // _methodology disclosure is part of the public contract.
    expect(result._methodology).toBeDefined();
  });
});
