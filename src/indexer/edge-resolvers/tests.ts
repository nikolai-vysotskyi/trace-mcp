/** Pass 2e: Create test_covers edges from test files to their source files. */

import { logger } from '../../logger.js';
import type { PipelineState } from '../pipeline-state.js';

// JS/TS: *.test.ts, *.spec.ts, __tests__/
// Python: test_*.py, *_test.py, conftest.py, tests/test_*.py
const TEST_PATH_RE =
  /\.(test|spec)\.[jt]sx?$|__tests__\/|(?:^|[/\\])test_[^/\\]+\.py$|(?:^|[/\\])[^/\\]+_test\.py$|conftest\.py$/;

export function resolveTestCoversEdges(state: PipelineState): void {
  const { store } = state;
  let allFiles: import('../../db/types.js').FileRow[];
  if (state.isIncremental && state.changedFileIds.size > 0) {
    allFiles = [...store.getFilesByIds(Array.from(state.changedFileIds)).values()];
  } else {
    allFiles = store.getAllFiles();
  }
  const testFiles = allFiles.filter((f) => TEST_PATH_RE.test(f.path));
  if (testFiles.length === 0) return;

  const testFileIds = testFiles.map((f) => f.id);
  const fileNodeMap = state.isIncremental
    ? store.getNodeIdsBatch('file', testFileIds)
    : store.getNodeIdsBatch(
        'file',
        allFiles.map((f) => f.id),
      );

  const testNodeIds: number[] = [];
  const testNodeToFile = new Map<number, (typeof testFiles)[0]>();
  for (const tf of testFiles) {
    const nodeId = fileNodeMap.get(tf.id);
    if (nodeId != null) {
      testNodeIds.push(nodeId);
      testNodeToFile.set(nodeId, tf);
    }
  }
  if (testNodeIds.length === 0) return;

  const allEdges = store.getEdgesForNodesBatch(testNodeIds);

  const targetNodeIds = [...new Set(allEdges.map((e) => e.target_node_id))];
  const targetRefs = store.getNodeRefsBatch(targetNodeIds);

  const targetFileRefIds = [...targetRefs.values()]
    .filter((r) => r.nodeType === 'file')
    .map((r) => r.refId);
  const targetFileMap = store.getFilesByIds(targetFileRefIds);

  // Also resolve symbol targets to get their parent files
  const targetSymbolRefIds = [...targetRefs.values()]
    .filter((r) => r.nodeType === 'symbol')
    .map((r) => r.refId);
  const targetSymbolMap = store.getSymbolsByIds(targetSymbolRefIds);
  // Map symbol's file_id → FileRow for filtering out test files
  const symbolFileIds = [...new Set([...targetSymbolMap.values()].map((s) => s.file_id))];
  const symbolFileMap = store.getFilesByIds(symbolFileIds);

  const testCoversType = store.db
    .prepare('SELECT id FROM edge_types WHERE name = ?')
    .get('test_covers') as { id: number } | undefined;
  if (!testCoversType) return;

  let created = 0;
  const insertStmt = store.db.prepare(
    `INSERT INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
     VALUES (?, ?, ?, 1, ?, 0)
     ON CONFLICT(source_node_id, target_node_id, edge_type_id)
     DO UPDATE SET metadata = excluded.metadata`,
  );

  store.db.transaction(() => {
    for (const edge of allEdges) {
      if (edge.edge_type_name !== 'imports') continue;
      if (!testNodeToFile.has(edge.source_node_id)) continue;

      const targetRef = targetRefs.get(edge.target_node_id);
      if (!targetRef) continue;

      const testFile = testNodeToFile.get(edge.source_node_id)!;

      if (targetRef.nodeType === 'file') {
        const targetFile = targetFileMap.get(targetRef.refId);
        if (!targetFile) continue;
        if (TEST_PATH_RE.test(targetFile.path)) continue;

        insertStmt.run(
          edge.source_node_id,
          edge.target_node_id,
          testCoversType.id,
          JSON.stringify({ test_file: testFile.path }),
        );
        created++;
      } else if (targetRef.nodeType === 'symbol') {
        // Create test_covers edge to the imported symbol as well
        const targetSymbol = targetSymbolMap.get(targetRef.refId);
        if (!targetSymbol) continue;
        const parentFile = symbolFileMap.get(targetSymbol.file_id);
        if (!parentFile || TEST_PATH_RE.test(parentFile.path)) continue;

        insertStmt.run(
          edge.source_node_id,
          edge.target_node_id,
          testCoversType.id,
          JSON.stringify({ test_file: testFile.path, target_symbol: targetSymbol.symbol_id }),
        );
        created++;
      }
    }
  })();

  if (created > 0) {
    logger.info({ edges: created }, 'test_covers edges resolved');
  }
}
