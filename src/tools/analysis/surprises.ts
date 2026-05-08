/**
 * Surprising connections — file-level edges that link two different
 * communities and look unexpected by structural signals. graphify ships a
 * top-level "surprises" highlight in GRAPH_REPORT.md and an MCP resource of
 * the same name. The intent is to surface the cross-cutting hidden coupling
 * that ordinary impact analysis misses.
 *
 * Score (higher = more surprising):
 *   surprise = (path_distance + 1) * (popularity_bonus) / (1 + edge_count)
 *
 * - `path_distance`: depth at which the two communities first share a member
 *   in their respective folder paths (e.g. src/auth/x.ts and src/payments/y.ts
 *   diverge at depth 1). Bigger = more surprising.
 * - `popularity_bonus`: log(in_degree(target) + 2). High-PageRank targets
 *   pulled in from somewhere unexpected are more interesting than touches on
 *   leaf utilities.
 * - `edge_count`: how many edges actually exist between this pair of files.
 *   A pair that exchange dozens of edges is "expected coupling"; a single
 *   edge across community lines is the surprise.
 *
 * Requires that detect_communities has been run, otherwise returns empty.
 */
import type { Store } from '../../db/store.js';
import { ok, type TraceMcpResult } from '../../errors.js';

export interface SurpriseEdge {
  sourceFile: string;
  sourceCommunity: string;
  targetFile: string;
  targetCommunity: string;
  edgeCount: number;
  pathDistance: number;
  inDegreeTarget: number;
  surpriseScore: number;
}

export interface SurprisesResult {
  edges: SurpriseEdge[];
  totalCommunities: number;
  inspectedEdgePairs: number;
  unavailable?: string;
}

/** Folder-path distance — how many leading path segments do two files share? */
function pathDivergence(a: string, b: string): number {
  const aParts = a.split('/');
  const bParts = b.split('/');
  let common = 0;
  const max = Math.min(aParts.length, bParts.length) - 1; // ignore basename
  for (let i = 0; i < max; i++) {
    if (aParts[i] === bParts[i]) common++;
    else break;
  }
  // Distance grows as the shared prefix shrinks.
  const total = Math.max(aParts.length, bParts.length) - 1;
  return Math.max(0, total - common);
}

export function getSurprises(
  store: Store,
  opts: { topN?: number } = {},
): TraceMcpResult<SurprisesResult> {
  const topN = opts.topN ?? 20;

  const communityRows = store.db.prepare('SELECT id, label FROM communities').all() as Array<{
    id: number;
    label: string;
  }>;
  if (communityRows.length === 0) {
    return ok({
      edges: [],
      totalCommunities: 0,
      inspectedEdgePairs: 0,
      unavailable:
        'detect_communities has not been run. Run it first to populate the community index.',
    });
  }

  const communityLabel = new Map<number, string>(communityRows.map((r) => [r.id, r.label]));

  const memberRows = store.db
    .prepare('SELECT community_id, file_path FROM community_members')
    .all() as Array<{ community_id: number; file_path: string }>;
  const fileToCommunity = new Map<string, number>(
    memberRows.map((r) => [r.file_path, r.community_id]),
  );

  // Aggregate file→file edge counts (same SQL shape as buildFileGraph but
  // we keep direction so popularity = incoming edges to the target).
  const edgeRows = store.db
    .prepare(`
    SELECT
      sf.path AS source_file,
      tf.path AS target_file,
      COUNT(*) AS edge_count
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
    .all() as Array<{ source_file: string; target_file: string; edge_count: number }>;

  // Compute in-degree per target file for the popularity bonus.
  const inDegree = new Map<string, number>();
  for (const r of edgeRows) {
    inDegree.set(r.target_file, (inDegree.get(r.target_file) ?? 0) + r.edge_count);
  }

  const surprises: SurpriseEdge[] = [];
  for (const r of edgeRows) {
    const srcComm = fileToCommunity.get(r.source_file);
    const tgtComm = fileToCommunity.get(r.target_file);
    if (srcComm === undefined || tgtComm === undefined) continue;
    if (srcComm === tgtComm) continue; // same community — not a surprise

    const distance = pathDivergence(r.source_file, r.target_file);
    if (distance === 0) continue; // same folder, just unindexed by community

    const popularity = Math.log((inDegree.get(r.target_file) ?? 0) + 2);
    const surprise = ((distance + 1) * popularity) / (1 + r.edge_count);

    surprises.push({
      sourceFile: r.source_file,
      sourceCommunity: communityLabel.get(srcComm) ?? `#${srcComm}`,
      targetFile: r.target_file,
      targetCommunity: communityLabel.get(tgtComm) ?? `#${tgtComm}`,
      edgeCount: r.edge_count,
      pathDistance: distance,
      inDegreeTarget: inDegree.get(r.target_file) ?? 0,
      surpriseScore: Math.round(surprise * 1000) / 1000,
    });
  }

  surprises.sort((a, b) => b.surpriseScore - a.surpriseScore);

  return ok({
    edges: surprises.slice(0, topN),
    totalCommunities: communityRows.length,
    inspectedEdgePairs: surprises.length,
  });
}
