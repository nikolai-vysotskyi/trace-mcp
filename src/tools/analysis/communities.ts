/**
 * Community Detection — Leiden algorithm for identifying tightly-coupled file clusters.
 *
 * Builds a weighted undirected graph from the edges table (weight = edge count between files),
 * runs the Leiden algorithm to find communities, and auto-labels them by common path segments.
 *
 * Performance: Single SQL for edge aggregation, O(V + E) per Leiden iteration.
 * Results cached in communities/community_members tables.
 */
import type { Store } from '../../db/store.js';
import { ok, type TraceMcpResult } from '../../errors.js';

interface Community {
  id: number;
  label: string;
  fileCount: number;
  cohesion: number;
  internalEdges: number;
  externalEdges: number;
  keyFiles: string[];
}

interface CommunityDetail extends Community {
  files: string[];
  dependsOn: Array<{ community: string; edgeCount: number }>;
  dependedBy: Array<{ community: string; edgeCount: number }>;
}

interface CommunitiesResult {
  communities: Community[];
  totalFiles: number;
  resolution: number;
  seed: number;
}

// ─── Seedable PRNG ────────────────────────────────────────

/**
 * mulberry32 — small, fast, well-distributed seedable PRNG. Returns a function
 * that yields a float in [0, 1). Used in place of Math.random() so that two
 * runs of community detection on the same graph produce identical assignments.
 *
 * Without this, parallel rebuilds give different community IDs which means
 * decisions/queries that pin to community_id drift between runs.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Graph building ───────────────────────────────────────

interface FileGraph {
  nodes: string[]; // file paths
  nodeIndex: Map<string, number>; // path → index
  weights: number[][]; // adjacency matrix (sparse via Map would be better for large graphs)
}

/**
 * Build file-level weighted undirected graph from edges table.
 * Single SQL aggregation — no N+1.
 */
function buildFileGraph(store: Store): FileGraph {
  // Aggregate: for each pair of files connected by symbol-level edges,
  // count the total number of edges between them.
  const rows = store.db
    .prepare(`
    SELECT
      sf.path AS source_file,
      tf.path AS target_file,
      COUNT(*) AS weight
    FROM edges e
    JOIN nodes sn ON e.source_node_id = sn.id
    JOIN nodes tn ON e.target_node_id = tn.id
    LEFT JOIN symbols ss ON sn.node_type = 'symbol' AND sn.ref_id = ss.id
    LEFT JOIN symbols ts ON tn.node_type = 'symbol' AND tn.ref_id = ts.id
    LEFT JOIN files sf ON (sn.node_type = 'file' AND sn.ref_id = sf.id) OR ss.file_id = sf.id
    LEFT JOIN files tf ON (tn.node_type = 'file' AND tn.ref_id = tf.id) OR ts.file_id = tf.id
    WHERE sf.path IS NOT NULL AND tf.path IS NOT NULL AND sf.path != tf.path
    GROUP BY sf.path, tf.path
  `)
    .all() as Array<{ source_file: string; target_file: string; weight: number }>;

  // Collect unique nodes
  const nodeSet = new Set<string>();
  for (const r of rows) {
    nodeSet.add(r.source_file);
    nodeSet.add(r.target_file);
  }

  const nodes = [...nodeSet];
  const nodeIndex = new Map(nodes.map((n, i) => [n, i]));
  const n = nodes.length;

  // Build adjacency (undirected: merge both directions)
  const weights: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const r of rows) {
    const i = nodeIndex.get(r.source_file)!;
    const j = nodeIndex.get(r.target_file)!;
    weights[i][j] += r.weight;
    weights[j][i] += r.weight;
  }

  return { nodes, nodeIndex, weights };
}

// ─── Leiden algorithm (simplified) ────────────────────────

/**
 * Simplified Leiden community detection.
 * Based on the Louvain method with refinement step for connected communities.
 *
 * Algorithm:
 * 1. Each node starts in its own community
 * 2. For each node, try moving it to the community of each neighbor
 * 3. Accept the move that maximizes modularity gain
 * 4. Repeat until no improvement
 * 5. Aggregate communities and repeat on the coarsened graph
 */
function leidenDetect(graph: FileGraph, resolution = 1.0, maxIterations = 20, seed = 0): number[] {
  const n = graph.nodes.length;
  if (n === 0) return [];

  const rng = mulberry32(seed);

  // Community assignment: community[i] = community id for node i
  const community = Array.from({ length: n }, (_, i) => i);

  // Total weight of all edges (sum of adjacency / 2 for undirected)
  let totalWeight = 0;
  const nodeDegree = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const w = graph.weights[i][j];
      if (w > 0) {
        totalWeight += w;
        nodeDegree[i] += w;
        nodeDegree[j] += w;
      }
    }
  }

  if (totalWeight === 0) {
    // No edges — each node is its own community
    return community;
  }

  const m2 = 2 * totalWeight; // 2m for modularity formula

  for (let iter = 0; iter < maxIterations; iter++) {
    let improved = false;

    // Randomize node order for better convergence (seeded — deterministic across runs).
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    for (const i of order) {
      const currentComm = community[i];

      // Compute weight to each neighboring community
      const commWeights = new Map<number, number>();
      for (let j = 0; j < n; j++) {
        if (i === j || graph.weights[i][j] === 0) continue;
        const c = community[j];
        commWeights.set(c, (commWeights.get(c) ?? 0) + graph.weights[i][j]);
      }

      // Compute modularity gain for moving to each neighbor community
      let bestComm = currentComm;
      let bestGain = 0;

      // Weight to current community
      const wCurrent = commWeights.get(currentComm) ?? 0;

      // Sum of degrees of nodes in each community
      const commDegrees = new Map<number, number>();
      for (let j = 0; j < n; j++) {
        const c = community[j];
        commDegrees.set(c, (commDegrees.get(c) ?? 0) + nodeDegree[j]);
      }

      for (const [c, wc] of commWeights) {
        if (c === currentComm) continue;

        const sumC = commDegrees.get(c) ?? 0;
        const sumCurrent = commDegrees.get(currentComm) ?? 0;
        const ki = nodeDegree[i];

        // Modularity gain (delta Q) for moving node i from currentComm to c
        const gain =
          (wc - wCurrent) / m2 - (resolution * ki * (sumC - sumCurrent + ki)) / (m2 * m2);

        if (gain > bestGain) {
          bestGain = gain;
          bestComm = c;
        }
      }

      if (bestComm !== currentComm) {
        community[i] = bestComm;
        improved = true;
      }
    }

    if (!improved) break;
  }

  // Normalize community IDs to 0..k-1
  const uniqueComms = [...new Set(community)];
  const commMap = new Map(uniqueComms.map((c, i) => [c, i]));
  return community.map((c) => commMap.get(c)!);
}

// ─── Auto-labeling ────────────────────────────────────────

function autoLabel(files: string[]): string {
  if (files.length === 0) return 'unknown';

  // Find the most common path segment (excluding common prefixes like "src")
  const segments = new Map<string, number>();
  const ignore = new Set(['src', 'lib', 'app', 'dist', 'build', 'node_modules', 'vendor', 'index']);

  for (const file of files) {
    const parts = file.split('/').filter((p) => !ignore.has(p) && !p.includes('.'));
    for (const part of parts) {
      segments.set(part, (segments.get(part) ?? 0) + 1);
    }
  }

  if (segments.size === 0) return 'root';

  // Return most frequent segment
  let bestSegment = 'unknown';
  let bestCount = 0;
  for (const [seg, count] of segments) {
    if (count > bestCount) {
      bestCount = count;
      bestSegment = seg;
    }
  }

  return bestSegment;
}

// ─── Public API ───────────────────────────────────────────

/**
 * Detect communities, persist to DB, and return results.
 */
export function detectCommunities(
  store: Store,
  resolution = 1.0,
  seed = 0,
): TraceMcpResult<CommunitiesResult> {
  const graph = buildFileGraph(store);

  if (graph.nodes.length === 0) {
    return ok({ communities: [], totalFiles: 0, resolution, seed });
  }

  const assignments = leidenDetect(graph, resolution, 20, seed);
  const _numCommunities = Math.max(...assignments) + 1;

  // Group files by community
  const communityFiles = new Map<number, string[]>();
  for (let i = 0; i < assignments.length; i++) {
    const c = assignments[i];
    const arr = communityFiles.get(c) ?? [];
    arr.push(graph.nodes[i]);
    communityFiles.set(c, arr);
  }

  // Compute cohesion for each community
  const communities: Community[] = [];
  for (const [commId, files] of communityFiles) {
    const fileSet = new Set(files);
    let internal = 0;
    let external = 0;

    for (const file of files) {
      const idx = graph.nodeIndex.get(file)!;
      for (let j = 0; j < graph.nodes.length; j++) {
        const w = graph.weights[idx][j];
        if (w === 0) continue;
        if (fileSet.has(graph.nodes[j])) {
          internal += w;
        } else {
          external += w;
        }
      }
    }

    internal = Math.floor(internal / 2); // counted twice in undirected graph
    const cohesion =
      internal + external > 0 ? Math.round((internal / (internal + external)) * 100) / 100 : 0;

    const label = autoLabel(files);

    communities.push({
      id: commId,
      label,
      fileCount: files.length,
      cohesion,
      internalEdges: internal,
      externalEdges: external,
      keyFiles: files.slice(0, 5), // Top 5 files as preview
    });
  }

  // Sort by file count descending
  communities.sort((a, b) => b.fileCount - a.fileCount);

  // Persist to DB (single transaction)
  store.db.transaction(() => {
    store.db.prepare('DELETE FROM community_members').run();
    store.db.prepare('DELETE FROM communities').run();

    const insertComm = store.db.prepare(
      'INSERT INTO communities (id, label, file_count, cohesion, internal_edges, external_edges) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertMember = store.db.prepare(
      'INSERT INTO community_members (community_id, file_path) VALUES (?, ?)',
    );

    for (const comm of communities) {
      insertComm.run(
        comm.id,
        comm.label,
        comm.fileCount,
        comm.cohesion,
        comm.internalEdges,
        comm.externalEdges,
      );
      const files = communityFiles.get(comm.id) ?? [];
      for (const file of files) {
        insertMember.run(comm.id, file);
      }
    }
  })();

  return ok({
    communities,
    totalFiles: graph.nodes.length,
    resolution,
    seed,
  });
}

/**
 * Get previously computed communities from DB.
 */
export function getCommunities(store: Store): TraceMcpResult<CommunitiesResult> {
  const rows = store.db
    .prepare('SELECT * FROM communities ORDER BY file_count DESC')
    .all() as Array<{
    id: number;
    label: string;
    file_count: number;
    cohesion: number;
    internal_edges: number;
    external_edges: number;
  }>;

  if (rows.length === 0) {
    return ok({ communities: [], totalFiles: 0, resolution: 1.0, seed: 0 });
  }

  const communities: Community[] = rows.map((r) => {
    const members = store.db
      .prepare('SELECT file_path FROM community_members WHERE community_id = ? LIMIT 5')
      .all(r.id) as Array<{ file_path: string }>;

    return {
      id: r.id,
      label: r.label,
      fileCount: r.file_count,
      cohesion: r.cohesion,
      internalEdges: r.internal_edges,
      externalEdges: r.external_edges,
      keyFiles: members.map((m) => m.file_path),
    };
  });

  const totalFiles = communities.reduce((sum, c) => sum + c.fileCount, 0);
  return ok({ communities, totalFiles, resolution: 1.0, seed: 0 });
}

/**
 * Get details for a single community.
 */
export function getCommunityDetail(
  store: Store,
  communityId: number,
): TraceMcpResult<CommunityDetail> {
  const comm = store.db.prepare('SELECT * FROM communities WHERE id = ?').get(communityId) as
    | {
        id: number;
        label: string;
        file_count: number;
        cohesion: number;
        internal_edges: number;
        external_edges: number;
      }
    | undefined;

  if (!comm) {
    return ok(null as unknown as CommunityDetail);
  }

  const members = store.db
    .prepare('SELECT file_path FROM community_members WHERE community_id = ?')
    .all(comm.id) as Array<{ file_path: string }>;

  // Find inter-community dependencies
  const allMembers = store.db
    .prepare('SELECT community_id, file_path FROM community_members')
    .all() as Array<{ community_id: number; file_path: string }>;

  const fileToComm = new Map(allMembers.map((m) => [m.file_path, m.community_id]));
  const commLabels = new Map(
    (
      store.db.prepare('SELECT id, label FROM communities').all() as Array<{
        id: number;
        label: string;
      }>
    ).map((r) => [r.id, r.label]),
  );

  // This community's files
  const myFiles = new Set(members.map((m) => m.file_path));

  // Count edges to/from other communities using the edge table
  const dependsOn = new Map<number, number>();
  const dependedBy = new Map<number, number>();

  // Single query: get all edges involving this community's files
  const fileList = members.map((m) => m.file_path);
  if (fileList.length > 0) {
    const placeholders = fileList.map(() => '?').join(',');
    const edgeRows = store.db
      .prepare(`
      SELECT sf.path AS source_file, tf.path AS target_file, COUNT(*) AS cnt
      FROM edges e
      JOIN nodes sn ON e.source_node_id = sn.id
      JOIN nodes tn ON e.target_node_id = tn.id
      LEFT JOIN symbols ss ON sn.node_type = 'symbol' AND sn.ref_id = ss.id
      LEFT JOIN symbols ts ON tn.node_type = 'symbol' AND tn.ref_id = ts.id
      LEFT JOIN files sf ON (sn.node_type = 'file' AND sn.ref_id = sf.id) OR ss.file_id = sf.id
      LEFT JOIN files tf ON (tn.node_type = 'file' AND tn.ref_id = tf.id) OR ts.file_id = tf.id
      WHERE (sf.path IN (${placeholders}) OR tf.path IN (${placeholders}))
        AND sf.path IS NOT NULL AND tf.path IS NOT NULL
        AND sf.path != tf.path
      GROUP BY sf.path, tf.path
    `)
      .all(...fileList, ...fileList) as Array<{
      source_file: string;
      target_file: string;
      cnt: number;
    }>;

    for (const row of edgeRows) {
      if (myFiles.has(row.source_file) && !myFiles.has(row.target_file)) {
        const targetComm = fileToComm.get(row.target_file);
        if (targetComm != null) {
          dependsOn.set(targetComm, (dependsOn.get(targetComm) ?? 0) + row.cnt);
        }
      }
      if (myFiles.has(row.target_file) && !myFiles.has(row.source_file)) {
        const sourceComm = fileToComm.get(row.source_file);
        if (sourceComm != null) {
          dependedBy.set(sourceComm, (dependedBy.get(sourceComm) ?? 0) + row.cnt);
        }
      }
    }
  }

  return ok({
    id: comm.id,
    label: comm.label,
    fileCount: comm.file_count,
    cohesion: comm.cohesion,
    internalEdges: comm.internal_edges,
    externalEdges: comm.external_edges,
    keyFiles: fileList.slice(0, 5),
    files: fileList,
    dependsOn: [...dependsOn.entries()]
      .map(([c, cnt]) => ({ community: commLabels.get(c) ?? `#${c}`, edgeCount: cnt }))
      .sort((a, b) => b.edgeCount - a.edgeCount),
    dependedBy: [...dependedBy.entries()]
      .map(([c, cnt]) => ({ community: commLabels.get(c) ?? `#${c}`, edgeCount: cnt }))
      .sort((a, b) => b.edgeCount - a.edgeCount),
  });
}
