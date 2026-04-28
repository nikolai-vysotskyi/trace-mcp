/**
 * Edge bottleneck detection — finds architectural chokepoints in the import graph.
 *
 * Combines three signals:
 * - Edge betweenness (Brandes' algorithm, directed) — how many shortest paths cross the edge
 * - Bridges (Tarjan, undirected) — edges whose removal disconnects the graph
 * - Co-change weight — git-history signal of how often endpoints change together
 *
 * bottleneckScore = normalizedBetweenness × (1 + normalizedCoChange)
 *
 * For large graphs (>500 nodes), sampling is used: √V random source nodes instead of all V.
 * Results scale up by V/k factor. Full computation is O(V·E), sampled is O(√V · E).
 */

import type { Store } from '../../db/store.js';
import { ok, type TraceMcpResult } from '../../errors.js';
import { buildFileGraph } from './graph-analysis.js';

export interface EdgeBottleneck {
  sourceFile: string;
  targetFile: string;
  betweenness: number;
  coChangeWeight: number;
  bottleneckScore: number;
  isBridge: boolean;
}

export interface ArticulationPoint {
  file: string;
  fileId: number;
}

export interface BottlenecksResult {
  edges: EdgeBottleneck[];
  articulationPoints: ArticulationPoint[];
  stats: {
    nodes: number;
    edges: number;
    sampled: boolean;
    sampleSize: number;
  };
}

export interface GetEdgeBottlenecksOptions {
  topN?: number;
  minScore?: number;
  sampling?: 'auto' | 'full';
}

type FileGraph = ReturnType<typeof buildFileGraph>;

const SAMPLING_THRESHOLD = 500;
const MIN_SAMPLE_SIZE = 32;

export function getEdgeBottlenecks(
  store: Store,
  opts: GetEdgeBottlenecksOptions = {},
): TraceMcpResult<BottlenecksResult> {
  const { topN = 50, minScore = 0, sampling = 'auto' } = opts;
  const graph = buildFileGraph(store);
  const N = graph.allFileIds.size;

  let totalEdges = 0;
  for (const targets of graph.forward.values()) totalEdges += targets.size;

  if (N === 0 || totalEdges === 0) {
    return ok({
      edges: [],
      articulationPoints: [],
      stats: { nodes: N, edges: totalEdges, sampled: false, sampleSize: 0 },
    });
  }

  const shouldSample = sampling === 'auto' && N > SAMPLING_THRESHOLD;
  const sampleSize = shouldSample ? Math.max(MIN_SAMPLE_SIZE, Math.ceil(Math.sqrt(N))) : N;
  const betweenness = computeEdgeBetweenness(graph, shouldSample ? sampleSize : null);

  const undirected = toUndirectedAdj(graph);
  const { bridges, articulations } = tarjanBridgesAndArticulations(undirected, graph.allFileIds);

  const coChangeWeights = fetchCoChangeWeights(store, graph);

  const edges = scoreAndRankEdges(graph, betweenness, coChangeWeights, bridges, topN, minScore);

  const articulationPoints: ArticulationPoint[] = [...articulations]
    .map((fileId) => ({ file: graph.pathMap.get(fileId) ?? `[file:${fileId}]`, fileId }))
    .sort((a, b) => a.file.localeCompare(b.file));

  return ok({
    edges,
    articulationPoints,
    stats: {
      nodes: N,
      edges: totalEdges,
      sampled: shouldSample,
      sampleSize,
    },
  });
}

// ════════════════════════════════════════════════════════════════════════
// EDGE BETWEENNESS — Brandes' algorithm (directed)
// ════════════════════════════════════════════════════════════════════════

function edgeKey(src: number, dst: number): string {
  return `${src}>${dst}`;
}

function computeEdgeBetweenness(graph: FileGraph, sampleSize: number | null): Map<string, number> {
  const nodes = [...graph.allFileIds];
  const N = nodes.length;
  const betweenness = new Map<string, number>();

  let sources: number[];
  let scaleFactor: number;
  if (sampleSize !== null && sampleSize < N) {
    sources = pickRandomSources(nodes, sampleSize);
    scaleFactor = N / sampleSize;
  } else {
    sources = nodes;
    scaleFactor = 1;
  }

  for (const s of sources) {
    accumulateBrandes(s, graph, betweenness);
  }

  if (scaleFactor !== 1) {
    for (const [k, v] of betweenness) betweenness.set(k, v * scaleFactor);
  }

  return betweenness;
}

function pickRandomSources(nodes: number[], k: number): number[] {
  const arr = [...nodes];
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, k);
}

function accumulateBrandes(
  source: number,
  graph: FileGraph,
  betweenness: Map<string, number>,
): void {
  const stack: number[] = [];
  const predecessors = new Map<number, number[]>();
  const sigma = new Map<number, number>();
  const distance = new Map<number, number>();

  sigma.set(source, 1);
  distance.set(source, 0);

  const queue: number[] = [source];
  let head = 0;
  while (head < queue.length) {
    const v = queue[head++];
    stack.push(v);
    const neighbors = graph.forward.get(v);
    if (!neighbors) continue;
    const dv = distance.get(v)!;
    const sigmaV = sigma.get(v)!;
    for (const w of neighbors) {
      const dw = distance.get(w);
      if (dw === undefined) {
        distance.set(w, dv + 1);
        queue.push(w);
      }
      if (distance.get(w) === dv + 1) {
        sigma.set(w, (sigma.get(w) ?? 0) + sigmaV);
        const preds = predecessors.get(w);
        if (preds) preds.push(v);
        else predecessors.set(w, [v]);
      }
    }
  }

  const delta = new Map<number, number>();
  while (stack.length > 0) {
    const w = stack.pop()!;
    const preds = predecessors.get(w);
    if (!preds) continue;
    const sw = sigma.get(w)!;
    const dw = delta.get(w) ?? 0;
    for (const v of preds) {
      const c = (sigma.get(v)! / sw) * (1 + dw);
      delta.set(v, (delta.get(v) ?? 0) + c);
      const k = edgeKey(v, w);
      betweenness.set(k, (betweenness.get(k) ?? 0) + c);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// BRIDGES + ARTICULATION POINTS — Tarjan (undirected)
// ════════════════════════════════════════════════════════════════════════

function toUndirectedAdj(graph: FileGraph): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>();
  const add = (a: number, b: number): void => {
    let set = adj.get(a);
    if (!set) {
      set = new Set();
      adj.set(a, set);
    }
    set.add(b);
  };
  for (const [src, targets] of graph.forward) {
    for (const tgt of targets) {
      add(src, tgt);
      add(tgt, src);
    }
  }
  for (const id of graph.allFileIds) {
    if (!adj.has(id)) adj.set(id, new Set());
  }
  return adj;
}

interface TarjanFrame {
  v: number;
  parent: number;
  neighbors: number[];
  iter: number;
  childCount: number;
}

function tarjanBridgesAndArticulations(
  adj: Map<number, Set<number>>,
  allFileIds: Set<number>,
): { bridges: Set<string>; articulations: Set<number> } {
  const disc = new Map<number, number>();
  const low = new Map<number, number>();
  const bridges = new Set<string>();
  const articulations = new Set<number>();
  let time = 0;

  const enterNode = (v: number, parent: number, stack: TarjanFrame[]): void => {
    disc.set(v, time);
    low.set(v, time);
    time++;
    stack.push({ v, parent, neighbors: [...(adj.get(v) ?? [])], iter: 0, childCount: 0 });
  };

  for (const root of allFileIds) {
    if (disc.has(root)) continue;
    const stack: TarjanFrame[] = [];
    enterNode(root, -1, stack);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.iter < top.neighbors.length) {
        const w = top.neighbors[top.iter++];
        if (!disc.has(w)) {
          top.childCount++;
          enterNode(w, top.v, stack);
        } else if (w !== top.parent) {
          low.set(top.v, Math.min(low.get(top.v)!, disc.get(w)!));
        }
      } else {
        stack.pop();
        if (stack.length === 0) {
          if (top.childCount >= 2) articulations.add(top.v);
        } else {
          const parentFrame = stack[stack.length - 1];
          const childLow = low.get(top.v)!;
          low.set(parentFrame.v, Math.min(low.get(parentFrame.v)!, childLow));
          if (childLow > disc.get(parentFrame.v)!) {
            bridges.add(edgeKey(parentFrame.v, top.v));
            bridges.add(edgeKey(top.v, parentFrame.v));
          }
          if (parentFrame.parent !== -1 && childLow >= disc.get(parentFrame.v)!) {
            articulations.add(parentFrame.v);
          }
        }
      }
    }
  }

  return { bridges, articulations };
}

// ════════════════════════════════════════════════════════════════════════
// CO-CHANGE WEIGHTS
// ════════════════════════════════════════════════════════════════════════

function fetchCoChangeWeights(store: Store, graph: FileGraph): Map<string, number> {
  const weights = new Map<string, number>();

  const tableExists = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='co_changes'")
    .get();
  if (!tableExists) return weights;

  const pathToId = new Map<string, number>();
  for (const [id, path] of graph.pathMap) pathToId.set(path, id);

  interface Row {
    file_a: string;
    file_b: string;
    confidence: number;
  }
  const rows = store.db
    .prepare('SELECT file_a, file_b, confidence FROM co_changes WHERE confidence > 0')
    .all() as Row[];

  for (const row of rows) {
    const aId = pathToId.get(row.file_a);
    const bId = pathToId.get(row.file_b);
    if (aId === undefined || bId === undefined) continue;
    if (graph.forward.get(aId)?.has(bId)) weights.set(edgeKey(aId, bId), row.confidence);
    if (graph.forward.get(bId)?.has(aId)) weights.set(edgeKey(bId, aId), row.confidence);
  }

  return weights;
}

// ════════════════════════════════════════════════════════════════════════
// SCORING
// ════════════════════════════════════════════════════════════════════════

interface RawEdge {
  src: number;
  dst: number;
  bc: number;
  cc: number;
  bridge: boolean;
}

function scoreAndRankEdges(
  graph: FileGraph,
  betweenness: Map<string, number>,
  coChangeWeights: Map<string, number>,
  bridges: Set<string>,
  topN: number,
  minScore: number,
): EdgeBottleneck[] {
  const rawEdges: RawEdge[] = [];
  for (const [src, targets] of graph.forward) {
    for (const dst of targets) {
      const k = edgeKey(src, dst);
      rawEdges.push({
        src,
        dst,
        bc: betweenness.get(k) ?? 0,
        cc: coChangeWeights.get(k) ?? 0,
        bridge: bridges.has(k),
      });
    }
  }
  if (rawEdges.length === 0) return [];

  let bcMax = 0;
  let ccMax = 0;
  for (const e of rawEdges) {
    if (e.bc > bcMax) bcMax = e.bc;
    if (e.cc > ccMax) ccMax = e.cc;
  }

  const result: EdgeBottleneck[] = [];
  for (const e of rawEdges) {
    const bcNorm = bcMax > 0 ? e.bc / bcMax : 0;
    const ccNorm = ccMax > 0 ? e.cc / ccMax : 0;
    const score = bcNorm * (1 + ccNorm);
    if (score < minScore) continue;
    result.push({
      sourceFile: graph.pathMap.get(e.src) ?? `[file:${e.src}]`,
      targetFile: graph.pathMap.get(e.dst) ?? `[file:${e.dst}]`,
      betweenness: round3(bcNorm),
      coChangeWeight: round3(ccNorm),
      bottleneckScore: round3(score),
      isBridge: e.bridge,
    });
  }

  result.sort((a, b) => b.bottleneckScore - a.bottleneckScore);
  return topN > 0 ? result.slice(0, topN) : result;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// ════════════════════════════════════════════════════════════════════════
// VIZ-GRAPH VARIANT — works on in-memory string-keyed graphs (any granularity)
// ════════════════════════════════════════════════════════════════════════

/**
 * Bottleneck computation for an arbitrary string-keyed directed graph — e.g.
 * the visualizer's VizNode/VizEdge pairs at either file OR symbol granularity.
 *
 * The file-level `getEdgeBottlenecks` path is still the MCP API surface; this
 * entrypoint exists so visualize.ts can enrich its own in-memory graph without
 * a second DB pass and without being limited to file granularity.
 *
 * Reuses the existing Brandes + Tarjan primitives by mapping string IDs to
 * local numeric handles, then translating results back. Returned keys use
 * `${source}|${target}` (the same format VizEdge lookups use downstream).
 */
export function computeBottlenecksForVizGraph(
  nodes: Array<{ id: string }>,
  edges: Array<{ source: string; target: string }>,
  opts: { sampling?: 'auto' | 'full'; coChangeByEdge?: Map<string, number> } = {},
): {
  edgeScores: Map<string, number>;
  bridges: Set<string>;
  articulations: Set<string>;
} {
  const { sampling = 'auto', coChangeByEdge } = opts;

  const strToNum = new Map<string, number>();
  const numToStr = new Map<number, string>();
  let nextId = 0;
  for (const n of nodes) {
    if (!strToNum.has(n.id)) {
      strToNum.set(n.id, nextId);
      numToStr.set(nextId, n.id);
      nextId++;
    }
  }

  const forward = new Map<number, Set<number>>();
  const reverse = new Map<number, Set<number>>();
  const allIds = new Set<number>([...strToNum.values()]);
  for (const e of edges) {
    const sn = strToNum.get(e.source);
    const tn = strToNum.get(e.target);
    if (sn == null || tn == null || sn === tn) continue;
    let f = forward.get(sn);
    if (!f) {
      f = new Set();
      forward.set(sn, f);
    }
    f.add(tn);
    let r = reverse.get(tn);
    if (!r) {
      r = new Set();
      reverse.set(tn, r);
    }
    r.add(sn);
  }

  if (allIds.size === 0 || forward.size === 0) {
    return { edgeScores: new Map(), bridges: new Set(), articulations: new Set() };
  }

  const synthetic: FileGraph = {
    forward,
    reverse,
    pathMap: new Map(),
    allFileIds: allIds,
  };

  const N = allIds.size;
  const shouldSample = sampling === 'auto' && N > SAMPLING_THRESHOLD;
  const sampleSize = shouldSample ? Math.max(MIN_SAMPLE_SIZE, Math.ceil(Math.sqrt(N))) : N;

  const betweenness = computeEdgeBetweenness(synthetic, shouldSample ? sampleSize : null);
  const undirected = toUndirectedAdj(synthetic);
  const { bridges: brNumKeys, articulations: artNums } = tarjanBridgesAndArticulations(
    undirected,
    allIds,
  );

  // Translate caller's string-keyed co-change map (key = "src|tgt") into the
  // numeric edgeKey format used by Brandes output.
  const coChangeNum = new Map<string, number>();
  if (coChangeByEdge && coChangeByEdge.size > 0) {
    for (const [k, w] of coChangeByEdge) {
      const sep = k.indexOf('|');
      if (sep < 0) continue;
      const srcStr = k.slice(0, sep);
      const tgtStr = k.slice(sep + 1);
      const sn = strToNum.get(srcStr);
      const tn = strToNum.get(tgtStr);
      if (sn != null && tn != null) coChangeNum.set(`${sn}>${tn}`, w);
    }
  }

  let bcMax = 0;
  for (const v of betweenness.values()) if (v > bcMax) bcMax = v;
  let ccMax = 0;
  for (const v of coChangeNum.values()) if (v > ccMax) ccMax = v;

  // Raw scores first, then normalize to [0..1] so the frontend gradient
  // palette lights up consistently across datasets of different sizes.
  const raw = new Map<string, number>();
  let scoreMax = 0;
  for (const [numKey, bc] of betweenness) {
    const bcNorm = bcMax > 0 ? bc / bcMax : 0;
    const cc = coChangeNum.get(numKey) ?? 0;
    const ccNorm = ccMax > 0 ? cc / ccMax : 0;
    const score = bcNorm * (1 + ccNorm);
    if (score > 0) {
      raw.set(numKey, score);
      if (score > scoreMax) scoreMax = score;
    }
  }

  const edgeScores = new Map<string, number>();
  if (scoreMax > 0) {
    for (const [numKey, score] of raw) {
      const gt = numKey.indexOf('>');
      if (gt < 0) continue;
      const srcNum = Number(numKey.slice(0, gt));
      const tgtNum = Number(numKey.slice(gt + 1));
      const srcStr = numToStr.get(srcNum);
      const tgtStr = numToStr.get(tgtNum);
      if (srcStr != null && tgtStr != null) {
        edgeScores.set(`${srcStr}|${tgtStr}`, round3(score / scoreMax));
      }
    }
  }

  // Tarjan stores both directions of each bridge (`a>b` AND `b>a`). Keep
  // only the direction that actually exists in the forward graph — matches
  // the direction VizEdge stores on the frontend.
  const bridges = new Set<string>();
  for (const numKey of brNumKeys) {
    const gt = numKey.indexOf('>');
    if (gt < 0) continue;
    const srcNum = Number(numKey.slice(0, gt));
    const tgtNum = Number(numKey.slice(gt + 1));
    if (!forward.get(srcNum)?.has(tgtNum)) continue;
    const srcStr = numToStr.get(srcNum);
    const tgtStr = numToStr.get(tgtNum);
    if (srcStr != null && tgtStr != null) bridges.add(`${srcStr}|${tgtStr}`);
  }

  const articulations = new Set<string>();
  for (const num of artNums) {
    const s = numToStr.get(num);
    if (s != null) articulations.add(s);
  }

  return { edgeScores, bridges, articulations };
}
