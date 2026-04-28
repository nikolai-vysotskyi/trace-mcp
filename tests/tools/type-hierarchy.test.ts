import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { getTypeHierarchy } from '../../src/tools/analysis/introspect.js';
import { createTestStore } from '../test-utils.js';

function addSymbol(
  store: Store,
  opts: {
    filePath: string;
    name: string;
    kind: string;
    metadata?: Record<string, unknown>;
  },
) {
  const file = store.getFile(opts.filePath);
  const fileId = file ? file.id : store.insertFile(opts.filePath, 'typescript', null, null);
  store.insertSymbol(fileId, {
    symbolId: `${opts.filePath}::${opts.name}#${opts.kind}`,
    name: opts.name,
    kind: opts.kind as any,
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 10,
    metadata: opts.metadata,
  });
}

describe('getTypeHierarchy', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('returns empty ancestors/descendants for unknown type', () => {
    const result = getTypeHierarchy(store, 'NonExistent');
    expect(result.root).toBe('NonExistent');
    expect(result.ancestors).toHaveLength(0);
    expect(result.descendants).toHaveLength(0);
  });

  it('walks up extends chain: C extends B extends A', () => {
    addSymbol(store, { filePath: 'src/a.ts', name: 'A', kind: 'class' });
    addSymbol(store, {
      filePath: 'src/b.ts',
      name: 'B',
      kind: 'class',
      metadata: { extends: 'A' },
    });
    addSymbol(store, {
      filePath: 'src/c.ts',
      name: 'C',
      kind: 'class',
      metadata: { extends: 'B' },
    });

    const result = getTypeHierarchy(store, 'C');
    // C's ancestors: B (extends), and B's ancestor A
    expect(result.ancestors.length).toBeGreaterThanOrEqual(1);
    expect(result.ancestors[0].name).toBe('B');
    expect(result.ancestors[0].relation).toBe('extends');
  });

  it('finds descendants (subclasses)', () => {
    addSymbol(store, { filePath: 'src/base.ts', name: 'Base', kind: 'class' });
    addSymbol(store, {
      filePath: 'src/child1.ts',
      name: 'Child1',
      kind: 'class',
      metadata: { extends: 'Base' },
    });
    addSymbol(store, {
      filePath: 'src/child2.ts',
      name: 'Child2',
      kind: 'class',
      metadata: { extends: 'Base' },
    });

    const result = getTypeHierarchy(store, 'Base');
    expect(result.descendants).toHaveLength(2);
    const names = result.descendants.map((d) => d.name).sort();
    expect(names).toEqual(['Child1', 'Child2']);
  });

  it('handles implements', () => {
    addSymbol(store, { filePath: 'src/iface.ts', name: 'Serializable', kind: 'interface' });
    addSymbol(store, {
      filePath: 'src/impl.ts',
      name: 'User',
      kind: 'class',
      metadata: { implements: ['Serializable'] },
    });

    const result = getTypeHierarchy(store, 'Serializable');
    expect(result.descendants).toHaveLength(1);
    expect(result.descendants[0].name).toBe('User');
    expect(result.descendants[0].relation).toBe('implements');
  });

  it('respects max depth', () => {
    addSymbol(store, { filePath: 'src/a.ts', name: 'A', kind: 'class' });
    addSymbol(store, {
      filePath: 'src/b.ts',
      name: 'B',
      kind: 'class',
      metadata: { extends: 'A' },
    });
    addSymbol(store, {
      filePath: 'src/c.ts',
      name: 'C',
      kind: 'class',
      metadata: { extends: 'B' },
    });

    // maxDepth=1: from C, only sees B, not A
    const result = getTypeHierarchy(store, 'C', 1);
    expect(result.ancestors).toHaveLength(1);
    expect(result.ancestors[0].name).toBe('B');
    expect(result.ancestors[0].children).toHaveLength(0); // depth exhausted
  });

  it('does not infinite loop on cycles', () => {
    addSymbol(store, {
      filePath: 'src/a.ts',
      name: 'X',
      kind: 'class',
      metadata: { extends: 'Y' },
    });
    addSymbol(store, {
      filePath: 'src/b.ts',
      name: 'Y',
      kind: 'class',
      metadata: { extends: 'X' },
    });

    // Should complete without hanging
    const result = getTypeHierarchy(store, 'X');
    expect(result.root).toBe('X');
  });
});
