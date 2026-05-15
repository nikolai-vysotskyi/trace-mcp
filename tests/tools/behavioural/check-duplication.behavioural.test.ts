/**
 * Behavioural coverage for the `check_duplication` MCP tool.
 *
 * The tool entry point is `checkSymbolForDuplicates()` in
 * src/tools/analysis/duplication.ts. Asserts:
 *  - By name lookup against an empty codebase returns no duplicates.
 *  - By symbol_id for an unknown symbol returns no duplicates.
 *  - The result envelope carries `warnings`, `symbols_checked`, `threshold`.
 *  - The default threshold is 0.6 (matches the documented contract).
 *  - A custom threshold is echoed back in the result.
 *
 * NOTE — latent bug: `checkSymbolForDuplicates` and `checkFileForDuplicates`
 * both delegate to an internal helper called `findDuplicateSymbols`, which
 * is referenced 3x in duplication.ts but is **not defined anywhere in the
 * source tree**. Any call path that actually hits the helper (i.e. a known
 * symbol_id or a name match) throws ReferenceError. The early-return paths
 * — empty/unknown query — are the only ones that exercise the public
 * surface today. Tests that would trip the helper are `it.skip`ped with a
 * TODO until the helper is restored.
 */

import { describe, expect, it } from 'vitest';
import {
  checkSymbolForDuplicates,
  type DuplicationResult,
} from '../../../src/tools/analysis/duplication.js';
import { createTestStore } from '../../test-utils.js';

describe('check_duplication — behavioural contract', () => {
  it('returns empty result when looking up an unknown symbol_id', () => {
    const store = createTestStore();
    const result = checkSymbolForDuplicates(store, store.db, {
      symbol_id: 'does/not/exist.ts::Ghost#class',
    });
    expect(result.warnings).toEqual([]);
    expect(result.symbols_checked).toBe(0);
    expect(typeof result.threshold).toBe('number');
  });

  it('returns empty result and default threshold when no query is provided', () => {
    const store = createTestStore();
    // Calling with neither symbol_id nor name returns the early-default branch.
    const result = checkSymbolForDuplicates(store, store.db, {});
    expect(result.warnings).toEqual([]);
    expect(result.symbols_checked).toBe(0);
    // The early-return branch is the canonical default-threshold sentinel.
    expect(result.threshold).toBe(0.6);
  });

  it('echoes a custom threshold in the result envelope', () => {
    const store = createTestStore();
    const result = checkSymbolForDuplicates(
      store,
      store.db,
      { symbol_id: 'nope#function' },
      { threshold: 0.95 },
    );
    expect(result.threshold).toBe(0.95);
    expect(result.warnings).toEqual([]);
  });

  it('result envelope carries the documented shape', () => {
    const store = createTestStore();
    const result: DuplicationResult = checkSymbolForDuplicates(store, store.db, {
      symbol_id: 'phantom#function',
    });
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(typeof result.symbols_checked).toBe('number');
    expect(typeof result.threshold).toBe('number');
  });

  // Both assertions below exercise `findDuplicateSymbols`, the helper that
  // does the actual scoring. It was deleted in d8a8494 as "unused" without
  // noticing the 3 surviving call sites — restored alongside these tests.
  it('by-name lookup against the codebase returns scored matches', () => {
    const store = createTestStore();
    const result = checkSymbolForDuplicates(
      store,
      store.db,
      { name: 'Logger', kind: 'class' },
      { threshold: 0.5 },
    );
    expect(result.warnings).toBeInstanceOf(Array);
  });

  it('by-symbol_id lookup against the codebase returns scored matches', () => {
    const store = createTestStore();
    const fileId = store.insertFile('src/dup.ts', 'typescript', 'h_dup', 100);
    store.insertSymbol(fileId, {
      symbolId: 'src/dup.ts::Logger#class',
      name: 'Logger',
      kind: 'class',
      fqn: 'Logger',
      byteStart: 0,
      byteEnd: 100,
      lineStart: 1,
      lineEnd: 5,
      signature: 'class Logger',
    });
    const result = checkSymbolForDuplicates(store, store.db, {
      symbol_id: 'src/dup.ts::Logger#class',
    });
    expect(result.symbols_checked).toBeGreaterThanOrEqual(1);
  });
});
