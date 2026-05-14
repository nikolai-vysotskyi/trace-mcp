/**
 * Behavioural coverage for `checkRenameSafe()` (the `check_rename` MCP tool).
 *
 * Asserts the read-only collision-detection contract:
 *   - safe rename → safe:true, conflicts:[]
 *   - same-file collision → safe:false, reason:same_file
 *   - importing-file collision → safe:false, reason:importing_file
 *   - output shape pinned (symbol_id, current_name, target_name, safe, conflicts)
 *   - unknown symbol_id → safe:false with empty conflicts (documented contract)
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { checkRenameSafe } from '../../../src/tools/refactoring/rename-check.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
  /** symbol with a unique name — rename should be safe */
  safeSymbolId: string;
  /** symbol in a file that also contains a same-named sibling */
  sameFileCollisionSymbolId: string;
  /** symbol in a file that is imported by another file containing a collision */
  importedSymbolId: string;
  /** name already present in the importing file */
  importerCollidingName: string;
}

function seed(): Fixture {
  const store = createTestStore();

  // 1. SAFE: src/safe.ts has only `aloneFn` — renaming to anything unique is safe.
  const safeFid = store.insertFile('src/safe.ts', 'typescript', 'h-s', 100);
  store.insertSymbol(safeFid, {
    symbolId: 'src/safe.ts::aloneFn#function',
    name: 'aloneFn',
    kind: 'function',
    fqn: 'aloneFn',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 5,
  });

  // 2. SAME-FILE COLLISION: src/dup.ts has both `oldName` and `existingName`.
  //    Trying to rename `oldName` -> `existingName` collides in the same file.
  const dupFid = store.insertFile('src/dup.ts', 'typescript', 'h-d', 100);
  store.insertSymbol(dupFid, {
    symbolId: 'src/dup.ts::oldName#function',
    name: 'oldName',
    kind: 'function',
    fqn: 'oldName',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 5,
  });
  store.insertSymbol(dupFid, {
    symbolId: 'src/dup.ts::existingName#function',
    name: 'existingName',
    kind: 'function',
    fqn: 'existingName',
    byteStart: 60,
    byteEnd: 100,
    lineStart: 7,
    lineEnd: 10,
  });

  // 3. IMPORTING-FILE COLLISION:
  //    - src/exported.ts exports `targetFn`
  //    - src/importer.ts imports it AND defines a local `clashName`
  //    - Renaming `targetFn` -> `clashName` should report importing_file conflict.
  const exportedFid = store.insertFile('src/exported.ts', 'typescript', 'h-e', 100);
  store.insertSymbol(exportedFid, {
    symbolId: 'src/exported.ts::targetFn#function',
    name: 'targetFn',
    kind: 'function',
    fqn: 'targetFn',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 5,
  });

  const importerFid = store.insertFile('src/importer.ts', 'typescript', 'h-i', 100);
  store.insertSymbol(importerFid, {
    symbolId: 'src/importer.ts::clashName#function',
    name: 'clashName',
    kind: 'function',
    fqn: 'clashName',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 5,
  });

  // Wire: importer file -> exported file (file-level "imports" edge).
  const exportedFileNid = store.getNodeId('file', exportedFid)!;
  const importerFileNid = store.getNodeId('file', importerFid)!;
  store.ensureEdgeType('imports', 'structural', 'file imports another file');
  store.insertEdge(
    importerFileNid,
    exportedFileNid,
    'imports',
    true,
    undefined,
    false,
    'ast_resolved',
  );

  return {
    store,
    safeSymbolId: 'src/safe.ts::aloneFn#function',
    sameFileCollisionSymbolId: 'src/dup.ts::oldName#function',
    importedSymbolId: 'src/exported.ts::targetFn#function',
    importerCollidingName: 'clashName',
  };
}

describe('checkRenameSafe() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('safe rename: no collisions returns safe:true with empty conflicts', () => {
    const result = checkRenameSafe(ctx.store, ctx.safeSymbolId, 'completelyFreshName');
    expect(result.safe).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.current_name).toBe('aloneFn');
    expect(result.target_name).toBe('completelyFreshName');
  });

  it('unsafe: target name already exists in same file → same_file conflict', () => {
    const result = checkRenameSafe(ctx.store, ctx.sameFileCollisionSymbolId, 'existingName');
    expect(result.safe).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
    const sameFileConflict = result.conflicts.find((c) => c.reason === 'same_file');
    expect(sameFileConflict).toBeDefined();
    expect(sameFileConflict!.existing_name).toBe('existingName');
    expect(sameFileConflict!.file).toBe('src/dup.ts');
  });

  it('importing-file conflict: importer has a same-named symbol → importing_file reason', () => {
    const result = checkRenameSafe(ctx.store, ctx.importedSymbolId, ctx.importerCollidingName);
    expect(result.safe).toBe(false);
    const importingConflict = result.conflicts.find((c) => c.reason === 'importing_file');
    expect(importingConflict).toBeDefined();
    expect(importingConflict!.existing_name).toBe(ctx.importerCollidingName);
    expect(importingConflict!.file).toBe('src/importer.ts');
  });

  it('output shape pinned: symbol_id, current_name, target_name, safe, conflicts', () => {
    const result = checkRenameSafe(ctx.store, ctx.safeSymbolId, 'someNewName');
    expect(result).toHaveProperty('symbol_id');
    expect(result).toHaveProperty('current_name');
    expect(result).toHaveProperty('target_name');
    expect(result).toHaveProperty('safe');
    expect(result).toHaveProperty('conflicts');
    expect(typeof result.safe).toBe('boolean');
    expect(Array.isArray(result.conflicts)).toBe(true);
  });

  it('unknown symbol_id: documented contract returns safe:false with empty current_name', () => {
    const result = checkRenameSafe(ctx.store, 'src/ghost.ts::nonexistent#function', 'anything');
    expect(result.safe).toBe(false);
    expect(result.current_name).toBe('');
    expect(result.target_name).toBe('anything');
    expect(result.conflicts).toEqual([]);
  });
});
