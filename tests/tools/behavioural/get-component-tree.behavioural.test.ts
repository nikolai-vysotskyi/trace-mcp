/**
 * Behavioural coverage for `getComponentTree()` (the `get_component_tree`
 * MCP tool). Builds a parent -> child component graph with `renders_component`
 * edges between the parent's class symbol and the child's class symbol, then
 * asserts the recursive tree shape, depth handling, and NOT_FOUND envelope.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getComponentTree } from '../../../src/tools/framework/components.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
  parentPath: string;
  childPath: string;
  orphanPath: string;
}

function seedComponent(
  store: Store,
  filePath: string,
  componentName: string,
  props: Record<string, unknown> = { id: 'String' },
): { fileId: number; classSymbolDbId: number } {
  const fileId = store.insertFile(filePath, 'vue', `h-${componentName}`, 500);
  const classDbId = store.insertSymbol(fileId, {
    symbolId: `${filePath}::${componentName}#class`,
    name: componentName,
    kind: 'class',
    fqn: componentName,
    byteStart: 0,
    byteEnd: 200,
    lineStart: 1,
    lineEnd: 20,
  });
  store.insertComponent(
    {
      name: componentName,
      kind: 'component',
      framework: 'vue',
      props,
      emits: ['change'],
      slots: ['default'],
      composables: ['useStore'],
    },
    fileId,
  );
  return { fileId, classSymbolDbId: classDbId };
}

function seed(): Fixture {
  const store = createTestStore();

  const parent = seedComponent(store, 'src/components/Parent.vue', 'Parent');
  const child = seedComponent(store, 'src/components/Child.vue', 'Child', { label: 'String' });
  const orphan = seedComponent(store, 'src/components/Orphan.vue', 'Orphan');

  // Wire Parent class -> Child class via `renders_component`.
  const parentNid = store.getNodeId('symbol', parent.classSymbolDbId);
  const childNid = store.getNodeId('symbol', child.classSymbolDbId);
  if (parentNid != null && childNid != null) {
    store.insertEdge(
      parentNid,
      childNid,
      'renders_component',
      true,
      undefined,
      false,
      'ast_resolved',
    );
  }

  // Orphan has no incoming/outgoing render edges — used for depth/empty assertions.
  void orphan;

  return {
    store,
    parentPath: 'src/components/Parent.vue',
    childPath: 'src/components/Child.vue',
    orphanPath: 'src/components/Orphan.vue',
  };
}

describe('getComponentTree() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('returns ok envelope with a rooted tree for a known component', () => {
    const result = getComponentTree(ctx.store, ctx.parentPath);
    expect(result.isOk()).toBe(true);
    const tree = result._unsafeUnwrap();
    expect(tree.root).toBeDefined();
    expect(tree.root.name).toBe('Parent');
    expect(tree.root.path).toBe(ctx.parentPath);
    expect(Array.isArray(tree.root.children)).toBe(true);
    expect(typeof tree.totalComponents).toBe('number');
  });

  it('root carries props/emits/slots/composables parsed from stored JSON', () => {
    const result = getComponentTree(ctx.store, ctx.parentPath);
    expect(result.isOk()).toBe(true);
    const root = result._unsafeUnwrap().root;
    expect(root.props).toEqual(['id']);
    expect(root.emits).toEqual(['change']);
    expect(root.slots).toEqual(['default']);
    expect(root.composables).toEqual(['useStore']);
  });

  it('follows renders_component edges to recurse into child components', () => {
    const result = getComponentTree(ctx.store, ctx.parentPath, 3);
    expect(result.isOk()).toBe(true);
    const root = result._unsafeUnwrap().root;
    expect(root.children.length).toBe(1);
    expect(root.children[0].name).toBe('Child');
    expect(root.children[0].path).toBe(ctx.childPath);
  });

  it('depth=0 returns root only — child recursion is short-circuited', () => {
    const result = getComponentTree(ctx.store, ctx.parentPath, 0);
    expect(result.isOk()).toBe(true);
    const root = result._unsafeUnwrap().root;
    expect(root.children).toEqual([]);
  });

  it('orphan component returns root with no children', () => {
    const result = getComponentTree(ctx.store, ctx.orphanPath);
    expect(result.isOk()).toBe(true);
    const root = result._unsafeUnwrap().root;
    expect(root.name).toBe('Orphan');
    expect(root.children).toEqual([]);
  });

  it('unknown component path surfaces NOT_FOUND error', () => {
    const result = getComponentTree(ctx.store, 'src/components/Nope.vue');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('NOT_FOUND');
  });
});
