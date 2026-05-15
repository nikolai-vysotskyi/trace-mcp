/**
 * Behavioural coverage for `getDependencyGraph()` (the `get_import_graph`
 * MCP tool). Verifies:
 *   - file with outgoing + incoming `imports` edges returns non-empty
 *     `imports` and `imported_by` arrays
 *   - file with no edges returns empty arrays
 *   - unknown file path returns an empty envelope (no crash)
 *   - each edge entry carries source/target/specifiers fields
 *
 * Note on edge types: `getDependencyGraph` filters on
 * `edge_type_name === 'imports'` (the PHP-style import edge), NOT
 * `esm_imports`. We wire fixtures with 'imports' to exercise the real path.
 */

import { describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getDependencyGraph } from '../../../src/tools/analysis/introspect.js';
import { createTestStore } from '../../test-utils.js';

function insertFile(store: Store, path: string): number {
  return store.insertFile(path, 'php', `h-${path}`, 100);
}

function wireImport(store: Store, srcPath: string, tgtPath: string): void {
  const srcRow = store.db.prepare('SELECT id FROM files WHERE path = ?').get(srcPath) as
    | { id: number }
    | undefined;
  const tgtRow = store.db.prepare('SELECT id FROM files WHERE path = ?').get(tgtPath) as
    | { id: number }
    | undefined;
  if (!srcRow || !tgtRow) throw new Error(`Missing file rows for ${srcPath} or ${tgtPath}`);
  const srcNid = store.getNodeId('file', srcRow.id)!;
  const tgtNid = store.getNodeId('file', tgtRow.id)!;
  store.insertEdge(srcNid, tgtNid, 'imports', true, undefined, false, 'ast_resolved');
}

describe('getDependencyGraph() — behavioural contract', () => {
  it('returns non-empty imports + imported_by arrays for a file with edges', () => {
    const store = createTestStore();
    for (const p of [
      'src/Service.php',
      'src/Dependency1.php',
      'src/Dependency2.php',
      'src/Consumer.php',
    ]) {
      insertFile(store, p);
    }
    // Service depends on two libs.
    wireImport(store, 'src/Service.php', 'src/Dependency1.php');
    wireImport(store, 'src/Service.php', 'src/Dependency2.php');
    // Consumer depends on Service.
    wireImport(store, 'src/Consumer.php', 'src/Service.php');

    const result = getDependencyGraph(store, 'src/Service.php');
    expect(result.file).toBe('src/Service.php');
    expect(result.imports.length).toBe(2);
    expect(result.imported_by.length).toBe(1);

    const importTargets = result.imports.map((e) => e.target).sort();
    expect(importTargets).toEqual(['src/Dependency1.php', 'src/Dependency2.php']);
    expect(result.imported_by[0].source).toBe('src/Consumer.php');
    expect(result.imported_by[0].target).toBe('src/Service.php');
  });

  it('returns empty arrays for a file with no import edges', () => {
    const store = createTestStore();
    insertFile(store, 'src/Isolated.php');

    const result = getDependencyGraph(store, 'src/Isolated.php');
    expect(result.file).toBe('src/Isolated.php');
    expect(result.imports).toEqual([]);
    expect(result.imported_by).toEqual([]);
  });

  it('returns empty envelope { file, imports: [], imported_by: [] } for unknown file path', () => {
    const store = createTestStore();
    insertFile(store, 'src/Real.php');

    const result = getDependencyGraph(store, 'src/DoesNotExist.php');
    expect(result.file).toBe('src/DoesNotExist.php');
    expect(result.imports).toEqual([]);
    expect(result.imported_by).toEqual([]);
  });

  it('each edge entry carries source, target, and specifiers fields', () => {
    const store = createTestStore();
    insertFile(store, 'src/A.php');
    insertFile(store, 'src/B.php');
    wireImport(store, 'src/A.php', 'src/B.php');

    const result = getDependencyGraph(store, 'src/A.php');
    expect(result.imports.length).toBe(1);
    const edge = result.imports[0];
    expect(typeof edge.source).toBe('string');
    expect(typeof edge.target).toBe('string');
    expect(Array.isArray(edge.specifiers)).toBe(true);
    expect(edge.source).toBe('src/A.php');
    expect(edge.target).toBe('src/B.php');
  });
});
