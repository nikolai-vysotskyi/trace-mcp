import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { checkRenameSafe } from '../../src/tools/refactoring/rename-check.js';
import { createTestStore } from '../test-utils.js';

function insertFile(store: Store, filePath: string): number {
  return store.insertFile(filePath, 'typescript', `hash_${filePath}`, 100);
}

function insertSymbol(store: Store, fileId: number, name: string, kind = 'function'): number {
  return store.insertSymbol(fileId, {
    symbolId: `${name}#${kind}`,
    name,
    kind,
    byteStart: 0,
    byteEnd: 100,
  });
}

describe('checkRenameSafe', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('returns safe=true when no conflicts', () => {
    const fA = insertFile(store, 'src/a.ts');
    insertSymbol(store, fA, 'oldName');

    const result = checkRenameSafe(store, 'oldName#function', 'newName');
    expect(result.safe).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.current_name).toBe('oldName');
    expect(result.target_name).toBe('newName');
  });

  it('detects collision in same file', () => {
    const fA = insertFile(store, 'src/a.ts');
    insertSymbol(store, fA, 'alpha');
    insertSymbol(store, fA, 'beta');

    // Renaming alpha → beta should conflict
    const result = checkRenameSafe(store, 'alpha#function', 'beta');
    expect(result.safe).toBe(false);
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].reason).toBe('same_file');
    expect(result.conflicts[0].existing_name).toBe('beta');
  });

  it('detects collision in importing file', () => {
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    insertSymbol(store, fA, 'myFunc');
    insertSymbol(store, fB, 'targetName');

    // B imports A
    const nodeA = store.getNodeId('file', fA)!;
    const nodeB = store.getNodeId('file', fB)!;
    store.insertEdge(nodeB, nodeA, 'esm_imports', true);

    // Renaming myFunc → targetName should conflict (targetName exists in B which imports A)
    const result = checkRenameSafe(store, 'myFunc#function', 'targetName');
    expect(result.safe).toBe(false);
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].reason).toBe('importing_file');
    expect(result.conflicts[0].file).toBe('src/b.ts');
  });

  it('case-insensitive collision detection', () => {
    const fA = insertFile(store, 'src/a.ts');
    insertSymbol(store, fA, 'MyClass', 'class');
    insertSymbol(store, fA, 'myclass', 'function');

    const result = checkRenameSafe(store, 'MyClass#class', 'MYCLASS');
    // "myclass" matches "MYCLASS" case-insensitively
    expect(result.safe).toBe(false);
    expect(result.conflicts.length).toBe(1);
  });

  it('handles unknown symbol gracefully', () => {
    const result = checkRenameSafe(store, 'nonexistent#function', 'newName');
    expect(result.safe).toBe(false);
    expect(result.current_name).toBe('');
  });
});
