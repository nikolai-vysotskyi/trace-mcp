/**
 * Behavioural coverage for the `get_dead_exports` MCP tool.
 *
 * Asserts the contract surface a caller of the MCP tool relies on:
 *   - An exported symbol that is never imported elsewhere appears in
 *     `dead_exports`.
 *   - An exported symbol whose name appears as an import specifier on any
 *     `imports` / `esm_imports` / `py_imports` edge is excluded.
 *   - The `file_pattern` filter narrows the scope to matching files only.
 *   - An empty index returns `{ dead_exports: [], total_exports: 0,
 *     total_dead: 0 }` cleanly.
 *   - Each entry in `dead_exports` carries the documented `{ symbol_id,
 *     name, kind, file }` shape.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { getDeadExports } from '../../../src/tools/analysis/introspect.js';
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

describe('get_dead_exports — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('exported symbol with no inbound import shows up in dead_exports', () => {
    const fA = insertFile(store, 'src/orphan.ts');
    insertExported(store, fA, 'orphanFn');

    const result = getDeadExports(store);
    expect(result.total_exports).toBe(1);
    expect(result.total_dead).toBe(1);
    expect(result.dead_exports).toHaveLength(1);
    const item = result.dead_exports[0];
    expect(item.name).toBe('orphanFn');
    expect(item.kind).toBe('function');
    expect(item.file).toBe('src/orphan.ts');
    expect(item.symbol_id).toBe('sym:orphanFn');
  });

  it('exported symbol imported by another file is NOT reported dead', () => {
    const fA = insertFile(store, 'src/lib.ts');
    const fB = insertFile(store, 'src/consumer.ts');
    insertExported(store, fA, 'usedFn');
    insertExported(store, fB, 'orphanFn');

    // Add an esm_imports edge from consumer → lib with specifier `usedFn`.
    const nodeA = store.getNodeId('file', fA)!;
    const nodeB = store.getNodeId('file', fB)!;
    store.insertEdge(nodeB, nodeA, 'esm_imports', true, { specifiers: ['usedFn'] });

    const result = getDeadExports(store);
    const deadNames = result.dead_exports.map((d) => d.name);
    expect(deadNames).not.toContain('usedFn');
    expect(deadNames).toContain('orphanFn');
    expect(result.total_exports).toBe(2);
    expect(result.total_dead).toBe(1);
  });

  it('file_pattern narrows scope to matching files only', () => {
    const fLib = insertFile(store, 'src/lib/widget.ts');
    const fUtil = insertFile(store, 'src/util/helper.ts');
    insertExported(store, fLib, 'widgetFn');
    insertExported(store, fUtil, 'helperFn');

    const result = getDeadExports(store, 'src/lib/%');
    expect(result.file_pattern).toBe('src/lib/%');
    for (const item of result.dead_exports) {
      expect(item.file.startsWith('src/lib/')).toBe(true);
    }
    expect(result.dead_exports.some((d) => d.name === 'widgetFn')).toBe(true);
    expect(result.dead_exports.some((d) => d.name === 'helperFn')).toBe(false);
  });

  it('empty index returns a clean envelope with zero counts', () => {
    const result = getDeadExports(store);
    expect(result.dead_exports).toEqual([]);
    expect(result.total_exports).toBe(0);
    expect(result.total_dead).toBe(0);
    expect(result.file_pattern).toBeNull();
  });

  it('each dead_exports entry exposes the documented { symbol_id, name, kind, file } shape', () => {
    const f = insertFile(store, 'src/shape.ts');
    insertExported(store, f, 'classyExport', 'class');

    const result = getDeadExports(store);
    expect(result.dead_exports).toHaveLength(1);
    const item = result.dead_exports[0];
    expect(typeof item.symbol_id).toBe('string');
    expect(typeof item.name).toBe('string');
    expect(typeof item.kind).toBe('string');
    expect(typeof item.file).toBe('string');
    expect(item.kind).toBe('class');
  });
});
