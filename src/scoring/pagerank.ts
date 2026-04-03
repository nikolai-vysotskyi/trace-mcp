import type Database from 'better-sqlite3';

interface EdgeRecord {
  source_node_id: number;
  target_node_id: number;
}

/**
 * Simple PageRank on the edges graph.
 * Returns a map of nodeId -> score.
 */
export function computePageRank(
  db: Database.Database,
  iterations = 20,
  dampingFactor = 0.85,
): Map<number, number> {
  const edges = db.prepare(
    'SELECT source_node_id, target_node_id FROM edges WHERE resolved = 1',
  ).all() as EdgeRecord[];

  // Collect all unique node IDs
  const nodeSet = new Set<number>();
  const outgoing = new Map<number, number[]>();

  for (const edge of edges) {
    nodeSet.add(edge.source_node_id);
    nodeSet.add(edge.target_node_id);

    let targets = outgoing.get(edge.source_node_id);
    if (!targets) {
      targets = [];
      outgoing.set(edge.source_node_id, targets);
    }
    targets.push(edge.target_node_id);
  }

  const nodes = Array.from(nodeSet);
  const n = nodes.length;
  if (n === 0) return new Map();

  // Initialize scores
  const scores = new Map<number, number>();
  const initialScore = 1 / n;
  for (const nodeId of nodes) {
    scores.set(nodeId, initialScore);
  }

  // Iterate
  const base = (1 - dampingFactor) / n;

  for (let iter = 0; iter < iterations; iter++) {
    const newScores = new Map<number, number>();
    for (const nodeId of nodes) {
      newScores.set(nodeId, base);
    }

    for (const nodeId of nodes) {
      const targets = outgoing.get(nodeId);
      if (!targets || targets.length === 0) continue;

      const share = (scores.get(nodeId) ?? 0) * dampingFactor / targets.length;
      for (const target of targets) {
        newScores.set(target, (newScores.get(target) ?? base) + share);
      }
    }

    for (const nodeId of nodes) {
      scores.set(nodeId, newScores.get(nodeId) ?? base);
    }
  }

  return scores;
}
