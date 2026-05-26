/**
 * Graph-based analysis tools:
 * - Coupling metrics (Ca / Ce / Instability)
 * - Dependency cycle detection (Kosaraju's SCC)
 * - PageRank / file importance
 * - Extraction candidates (complex + widely-called)
 * - Hotspots placeholder (git integration for Phase 2)
 */

import type { Store } from '../../db/store.js';
import { getFilePinWeightExplicit, getSymbolPinWeightsByFile } from '../../scoring/pins.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface CouplingResult {
  file: string;
  file_id: number;
  /** Afferent coupling — files that import this file */
  ca: number;
  /** Efferent coupling — files this file imports */
  ce: number;
  /** Instability I = Ce / (Ca + Ce). 0 = stable, 1 = unstable */
  instability: number;
  assessment: 'stable' | 'neutral' | 'unstable' | 'isolated';
}

interface DependencyCycle {
  files: string[];
  length: number;
}

export interface PageRankResult {
  file: string;
  file_id: number;
  score: number;
  in_degree: number;
  out_degree: number;
}

interface ExtractionCandidate {
  symbol_id: string;
  name: string;
  file: string;
  cyclomatic: number;
  caller_file_count: number;
  score: number;
}

// ════════════════════════════════════════════════════════════════════════
// HELPERS — build file-level import graph from edges
// ════════════════════════════════════════════════════════════════════════

interface FileGraph {
  /** file_id → Set<file_id> for outgoing imports */
  forward: Map<number, Set<number>>;
  /** file_id → Set<file_id> for incoming imports (reverse) */
  reverse: Map<number, Set<number>>;
  /** file_id → file path */
  pathMap: Map<number, string>;
  /** all file_ids in the graph */
  allFileIds: Set<number>;
}

export interface BuildFileGraphOptions {
  /**
   * When true (default), the graph includes "projected" file→file edges
   * synthesized by the file-projection resolver from cross-file symbol→symbol
   * edges (renders_component, dispatches, listens_to, etc.). Coupling and
   * PageRank want these — they're real cross-file relationships.
   *
   * When false, the graph contains ONLY direct import statements. Cycle
   * detection wants this: a Vue component being rendered by another file is
   * not an import cycle even if both files reference each other indirectly
   * through framework metadata.
   */
  includeProjected?: boolean;
}

/**
 * Build file-level import graph from all import-category edges.
 * Uses a single JOIN query instead of per-edge lookups (N+1 → 1).
 */
export function buildFileGraph(store: Store, options: BuildFileGraphOptions = {}): FileGraph {
  const { includeProjected = true } = options;
  const forward = new Map<number, Set<number>>();
  const reverse = new Map<number, Set<number>>();
  const allFileIds = new Set<number>();
  const pathMap = new Map<number, string>();

  // Single query: resolve all import edges to file-level in one pass.
  // `projected:true` rows come from the file-projection pass (file-projection.ts);
  // they're synthesized from symbol-level edges of any kind and do NOT
  // represent a real `import` statement. Cycle detection toggles them off.
  const projectionFilter = includeProjected
    ? ''
    : `AND (e.metadata IS NULL OR json_extract(e.metadata, '$.projected') IS NOT 1)`;
  const rows = store.db
    .prepare(`
    SELECT
      CASE WHEN n1.node_type = 'file' THEN n1.ref_id ELSE s1.file_id END as src_file_id,
      CASE WHEN n2.node_type = 'file' THEN n2.ref_id ELSE s2.file_id END as tgt_file_id
    FROM edges e
    JOIN edge_types et ON e.edge_type_id = et.id
    JOIN nodes n1 ON e.source_node_id = n1.id
    JOIN nodes n2 ON e.target_node_id = n2.id
    LEFT JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
    LEFT JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
    WHERE et.name IN ('esm_imports', 'imports', 'py_imports', 'py_reexports')
      ${projectionFilter}
  `)
    .all() as Array<{ src_file_id: number | null; tgt_file_id: number | null }>;

  for (const row of rows) {
    const srcFileId = row.src_file_id;
    const tgtFileId = row.tgt_file_id;
    if (srcFileId == null || tgtFileId == null || srcFileId === tgtFileId) continue;

    if (!forward.has(srcFileId)) forward.set(srcFileId, new Set());
    forward.get(srcFileId)!.add(tgtFileId);

    if (!reverse.has(tgtFileId)) reverse.set(tgtFileId, new Set());
    reverse.get(tgtFileId)!.add(srcFileId);

    allFileIds.add(srcFileId);
    allFileIds.add(tgtFileId);
  }

  // Build path map in a single query
  if (allFileIds.size > 0) {
    const fileIds = [...allFileIds];
    // Batch in chunks of 500 to avoid SQLite variable limit
    for (let i = 0; i < fileIds.length; i += 500) {
      const chunk = fileIds.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(',');
      const fileRows = store.db
        .prepare(`SELECT id, path FROM files WHERE id IN (${placeholders})`)
        .all(...chunk) as Array<{ id: number; path: string }>;
      for (const f of fileRows) pathMap.set(f.id, f.path);
    }
  }

  return { forward, reverse, pathMap, allFileIds };
}

function _getFileIdForSymbol(store: Store, symbolRefId: number): number | undefined {
  const sym = store.db.prepare('SELECT file_id FROM symbols WHERE id = ?').get(symbolRefId) as
    | { file_id: number }
    | undefined;
  return sym?.file_id;
}

// ════════════════════════════════════════════════════════════════════════
// 1. COUPLING METRICS
// ════════════════════════════════════════════════════════════════════════

/**
 * Synthetic external-package stub files emitted by the indexer. They live
 * under `__external__/_root/pkg/*.synthetic` and exist purely to give edge
 * resolution something to attach to when resolving imports of npm/pip
 * packages. They are NOT user code, so they pollute any "most important
 * file" / "most unstable file" list. Filtered out of public outputs by
 * default.
 */
export function isExternalSyntheticPath(filePath: string): boolean {
  return filePath.startsWith('__external__/') || filePath.includes('/__external__/');
}

export interface CouplingMetricsOptions {
  /**
   * When true, test files participate in the coupling/instability metric.
   * Default false — tests have Ca=0/Ce>0 by definition, which floods the
   * `unstable_modules` count and the most-unstable top-N with results that
   * are not architectural smells but a property of test-file structure.
   */
  includeTests?: boolean;
  /**
   * When true, `__external__/*.synthetic` files participate in the metric.
   * Default false — externals are stubs, not code the user can act on.
   */
  includeExternals?: boolean;
}

export function getCouplingMetrics(
  store: Store,
  prebuiltGraph?: FileGraph,
  options: CouplingMetricsOptions = {},
): CouplingResult[] {
  const { includeTests = false, includeExternals = false } = options;
  const graph = prebuiltGraph ?? buildFileGraph(store);
  const results: CouplingResult[] = [];

  for (const fileId of graph.allFileIds) {
    const filePath = graph.pathMap.get(fileId) ?? `[file:${fileId}]`;
    if (!includeTests && isTestPath(filePath)) continue;
    if (!includeExternals && isExternalSyntheticPath(filePath)) continue;
    const ca = graph.reverse.get(fileId)?.size ?? 0;
    const ce = graph.forward.get(fileId)?.size ?? 0;
    const total = ca + ce;
    const instability = total === 0 ? 0 : ce / total;

    let assessment: CouplingResult['assessment'];
    if (total === 0) assessment = 'isolated';
    else if (instability <= 0.3) assessment = 'stable';
    else if (instability <= 0.7) assessment = 'neutral';
    else assessment = 'unstable';

    results.push({
      file: filePath,
      file_id: fileId,
      ca,
      ce,
      instability: Math.round(instability * 1000) / 1000,
      assessment,
    });
  }

  // Sort by instability descending (most unstable first)
  results.sort((a, b) => b.instability - a.instability || b.ce - a.ce);
  return results;
}

// ════════════════════════════════════════════════════════════════════════
// 2. DEPENDENCY CYCLE DETECTION (Kosaraju's SCC)
// ════════════════════════════════════════════════════════════════════════

/**
 * Path patterns that identify test files. Test files routinely produce
 * spurious cycles in the import graph because:
 *   - Test files import the source under test (legitimate).
 *   - Cross-cutting indexers/registries occasionally end up with parsed
 *     `imports` edges pointing AT a test fixture (e.g. when a `.test.ts`
 *     file is itself parsed as a plugin or fixture file gets enumerated by
 *     a project-context scan). That second edge closes a bogus 2-node
 *     "cycle" (test ↔ source) that nobody cares about.
 *   - When many such test fixtures share a transitively imported source
 *     graph, Kosaraju's SCC collapses them into one massive (false) cycle.
 *
 * We strip test files from the cycle graph by default. Pass
 * `includeTests: true` to opt back in.
 */
export const TEST_PATH_PATTERN: RegExp =
  /(?:^|\/)tests?\/|(?:^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/i;

export function isTestPath(filePath: string): boolean {
  return TEST_PATH_PATTERN.test(filePath);
}

export interface GetDependencyCyclesOptions {
  /**
   * When true, test files participate in cycle detection. Default false —
   * paths matching `tests/**`, `**\/*.test.{ts,tsx,js,jsx,mjs,cjs}`,
   * `**\/*.spec.*`, `**\/__tests__/**` are excluded.
   */
  includeTests?: boolean;
}

export function getDependencyCycles(
  store: Store,
  options: GetDependencyCyclesOptions = {},
): DependencyCycle[] {
  const { includeTests = false } = options;
  // Use the import-only view of the graph. `projected:true` edges are
  // synthesized from cross-file symbol relationships (renders_component,
  // dispatches, listens_to, Laravel ORM relations) and re-bucketed as
  // `imports` for downstream convenience — but a Vue component being
  // rendered by another file is NOT an import cycle. Excluding projected
  // edges here strips the last source of phantom SCCs that survived the
  // test-path filter (e.g. project-context.ts ↔ tests/.../fixture.test.ts
  // closed via a projected calls/references edge).
  const graph = buildFileGraph(store, { includeProjected: false });

  // Build the working graph. When excluding tests, we filter file ids
  // whose path matches a test pattern. Removing a node also requires
  // pruning its incoming/outgoing edges so the SCC walk doesn't traverse
  // through ghosts.
  const excluded = new Set<number>();
  if (!includeTests) {
    for (const fileId of graph.allFileIds) {
      const path = graph.pathMap.get(fileId);
      if (path && isTestPath(path)) excluded.add(fileId);
    }
  }

  const allowed = (id: number): boolean => !excluded.has(id);
  const filterNeighbors = (set: Set<number> | undefined): Set<number> | undefined => {
    if (!set || excluded.size === 0) return set;
    const out = new Set<number>();
    for (const n of set) if (!excluded.has(n)) out.add(n);
    return out;
  };

  // Build filtered adjacency maps once so the two DFS passes stay cheap.
  const forward: Map<number, Set<number>> = excluded.size === 0
    ? graph.forward
    : new Map(
        [...graph.forward.entries()]
          .filter(([k]) => allowed(k))
          .map(([k, v]) => [k, filterNeighbors(v)!]),
      );
  const reverse: Map<number, Set<number>> = excluded.size === 0
    ? graph.reverse
    : new Map(
        [...graph.reverse.entries()]
          .filter(([k]) => allowed(k))
          .map(([k, v]) => [k, filterNeighbors(v)!]),
      );

  const nodes = [...graph.allFileIds].filter(allowed);

  // Pass 1: DFS on original graph, record finish order
  const visited = new Set<number>();
  const finishOrder: number[] = [];

  for (const node of nodes) {
    if (!visited.has(node)) {
      dfsForward(node, forward, visited, finishOrder);
    }
  }

  // Pass 2: DFS on transposed graph in reverse finish order
  const visited2 = new Set<number>();
  const sccs: number[][] = [];

  for (let i = finishOrder.length - 1; i >= 0; i--) {
    const node = finishOrder[i];
    if (!visited2.has(node)) {
      const component: number[] = [];
      dfsReverse(node, reverse, visited2, component);
      if (component.length > 1) {
        sccs.push(component);
      }
    }
  }

  return sccs.map((scc) => ({
    files: scc.map((fid) => graph.pathMap.get(fid) ?? `[file:${fid}]`),
    length: scc.length,
  }));
}

/** Iterative DFS on forward graph — records finish order. */
function dfsForward(
  start: number,
  adj: Map<number, Set<number>>,
  visited: Set<number>,
  finishOrder: number[],
): void {
  const stack: Array<{ node: number; phase: 'enter' | 'exit' }> = [{ node: start, phase: 'enter' }];

  while (stack.length > 0) {
    const { node, phase } = stack.pop()!;
    if (phase === 'exit') {
      finishOrder.push(node);
      continue;
    }
    if (visited.has(node)) continue;
    visited.add(node);
    stack.push({ node, phase: 'exit' });
    const neighbors = adj.get(node);
    if (neighbors) {
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          stack.push({ node: neighbor, phase: 'enter' });
        }
      }
    }
  }
}

/** Iterative DFS on reverse graph — collects component. */
function dfsReverse(
  start: number,
  adj: Map<number, Set<number>>,
  visited: Set<number>,
  component: number[],
): void {
  const stack = [start];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    component.push(node);
    const neighbors = adj.get(node);
    if (neighbors) {
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          stack.push(neighbor);
        }
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// 3. PAGERANK
// ════════════════════════════════════════════════════════════════════════

/**
 * File extensions emitted by the markdown language plugin. Used by
 * `getPageRank` to suppress markdown files from the default ranking — they
 * otherwise crowd out real code under generic queries.
 */
const MARKDOWN_EXTENSIONS: readonly string[] = ['.md', '.mdx', '.markdown', '.qmd'];

function isMarkdownPath(p: string): boolean {
  const lower = p.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function getPageRank(
  store: Store,
  options: {
    damping?: number;
    maxIterations?: number;
    tolerance?: number;
    prebuiltGraph?: FileGraph;
    /**
     * When true, keep markdown files in the result. Default false — markdown
     * notes dominate the import graph by structural accident (many notes
     * cross-link via wikilinks) and bury real code files in the top-N.
     */
    includeMarkdown?: boolean;
    /**
     * When true, keep `__external__/*.synthetic` stubs in the result. Default
     * false — synthetic externals like `vitest.synthetic`/`node:path.synthetic`
     * have huge in-degree by definition (everyone imports them) and crowd out
     * real user code in the top-N otherwise.
     */
    includeExternals?: boolean;
  } = {},
): PageRankResult[] {
  const {
    damping = 0.85,
    maxIterations = 100,
    tolerance = 1e-6,
    includeMarkdown = false,
    includeExternals = false,
  } = options;
  const graph = options.prebuiltGraph ?? buildFileGraph(store);
  const nodes = [...graph.allFileIds];
  const N = nodes.length;
  if (N === 0) return [];

  const nodeIndex = new Map<number, number>();
  nodes.forEach((id, i) => {
    nodeIndex.set(id, i);
  });

  // Initialize scores uniformly
  let scores = new Float64Array(N).fill(1 / N);
  let newScores = new Float64Array(N);

  // Precompute out-degree
  const outDegree = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    outDegree[i] = graph.forward.get(nodes[i])?.size ?? 0;
  }

  for (let iter = 0; iter < maxIterations; iter++) {
    // Dangling mass: nodes with no outlinks redistribute uniformly
    let danglingMass = 0;
    for (let i = 0; i < N; i++) {
      if (outDegree[i] === 0) danglingMass += scores[i];
    }

    const base = (1 - damping) / N + (damping * danglingMass) / N;
    newScores.fill(base);

    // Distribute scores along edges
    for (let i = 0; i < N; i++) {
      const neighbors = graph.forward.get(nodes[i]);
      if (!neighbors || neighbors.size === 0) continue;
      const share = (damping * scores[i]) / neighbors.size;
      for (const neighbor of neighbors) {
        const j = nodeIndex.get(neighbor);
        if (j !== undefined) newScores[j] += share;
      }
    }

    // Check convergence
    let diff = 0;
    for (let i = 0; i < N; i++) {
      diff += Math.abs(newScores[i] - scores[i]);
    }
    [scores, newScores] = [newScores, scores];
    if (diff < tolerance) break;
  }

  // Build results. E10 — apply user-supplied pin weights as a final
  // multiplicative pass. Precedence rules:
  //   1. Explicit file pin always wins. A user pinning a file at 0.5 to
  //      demote it must not be silently boosted by a symbol pin that
  //      happens to live in the same file.
  //   2. If no file pin, fall back to the symbol-pin propagation: take
  //      the max symbol pin weight across symbols in the file (computed
  //      in pins.ts).
  //   3. Otherwise no boost (weight = 1.0).
  const symbolPinsByFile = getSymbolPinWeightsByFile(store.db);
  const results: PageRankResult[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const fileId = nodes[i];
    const filePath = graph.pathMap.get(fileId) ?? `[file:${fileId}]`;
    if (!includeMarkdown && isMarkdownPath(filePath)) continue;
    if (!includeExternals && isExternalSyntheticPath(filePath)) continue;
    const explicitFile = getFilePinWeightExplicit(store.db, filePath);
    const pinWeight = explicitFile ?? symbolPinsByFile.get(filePath) ?? 1.0;
    const adjusted = scores[i] * pinWeight;
    results.push({
      file: filePath,
      file_id: fileId,
      score: Math.round(adjusted * 1e6) / 1e6,
      in_degree: graph.reverse.get(fileId)?.size ?? 0,
      out_degree: graph.forward.get(fileId)?.size ?? 0,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ════════════════════════════════════════════════════════════════════════
// 4. EXTRACTION CANDIDATES
// ════════════════════════════════════════════════════════════════════════

export function getExtractionCandidates(
  store: Store,
  options: { minCyclomatic?: number; minCallers?: number; limit?: number } = {},
): ExtractionCandidate[] {
  const { minCyclomatic = 5, minCallers = 2, limit = 20 } = options;

  // Single query: find complex symbols with their distinct caller file count
  // This replaces ~7500 N+1 queries with 1 query
  const rows = store.db
    .prepare(`
    SELECT
      s.symbol_id, s.name, f.path, s.cyclomatic,
      COUNT(DISTINCT caller_file.id) as caller_file_count
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    JOIN nodes n ON n.node_type = 'symbol' AND n.ref_id = s.id
    JOIN edges e ON e.target_node_id = n.id
    JOIN nodes src_n ON e.source_node_id = src_n.id
    LEFT JOIN symbols src_s ON src_n.node_type = 'symbol' AND src_n.ref_id = src_s.id
    LEFT JOIN files caller_file ON
      (src_n.node_type = 'file' AND src_n.ref_id = caller_file.id AND caller_file.id != f.id)
      OR (src_n.node_type = 'symbol' AND src_s.file_id = caller_file.id AND caller_file.id != f.id)
    WHERE s.kind IN ('function', 'method')
      AND s.cyclomatic IS NOT NULL
      AND s.cyclomatic >= ?
    GROUP BY s.id
    HAVING COUNT(DISTINCT caller_file.id) >= ?
    ORDER BY s.cyclomatic * COUNT(DISTINCT caller_file.id) DESC
    LIMIT ?
  `)
    .all(minCyclomatic, minCallers, limit) as Array<{
    symbol_id: string;
    name: string;
    path: string;
    cyclomatic: number;
    caller_file_count: number;
  }>;

  return rows.map((r) => ({
    symbol_id: r.symbol_id,
    name: r.name,
    file: r.path,
    cyclomatic: r.cyclomatic,
    caller_file_count: r.caller_file_count,
    score: r.cyclomatic * r.caller_file_count,
  }));
}

// ════════════════════════════════════════════════════════════════════════
// 5. REPO HEALTH (aggregated triage)
// ════════════════════════════════════════════════════════════════════════

interface RepoHealthResult {
  summary: {
    total_files: number;
    total_symbols: number;
    files_in_graph: number;
    dependency_cycles: number;
    unstable_modules: number;
    avg_instability: number;
  };
  top_pagerank: PageRankResult[];
  cycles: DependencyCycle[];
  most_unstable: CouplingResult[];
  extraction_candidates: ExtractionCandidate[];
}

export function getRepoHealth(store: Store): RepoHealthResult {
  const stats = store.getStats();
  const coupling = getCouplingMetrics(store);
  const cycles = getDependencyCycles(store);
  const pagerank = getPageRank(store);
  const extractionCandidates = getExtractionCandidates(store);

  const unstable = coupling.filter((c) => c.assessment === 'unstable');
  const totalInstability = coupling.reduce((sum, c) => sum + c.instability, 0);
  const avgInstability =
    coupling.length > 0 ? Math.round((totalInstability / coupling.length) * 1000) / 1000 : 0;

  return {
    summary: {
      total_files: stats.totalFiles,
      total_symbols: stats.totalSymbols,
      files_in_graph: coupling.length,
      dependency_cycles: cycles.length,
      unstable_modules: unstable.length,
      avg_instability: avgInstability,
    },
    top_pagerank: pagerank.slice(0, 10),
    cycles,
    most_unstable: unstable.slice(0, 10),
    extraction_candidates: extractionCandidates.slice(0, 5),
  };
}
