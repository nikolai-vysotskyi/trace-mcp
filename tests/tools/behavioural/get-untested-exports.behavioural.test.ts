/**
 * Behavioural coverage for the `get_untested_exports` MCP tool.
 *
 * Asserts the contract surface a caller of the MCP tool relies on:
 *   - An exported symbol whose source file has no matching test file is
 *     reported in `untested`.
 *   - An exported symbol with a co-located test file is excluded.
 *   - The `file_pattern` filter narrows scope.
 *   - An empty index returns `{ untested: [], total_exports: 0,
 *     total_untested: 0 }` cleanly.
 *   - Each entry exposes the documented `{ symbol_id, name, kind, file }`
 *     shape (plus `signature` and `line`).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { getUntestedExports } from '../../../src/tools/analysis/introspect.js';
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

describe('get_untested_exports — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('exported symbol with no matching test file shows up in untested', () => {
    const f = insertFile(store, 'src/widget.ts');
    insertExported(store, f, 'widgetFn');

    const result = getUntestedExports(store);
    expect(result.total_exports).toBe(1);
    expect(result.total_untested).toBe(1);
    expect(result.untested).toHaveLength(1);
    expect(result.untested[0].name).toBe('widgetFn');
    expect(result.untested[0].file).toBe('src/widget.ts');
  });

  it('exported symbol with a co-located test file is excluded', () => {
    const fSrc = insertFile(store, 'src/widget.ts');
    insertExported(store, fSrc, 'widgetFn');
    // Co-located test file — basename `widget` is contained in `widget.test.ts`.
    insertFile(store, 'tests/widget.test.ts');

    // Unrelated export with no test → must still appear.
    const fOther = insertFile(store, 'src/orphan.ts');
    insertExported(store, fOther, 'orphanFn');

    const result = getUntestedExports(store);
    const names = result.untested.map((u) => u.name);
    expect(names).not.toContain('widgetFn');
    expect(names).toContain('orphanFn');
  });

  it('file_pattern narrows scope to matching files only', () => {
    const fLib = insertFile(store, 'src/lib/widget.ts');
    const fUtil = insertFile(store, 'src/util/helper.ts');
    insertExported(store, fLib, 'widgetFn');
    insertExported(store, fUtil, 'helperFn');

    const result = getUntestedExports(store, 'src/lib/%');
    expect(result.file_pattern).toBe('src/lib/%');
    for (const item of result.untested) {
      expect(item.file.startsWith('src/lib/')).toBe(true);
    }
    expect(result.untested.some((u) => u.name === 'widgetFn')).toBe(true);
    expect(result.untested.some((u) => u.name === 'helperFn')).toBe(false);
  });

  it('empty index returns a clean envelope with zero counts', () => {
    const result = getUntestedExports(store);
    expect(result.untested).toEqual([]);
    expect(result.total_exports).toBe(0);
    expect(result.total_untested).toBe(0);
    expect(result.file_pattern).toBeNull();
  });

  it('each untested entry exposes the documented { symbol_id, name, kind, file } shape', () => {
    const f = insertFile(store, 'src/shape.ts');
    insertExported(store, f, 'shapedExport', 'class');

    const result = getUntestedExports(store);
    expect(result.untested).toHaveLength(1);
    const item = result.untested[0];
    expect(typeof item.symbol_id).toBe('string');
    expect(typeof item.name).toBe('string');
    expect(typeof item.kind).toBe('string');
    expect(typeof item.file).toBe('string');
    expect(item.kind).toBe('class');
  });
});
