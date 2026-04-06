/** Pass 2e: Create test_covers edges from test files to their source files. */
import type { PipelineState } from '../pipeline-state.js';
import { logger } from '../../logger.js';

const TEST_PATH_RE = /\.(test|spec)\.[jt]sx?$|__tests__\//;

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
    : store.getNodeIdsBatch('file', allFiles.map((f) => f.id));

  const testNodeIds: number[] = [];
  const testNodeToFile = new Map<number, typeof testFiles[0]>();
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

  const testCoversType = store.db.prepare('SELECT id FROM edge_types WHERE name = ?').get('test_covers') as { id: number } | undefined;
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
      if (!targetRef || targetRef.nodeType !== 'file') continue;

      const targetFile = targetFileMap.get(targetRef.refId);
      if (!targetFile) continue;
      if (TEST_PATH_RE.test(targetFile.path)) continue;

      const testFile = testNodeToFile.get(edge.source_node_id)!;
      insertStmt.run(
        edge.source_node_id,
        edge.target_node_id,
        testCoversType.id,
        JSON.stringify({ test_file: testFile.path }),
      );
      created++;
    }
  })();

  if (created > 0) {
    logger.info({ edges: created }, 'test_covers edges resolved');
  }
}
