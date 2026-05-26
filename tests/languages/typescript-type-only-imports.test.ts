import { beforeAll, describe, expect, test } from 'vitest';
import {
  extractImportEdges,
  isInTypePosition,
} from '../../src/indexer/plugins/language/typescript/helpers.js';
import { ensureInitialized, getParser } from '../../src/parser/tree-sitter.js';

/**
 * `import('./x').T` used as a TYPE annotation looks like a `call_expression`
 * to tree-sitter, but it's erased at runtime. Counting it as a runtime
 * `imports` edge inflates the dependency graph with bogus SCCs of pure
 * type cross-references (the ~193-file SCC originally observed on this
 * repo's self-index).
 *
 * This suite verifies that:
 *   1. Value-position `import('./x')` still emits an edge.
 *   2. `field: import('./x').T` (type-annotation position) does NOT.
 *   3. `(): import('./x').T` (return-type position) does NOT.
 *   4. `type X = import('./x').T` (type-alias position) does NOT.
 *   5. Deeply nested generic positions (`Map<string, import('./x').T>`)
 *      do NOT emit either.
 */

async function parseTs(source: string) {
  const parser = await getParser('typescript');
  return parser.parse(source)!.rootNode;
}

describe('TypeScript import edges — type-only imports', () => {
  beforeAll(async () => {
    await ensureInitialized();
  });

  test('value-position dynamic import IS captured', async () => {
    const root = await parseTs(`
      async function lazyLoad() {
        const mod = await import('./lazy.js');
        return mod;
      }
    `);
    const edges = extractImportEdges(root);
    expect(edges.map((e) => e.metadata?.from)).toContain('./lazy.js');
  });

  test('CJS require IS captured', async () => {
    const root = await parseTs(`
      const mod = require('./cjs-thing.js');
    `);
    const edges = extractImportEdges(root);
    expect(edges.map((e) => e.metadata?.from)).toContain('./cjs-thing.js');
  });

  test("type-annotation `field: import('./x').T` is NOT captured", async () => {
    const root = await parseTs(`
      export interface ServerContext {
        onPipelineEvent: (event: import('./server.js').PipelineLifecycleEvent) => void;
      }
    `);
    const edges = extractImportEdges(root);
    expect(edges.map((e) => e.metadata?.from)).not.toContain('./server.js');
  });

  test("return-type `(): import('./x').T` is NOT captured", async () => {
    const root = await parseTs(`
      export function makeIt(): import('./shape.js').Shape {
        return null as any;
      }
    `);
    const edges = extractImportEdges(root);
    expect(edges.map((e) => e.metadata?.from)).not.toContain('./shape.js');
  });

  test("type-alias `type X = import('./x').T` is NOT captured", async () => {
    const root = await parseTs(`
      export type LocalAlias = import('./alias-source.js').OriginalType;
    `);
    const edges = extractImportEdges(root);
    expect(edges.map((e) => e.metadata?.from)).not.toContain('./alias-source.js');
  });

  test("nested-generic `Map<string, import('./x').T>` is NOT captured", async () => {
    const root = await parseTs(`
      export interface Holder {
        lookup: Map<string, Promise<import('./deep.js').Deep>>;
      }
    `);
    const edges = extractImportEdges(root);
    expect(edges.map((e) => e.metadata?.from)).not.toContain('./deep.js');
  });

  test('mixed: value-position import inside a function whose return type also references import() — only value-position counts', async () => {
    const root = await parseTs(`
      export async function loadAndAnnotate(): Promise<import('./types-only.js').Annotated> {
        const value = await import('./runtime-only.js');
        return value as any;
      }
    `);
    const edges = extractImportEdges(root);
    const sources = edges.map((e) => e.metadata?.from);
    expect(sources).toContain('./runtime-only.js');
    expect(sources).not.toContain('./types-only.js');
  });

  test('isInTypePosition returns false for top-level expression statements', async () => {
    const root = await parseTs(`
      const x = import('./y.js');
    `);
    // Find the call_expression and verify it's NOT classified as type-position.
    let callNode: ReturnType<typeof root.descendantForPosition> | null = null;
    const visit = (n: typeof root): void => {
      if (n.type === 'call_expression') {
        const fn = n.childForFieldName('function');
        if (fn?.type === 'import') {
          callNode = n;
          return;
        }
      }
      for (const child of n.namedChildren) visit(child);
    };
    visit(root);
    expect(callNode).not.toBeNull();
    expect(isInTypePosition(callNode!)).toBe(false);
  });
});
