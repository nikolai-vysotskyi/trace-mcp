import type Database from 'better-sqlite3';

interface EdgeRecord {
  source_node_id: number;
  target_node_id: number;
}

/** Cached PageRank result keyed by DB filename + edge count */
let _cache: { dbName: string; edgeCount: number; result: Map<number, number> } | null = null;

/** Invalidate the cache (call after bulk edge inserts, e.g. reindex) */
export function invalidatePageRankCache(): void {
  _cache = null;
}

/**
 * Simple PageRank on the edges graph.
 * Results are cached and invalidated when the edge count changes.
 */
export function computePageRank(
  db: Database.Database,
  iterations = 20,
  dampingFactor = 0.85,
): Map<number, number> {
  // Fast cache check: if same DB and edge count hasn't changed, reuse
  const dbName = db.name;
  const countRow = db.prepare('SELECT COUNT(*) as cnt FROM edges WHERE resolved = 1').get() as {
    cnt: number;
  };
  if (_cache && _cache.dbName === dbName && _cache.edgeCount === countRow.cnt) {
    return _cache.result;
  }

  const edges = db
    .prepare('SELECT source_node_id, target_node_id FROM edges WHERE resolved = 1')
    .all() as EdgeRecord[];

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

    // Accumulate rank mass lost to sink nodes (no outgoing edges) and redistribute
    // evenly across all nodes to conserve total rank mass.
    let sinkMass = 0;

    for (const nodeId of nodes) {
      const targets = outgoing.get(nodeId);
      if (!targets || targets.length === 0) {
        sinkMass += (scores.get(nodeId) ?? 0) * dampingFactor;
        continue;
      }

      const share = ((scores.get(nodeId) ?? 0) * dampingFactor) / targets.length;
      for (const target of targets) {
        newScores.set(target, (newScores.get(target) ?? base) + share);
      }
    }

    // Distribute sink mass equally to all nodes
    if (sinkMass > 0) {
      const sinkShare = sinkMass / n;
      for (const nodeId of nodes) {
        newScores.set(nodeId, (newScores.get(nodeId) ?? base) + sinkShare);
      }
    }

    for (const nodeId of nodes) {
      scores.set(nodeId, newScores.get(nodeId) ?? base);
    }
  }

  _cache = { dbName, edgeCount: countRow.cnt, result: scores };
  return scores;
}
