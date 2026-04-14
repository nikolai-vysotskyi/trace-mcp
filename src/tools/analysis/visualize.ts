/**
 * Graph Visualization — generates self-contained HTML with embedded D3.js
 * and Mermaid diagram output for inline chat use.
 *
 * Performance: single batch query for nodes + edges, O(n) graph assembly.
 * Memory: streams HTML template, no large intermediate buffers.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ok, err, type TraceMcpResult } from '../../errors.js';
import { validationError } from '../../errors.js';
import { Store, type FileRow, type SymbolRow, type EdgeRow } from '../../db/store.js';
import { initializeDatabase } from '../../db/schema.js';
import type { TopologyStore } from '../../topology/topology-db.js';
import { logger } from '../../logger.js';
// @ts-expect-error — picomatch has no bundled types (transitive dep of fast-glob)
import picomatch from 'picomatch';

// ── Types ──────────────────────────────────────────────────────────────────

export interface VisualizeGraphOptions {
  scope: string;            // file path, directory, or "project"
  depth?: number;           // max hops from scope (default: 2)
  layout?: 'force' | 'hierarchical' | 'radial';
  colorBy?: 'community' | 'language' | 'framework_role';
  includeEdges?: string[];  // filter edge types
  output?: string;          // output path
  hideIsolated?: boolean;   // hide nodes with no edges (default: true)
  granularity?: 'file' | 'symbol'; // node granularity (default: file)
  symbolKinds?: string[];   // filter symbol kinds when granularity=symbol
  maxFiles?: number;        // max seed files for file-level graph
  maxNodes?: number;        // max viz nodes for symbol-level graph (default: 100000)
  topoStore?: TopologyStore; // topology store — when set, merges connected subproject repos
  projectRoot?: string;      // current project root — used to scope subprojects to connected repos only
  highlightDepth?: number;   // BFS depth for click-highlight (default: 1)
}

interface VizNode {
  id: string;
  label: string;
  type: 'file' | 'symbol';
  language: string | null;
  framework_role: string | null;
  community: number;
  symbolCount?: number;
  importance: number;
  repo?: string;  // set when merging subproject repos
}

interface VizEdge {
  source: string;
  target: string;
  type: string;
  weight: number;
}

interface VizCommunity {
  id: number;
  label: string;
  color: string;
}

interface VisualizeGraphResult {
  outputPath: string;
  nodes: number;
  edges: number;
  communities: number;
}

interface MermaidDiagramOptions {
  scope: string;
  depth?: number;
  maxNodes?: number;
  format?: 'mermaid' | 'dot';
}

interface MermaidDiagramResult {
  diagram: string;
  format: string;
  nodes: number;
  edges: number;
}

// ── Community Detection (simple label propagation) ─────────────────────

function detectCommunities(
  nodeIds: string[],
  edges: VizEdge[],
): Map<string, number> {
  const labels = new Map<string, number>();
  nodeIds.forEach((id, i) => labels.set(id, i));

  // Build adjacency list
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    adj.get(e.source)?.push(e.target);
    adj.get(e.target)?.push(e.source);
  }

  // Label propagation — 5 iterations is usually enough
  for (let iter = 0; iter < 5; iter++) {
    for (const id of nodeIds) {
      const neighbors = adj.get(id);
      if (!neighbors || neighbors.length === 0) continue;
      // Most frequent label among neighbors
      const freq = new Map<number, number>();
      for (const n of neighbors) {
        const l = labels.get(n) ?? 0;
        freq.set(l, (freq.get(l) ?? 0) + 1);
      }
      let maxLabel = labels.get(id)!;
      let maxCount = 0;
      for (const [l, c] of freq) {
        if (c > maxCount) { maxCount = c; maxLabel = l; }
      }
      labels.set(id, maxLabel);
    }
  }

  // Normalize community IDs to 0..N
  const uniqueLabels = [...new Set(labels.values())];
  const remap = new Map<number, number>();
  uniqueLabels.forEach((l, i) => remap.set(l, i));
  for (const [id, l] of labels) labels.set(id, remap.get(l)!);

  return labels;
}

// ── Graph Data Builder ─────────────────────────────────────────────────

export function buildGraphData(
  store: Store,
  opts: VisualizeGraphOptions,
): { nodes: VizNode[]; edges: VizEdge[]; communities: VizCommunity[] } {
  const scope = opts.scope;
  const depth = opts.depth ?? 2;
  const colorBy = opts.colorBy ?? 'community';
  const granularity = opts.granularity ?? 'file';
  const hideIsolated = opts.hideIsolated === true; // default false

  // Subproject layer: when scope='project' and topoStore is available, merge all subproject repos
  if (scope === 'project' && opts.topoStore) {
    try {
      const subResult = buildSubprojectGraph(store, opts);
      if (subResult) return subResult;
    } catch (e) {
      logger.warn({ error: e }, 'Subproject graph merge failed, falling back to single-project');
    }
  }

  return buildSingleProjectGraph(store, opts, scope, depth, granularity, hideIsolated);
}

/** Directories that should never appear in graph visualizations (safety net for stale indexes). */
const GRAPH_EXCLUDE_DIRS = new Set([
  'node_modules', 'vendor', '.git', 'dist', 'build', '__pycache__',
  '.venv', '.next', '.nuxt', 'coverage', '.turbo', '.cache',
]);

function isExcludedPath(filePath: string): boolean {
  const segments = filePath.split('/');
  return segments.some((seg) => GRAPH_EXCLUDE_DIRS.has(seg));
}

function buildSingleProjectGraph(
  store: Store,
  opts: VisualizeGraphOptions,
  scope: string,
  depth: number,
  granularity: string,
  hideIsolated: boolean,
): { nodes: VizNode[]; edges: VizEdge[]; communities: VizCommunity[] } {
  // 1. Determine seed files
  let seedFiles: FileRow[];
  if (scope === 'project') {
    seedFiles = store.getAllFiles().filter((f) => !isExcludedPath(f.path));
  } else {
    const allFiles = store.getAllFiles().filter((f) => !isExcludedPath(f.path));
    if (scope.includes('*')) {
      const isMatch = picomatch(scope, { dot: true });
      seedFiles = allFiles.filter((f) => isMatch(f.path));
    } else if (scope.endsWith('/') || !scope.includes('.')) {
      seedFiles = allFiles.filter((f) => f.path.startsWith(scope.replace(/\/$/, '')));
    } else {
      seedFiles = allFiles.filter((f) => f.path === scope);
    }
  }

  // Filter by edge type if specified
  const edgeFilter = opts.includeEdges ? new Set(opts.includeEdges) : null;

  if (granularity === 'symbol') {
    return buildSymbolGraph(store, seedFiles, depth, edgeFilter, hideIsolated, opts);
  }

  // File-level: only cap seed files when explicitly requested
  const maxFiles = opts.maxFiles;
  if (maxFiles && seedFiles.length > maxFiles) seedFiles = seedFiles.slice(0, maxFiles);
  return buildFileGraph(store, seedFiles, depth, edgeFilter, hideIsolated, opts);
}

/**
 * Subproject-aware graph: only include repos that are directly connected
 * to the current project via cross-service edges in topology.
 */
function buildSubprojectGraph(
  mainStore: Store,
  opts: VisualizeGraphOptions,
): { nodes: VizNode[]; edges: VizEdge[]; communities: VizCommunity[] } | null {
  const topoStore = opts.topoStore!;
  const projectRoot = opts.projectRoot;
  if (!projectRoot) return null;

  const repos = topoStore.getSubprojectsByProject(projectRoot);
  if (repos.length === 0) return null; // no connected repos — skip subproject merge

  const allNodes: VizNode[] = [];
  const allEdges: VizEdge[] = [];

  // Build graph for main project
  const mainResult = buildSingleProjectGraph(
    mainStore, opts, 'project', opts.depth ?? 2,
    opts.granularity ?? 'file', opts.hideIsolated === true,
  );

  const mainPrefix = allRepos.find((r) => r.repo_root === projectRoot)?.name ?? path.basename(projectRoot);

  for (const n of mainResult.nodes) {
    n.repo = mainPrefix;
    allNodes.push(n);
  }
  allEdges.push(...mainResult.edges);

  // Build graph for each connected subproject repo
  for (const repo of repos) {
    if (!repo.db_path || !fs.existsSync(repo.db_path)) continue;

    let db: InstanceType<typeof Database> | null = null;
    try {
      db = initializeDatabase(repo.db_path);
      const fedStore = new Store(db);
      const repoPrefix = repo.name;

      const fedOpts: VisualizeGraphOptions = {
        ...opts,
        topoStore: undefined, // prevent recursion
      };

      const fedResult = buildSingleProjectGraph(
        fedStore, fedOpts, 'project', opts.depth ?? 2,
        opts.granularity ?? 'file', opts.hideIsolated === true,
      );

      for (const n of fedResult.nodes) {
        n.id = `${repoPrefix}:${n.id}`;
        n.repo = repoPrefix;
        allNodes.push(n);
      }
      for (const e of fedResult.edges) {
        allEdges.push({
          source: `${repoPrefix}:${e.source}`,
          target: `${repoPrefix}:${e.target}`,
          type: e.type,
          weight: e.weight,
        });
      }
    } catch (e) {
      logger.warn({ repo: repo.name, error: e }, 'Failed to load subproject repo for graph');
    } finally {
      db?.close();
    }
  }

  // Add cross-service edges from topology
  try {
    const crossEdges = topoStore.getAllCrossServiceEdges();
    for (const ce of crossEdges) {
      const srcPrefix = allRepos.find((r) => r.name === ce.source_name)?.name ?? mainPrefix;
      const tgtPrefix = allRepos.find((r) => r.name === ce.target_name)?.name ?? mainPrefix;
      if (srcPrefix === tgtPrefix) continue;

      const srcNodes = allNodes.filter((n) => n.repo === srcPrefix);
      const tgtNodes = allNodes.filter((n) => n.repo === tgtPrefix);
      if (srcNodes.length > 0 && tgtNodes.length > 0) {
        allEdges.push({
          source: srcNodes[0].id,
          target: tgtNodes[0].id,
          type: ce.edge_type ?? 'cross_service',
          weight: 1,
        });
      }
    }
  } catch { /* cross-service edges are best-effort */ }

  if (allNodes.length === 0) return null;

  return finalize(allNodes, allEdges, opts.hideIsolated === true);
}

/**
 * File-level graph: seed by SYMBOL nodes (where all edges live),
 * then collapse symbol→symbol edges into file→file edges.
 */
function buildFileGraph(
  store: Store,
  seedFiles: FileRow[],
  depth: number,
  edgeFilter: Set<string> | null,
  hideIsolated: boolean,
  opts: VisualizeGraphOptions,
): { nodes: VizNode[]; edges: VizEdge[]; communities: VizCommunity[] } {
  // 1. Collect ALL symbol node IDs for the seed files — this is where
  //    edges actually live (symbol→symbol), not file→file.
  const fileIdSet = new Set(seedFiles.map((f) => f.id));
  const fileByIdMap = new Map(seedFiles.map((f) => [f.id, f]));

  // Get symbol→nodeId mapping for seed files
  const allSymbols = store.getSymbolsByFileIds([...fileIdSet]);
  const symRefIds = allSymbols.map((s) => s.id);
  const symNodeMap = store.getNodeIdsBatch('symbol', symRefIds); // refId → nodeId
  const symbolNodeIds = [...symNodeMap.values()];

  // Also get file node IDs (some edges might be file→file)
  const fileRefIds = seedFiles.map((f) => f.id);
  const fileNodeMap = store.getNodeIdsBatch('file', fileRefIds);
  const fileNodeIds = [...fileNodeMap.values()];

  // Build reverse: nodeId → fileId (for collapsing symbol edges to file level)
  const nodeIdToFileId = new Map<number, number>();
  for (const sym of allSymbols) {
    const nodeId = symNodeMap.get(sym.id);
    if (nodeId) nodeIdToFileId.set(nodeId, sym.file_id);
  }
  for (const file of seedFiles) {
    const nodeId = fileNodeMap.get(file.id);
    if (nodeId) nodeIdToFileId.set(nodeId, file.id);
  }

  // 2. Query edges for all seed nodes (symbols + files)
  const allSeedNodeIds = [...new Set([...symbolNodeIds, ...fileNodeIds])];
  const rawEdges = allSeedNodeIds.length > 0
    ? store.getEdgesForNodesBatch(allSeedNodeIds)
    : [];

  const filteredEdges = edgeFilter
    ? rawEdges.filter((e) => edgeFilter.has(e.edge_type_name))
    : rawEdges;

  // 3. Expand frontier by depth (at symbol/node level)
  //    Collect ALL edges during expansion so we don't re-query them in step 6
  const visitedNodes = new Set(allSeedNodeIds);
  let frontier = new Set(allSeedNodeIds);
  const allCollectedEdges: typeof filteredEdges = [...filteredEdges];

  for (let d = 0; d < depth && frontier.size > 0; d++) {
    const nextFrontier = new Set<number>();
    const batchEdges = d === 0
      ? filteredEdges
      : store.getEdgesForNodesBatch([...frontier]);

    if (d > 0) allCollectedEdges.push(...batchEdges);

    for (const edge of batchEdges) {
      const otherNode = edge.pivot_node_id === edge.source_node_id
        ? edge.target_node_id
        : edge.source_node_id;

      if (!visitedNodes.has(otherNode) && visitedNodes.size < 5000) {
        visitedNodes.add(otherNode);
        nextFrontier.add(otherNode);
      }
    }
    frontier = nextFrontier;
  }

  // Fetch edges for nodes discovered during expansion (not yet covered)
  const uncoveredNodes = [...visitedNodes].filter((n) => !allSeedNodeIds.includes(n));
  if (uncoveredNodes.length > 0) {
    const extraEdges = store.getEdgesForNodesBatch(uncoveredNodes);
    allCollectedEdges.push(...extraEdges);
  }

  // 4. Resolve all expanded nodes back to files
  const nodeRefs = store.getNodeRefsBatch([...visitedNodes]);
  const expandedFileIds = new Set<number>();
  const expandedSymbolIds = new Set<number>();

  for (const [, ref] of nodeRefs) {
    if (ref.nodeType === 'file') expandedFileIds.add(ref.refId);
    else if (ref.nodeType === 'symbol') expandedSymbolIds.add(ref.refId);
  }

  // Resolve symbols to their file_id
  const expandedSymbolRows = expandedSymbolIds.size > 0
    ? store.getSymbolsByIds([...expandedSymbolIds])
    : new Map();

  for (const [nodeId, ref] of nodeRefs) {
    if (ref.nodeType === 'symbol') {
      const sym = expandedSymbolRows.get(ref.refId);
      if (sym) {
        nodeIdToFileId.set(nodeId, sym.file_id);
        expandedFileIds.add(sym.file_id);
      }
    } else if (ref.nodeType === 'file') {
      nodeIdToFileId.set(nodeId, ref.refId);
    }
  }

  // Load all file info
  const allFilesById = store.getFilesByIds([...expandedFileIds]);

  // 5. Build file-level viz nodes (exclude vendor/node_modules even if reached via edges)
  const vizNodeMap = new Map<string, VizNode>();
  for (const [, file] of allFilesById) {
    if (vizNodeMap.has(file.path)) continue;
    if (isExcludedPath(file.path)) continue;
    vizNodeMap.set(file.path, {
      id: file.path,
      label: path.basename(file.path),
      type: 'file',
      language: file.language,
      framework_role: file.framework_role,
      community: 0,
      importance: 0,
    });
  }

  // 6. Collapse symbol→symbol edges into file→file edges
  //    Reuse edges collected during expansion — no duplicate query
  const edgeMap = new Map<string, VizEdge>();

  for (const edge of allCollectedEdges) {
    if (edgeFilter && !edgeFilter.has(edge.edge_type_name)) continue;

    const srcFileId = nodeIdToFileId.get(edge.source_node_id);
    const tgtFileId = nodeIdToFileId.get(edge.target_node_id);
    if (srcFileId == null || tgtFileId == null || srcFileId === tgtFileId) continue;

    const srcFile = allFilesById.get(srcFileId);
    const tgtFile = allFilesById.get(tgtFileId);
    if (!srcFile || !tgtFile) continue;

    const key = `${srcFile.path}→${tgtFile.path}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.weight++;
    } else {
      edgeMap.set(key, {
        source: srcFile.path,
        target: tgtFile.path,
        type: edge.edge_type_name,
        weight: 1,
      });
    }
  }

  const dedupedEdges = [...edgeMap.values()];
  let vizNodes = [...vizNodeMap.values()];

  // 7. Communities, importance, optional isolation filter
  return finalize(vizNodes, dedupedEdges, hideIsolated);
}

/**
 * Symbol-level graph: show individual functions/classes/methods as nodes.
 *
 * Import edges live on file nodes (file→file), while heritage edges live on
 * symbol nodes (symbol→symbol).  We query BOTH node types so that import
 * relationships show up at symbol granularity.  File-level edges are "fanned
 * out" to representative symbols via import-specifier metadata when available,
 * otherwise a single proxy edge per file pair is created.
 */
function buildSymbolGraph(
  store: Store,
  seedFiles: FileRow[],
  depth: number,
  edgeFilter: Set<string> | null,
  hideIsolated: boolean,
  opts: VisualizeGraphOptions,
): { nodes: VizNode[]; edges: VizEdge[]; communities: VizCommunity[] } {
  const MAX_VIZ_NODES = opts.maxNodes ?? 100_000;

  const fileIds = seedFiles.map((f) => f.id);

  // -- Collect seed file node IDs (import edges are file→file) --
  const fileNodeMap = store.getNodeIdsBatch('file', fileIds);
  const seedFileNodeIds = [...fileNodeMap.values()];

  // -- Reverse map: nodeId → fileId --
  const nodeIdToFileId = new Map<number, number>();
  for (const file of seedFiles) {
    const nodeId = fileNodeMap.get(file.id);
    if (nodeId) nodeIdToFileId.set(nodeId, file.id);
  }

  // -- Expand frontier using file node edges --
  const visitedFileNodes = new Set(seedFileNodeIds);
  let frontier = new Set(seedFileNodeIds);

  const rawEdges = seedFileNodeIds.length > 0
    ? store.getEdgesForNodesBatch(seedFileNodeIds)
    : [];
  const filteredEdges = edgeFilter
    ? rawEdges.filter((e) => edgeFilter.has(e.edge_type_name))
    : rawEdges;

  // Collect ALL edges we encounter during traversal
  const collectedEdges: typeof filteredEdges = [...filteredEdges];

  for (let d = 0; d < depth && frontier.size > 0; d++) {
    const nextFrontier = new Set<number>();
    const batchEdges = d === 0
      ? filteredEdges
      : store.getEdgesForNodesBatch([...frontier]);

    if (d > 0) collectedEdges.push(...batchEdges);

    for (const edge of batchEdges) {
      const otherNode = edge.pivot_node_id === edge.source_node_id
        ? edge.target_node_id
        : edge.source_node_id;

      if (!visitedFileNodes.has(otherNode) && visitedFileNodes.size < 5000) {
        visitedFileNodes.add(otherNode);
        nextFrontier.add(otherNode);
      }
    }
    frontier = nextFrontier;
  }

  // -- Resolve all visited file nodes to file IDs --
  const fileNodeRefs = store.getNodeRefsBatch([...visitedFileNodes]);
  const connectedFileIds = new Set<number>();
  // Pre-load file paths for exclusion check
  const candidateFileRefIds: number[] = [];
  for (const [, ref] of fileNodeRefs) {
    if (ref.nodeType === 'file') candidateFileRefIds.push(ref.refId);
  }
  const candidateFilesMap = candidateFileRefIds.length > 0 ? store.getFilesByIds(candidateFileRefIds) : new Map();
  for (const [nodeId, ref] of fileNodeRefs) {
    if (ref.nodeType === 'file') {
      const file = candidateFilesMap.get(ref.refId);
      if (file && isExcludedPath(file.path)) continue;
      nodeIdToFileId.set(nodeId, ref.refId);
      connectedFileIds.add(ref.refId);
    }
  }

  // -- Determine which files have edges (prioritize their symbols) --
  const edgeConnectedFileIds = new Set<number>();
  for (const edge of collectedEdges) {
    const srcFid = nodeIdToFileId.get(edge.source_node_id);
    const tgtFid = nodeIdToFileId.get(edge.target_node_id);
    if (srcFid != null) edgeConnectedFileIds.add(srcFid);
    if (tgtFid != null) edgeConnectedFileIds.add(tgtFid);
  }

  // -- Load symbols: prioritize files with edges --
  const connectedFileIdArr = [...connectedFileIds];
  const allSymbols = connectedFileIdArr.length > 0
    ? store.getSymbolsByFileIds(connectedFileIdArr)
    : [];

  // Apply kind filter
  const filteredSymbols = opts.symbolKinds
    ? allSymbols.filter((s) => opts.symbolKinds!.includes(s.kind))
    : allSymbols;

  // Cap total symbols: prioritize symbols from files that have edges
  let cappedSymbols: typeof filteredSymbols;
  if (filteredSymbols.length > MAX_VIZ_NODES) {
    const withEdges = filteredSymbols.filter((s) => edgeConnectedFileIds.has(s.file_id));
    const withoutEdges = filteredSymbols.filter((s) => !edgeConnectedFileIds.has(s.file_id));
    const remaining = MAX_VIZ_NODES - withEdges.length;
    cappedSymbols = remaining > 0
      ? [...withEdges, ...withoutEdges.slice(0, remaining)]
      : withEdges.slice(0, MAX_VIZ_NODES);
  } else {
    cappedSymbols = filteredSymbols;
  }

  const symbolsById = new Map<number, (typeof cappedSymbols)[0]>();
  for (const sym of cappedSymbols) {
    symbolsById.set(sym.id, sym);
  }

  // -- Collect symbol-level edges (heritage, etc.) for capped symbols only --
  const cappedSymRefIds = cappedSymbols.map((s) => s.id);
  const cappedSymNodeMap = store.getNodeIdsBatch('symbol', cappedSymRefIds);
  const cappedSymNodeIds = [...cappedSymNodeMap.values()];

  const symEdges = cappedSymNodeIds.length > 0
    ? store.getEdgesForNodesBatch(cappedSymNodeIds)
    : [];
  const filteredSymEdges = edgeFilter
    ? symEdges.filter((e) => edgeFilter.has(e.edge_type_name))
    : symEdges;
  collectedEdges.push(...filteredSymEdges);

  // Resolve heritage-connected symbols from OUTSIDE the capped set
  const symNodeToSymId = new Map<number, number>();
  const cappedSymNodeIdSet = new Set(cappedSymNodeIds);
  // Map capped symbol nodes first
  for (const [refId, nodeId] of cappedSymNodeMap) {
    symNodeToSymId.set(nodeId, refId);
  }
  const heritageExternalNodeIds: number[] = [];
  for (const edge of filteredSymEdges) {
    for (const nid of [edge.source_node_id, edge.target_node_id]) {
      if (!cappedSymNodeIdSet.has(nid) && !symNodeToSymId.has(nid)) {
        heritageExternalNodeIds.push(nid);
      }
    }
  }
  // Resolve external heritage symbol nodes
  if (heritageExternalNodeIds.length > 0) {
    const extRefs = store.getNodeRefsBatch(heritageExternalNodeIds);
    const extSymIds: number[] = [];
    for (const [nodeId, ref] of extRefs) {
      if (ref.nodeType === 'symbol') {
        symNodeToSymId.set(nodeId, ref.refId);
        extSymIds.push(ref.refId);
      }
    }
    if (extSymIds.length > 0) {
      const extSyms = store.getSymbolsByIds(extSymIds);
      for (const [id, sym] of extSyms) symbolsById.set(id, sym);
    }
  }

  // -- Build viz nodes --
  // Batch-load all files at once instead of N+1 getFileById() calls
  const allFileIds = new Set<number>();
  for (const sym of symbolsById.values()) allFileIds.add(sym.file_id);
  const filesById = store.getFilesByIds([...allFileIds]);

  const vizNodes: VizNode[] = [];
  const fileIdToVizIds = new Map<number, string[]>();
  const symbolIdToVizId = new Map<number, string>(); // symbol DB id → symbol_id string

  for (const sym of symbolsById.values()) {
    const file = filesById.get(sym.file_id);
    if (file && isExcludedPath(file.path)) continue;
    vizNodes.push({
      id: sym.symbol_id,
      label: sym.name,
      type: 'symbol',
      language: file?.language ?? null,
      framework_role: file?.framework_role ?? null,
      community: 0,
      importance: 0,
    });
    const list = fileIdToVizIds.get(sym.file_id) ?? [];
    list.push(sym.symbol_id);
    fileIdToVizIds.set(sym.file_id, list);
    symbolIdToVizId.set(sym.id, sym.symbol_id);
  }

  // Map symbol node IDs to viz IDs for heritage edges
  const nodeIdToVizId = new Map<number, string>();
  for (const [nodeId, symId] of symNodeToSymId) {
    const vizId = symbolIdToVizId.get(symId);
    if (vizId) nodeIdToVizId.set(nodeId, vizId);
  }

  // -- Build symbol name lookup per file (for specifier matching) --
  const fileSymbolByName = new Map<number, Map<string, string>>();
  for (const sym of symbolsById.values()) {
    let nameMap = fileSymbolByName.get(sym.file_id);
    if (!nameMap) { nameMap = new Map(); fileSymbolByName.set(sym.file_id, nameMap); }
    nameMap.set(sym.name, sym.symbol_id);
  }

  // -- Build edges --
  const edgeMap = new Map<string, VizEdge>();

  const addVizEdge = (source: string, target: string, type: string) => {
    if (source === target) return;
    const key = `${source}→${target}`;
    const existing = edgeMap.get(key);
    if (existing) { existing.weight++; }
    else { edgeMap.set(key, { source, target, type, weight: 1 }); }
  };

  // Deduplicate collected edges
  const seenEdges = new Set<string>();
  for (const edge of collectedEdges) {
    const edgeKey = `${edge.source_node_id}-${edge.target_node_id}-${edge.edge_type_id}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);

    if (edgeFilter && !edgeFilter.has(edge.edge_type_name)) continue;

    // Check if it's a symbol→symbol edge (heritage)
    const sourceViz = nodeIdToVizId.get(edge.source_node_id);
    const targetViz = nodeIdToVizId.get(edge.target_node_id);

    if (sourceViz && targetViz) {
      addVizEdge(sourceViz, targetViz, edge.edge_type_name);
      continue;
    }

    // file→file edge: fan out to symbols using import specifiers
    const srcFileId = nodeIdToFileId.get(edge.source_node_id);
    const tgtFileId = nodeIdToFileId.get(edge.target_node_id);
    if (srcFileId == null || tgtFileId == null || srcFileId === tgtFileId) continue;

    const srcSymbols = fileIdToVizIds.get(srcFileId);
    const tgtSymbols = fileIdToVizIds.get(tgtFileId);
    if (!srcSymbols?.length || !tgtSymbols?.length) continue;

    // Try to match via import specifiers in edge metadata
    let matched = false;
    if (edge.metadata) {
      try {
        const meta = JSON.parse(edge.metadata) as { specifiers?: string[] };
        if (meta.specifiers?.length) {
          const tgtNameMap = fileSymbolByName.get(tgtFileId);
          if (tgtNameMap) {
            for (const spec of meta.specifiers) {
              const tgtViz = tgtNameMap.get(spec);
              if (tgtViz) {
                addVizEdge(srcSymbols[0], tgtViz, edge.edge_type_name);
                matched = true;
              }
            }
          }
        }
      } catch { /* ignore malformed metadata */ }
    }

    // Fallback: create one proxy edge between first symbols of each file
    if (!matched) {
      addVizEdge(srcSymbols[0], tgtSymbols[0], edge.edge_type_name);
    }
  }

  return finalize(vizNodes, [...edgeMap.values()], hideIsolated);
}

/**
 * Common finalization: communities, importance, optional isolation filter.
 */
function finalize(
  vizNodes: VizNode[],
  dedupedEdges: VizEdge[],
  hideIsolated: boolean,
): { nodes: VizNode[]; edges: VizEdge[]; communities: VizCommunity[] } {
  // Detect communities
  const nodeVizIds = vizNodes.map((n) => n.id);
  const communityLabels = detectCommunities(nodeVizIds, dedupedEdges);
  for (const node of vizNodes) {
    node.community = communityLabels.get(node.id) ?? 0;
  }

  // Compute importance (degree centrality)
  const degree = new Map<string, number>();
  for (const e of dedupedEdges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const maxDegree = Math.max(1, ...degree.values());
  for (const node of vizNodes) {
    node.importance = Math.round(((degree.get(node.id) ?? 0) / maxDegree) * 100) / 100;
  }

  // Optional: hide isolated nodes
  if (hideIsolated) {
    const connectedIds = new Set(dedupedEdges.flatMap((e) => [e.source, e.target]));
    vizNodes = vizNodes.filter((n) => connectedIds.has(n.id));
  }

  // Build community list
  const communitySet = new Set(vizNodes.map((n) => n.community));
  const COLORS = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];
  const communities: VizCommunity[] = [...communitySet].map((id) => ({
    id,
    label: `group-${id}`,
    color: COLORS[id % COLORS.length],
  }));

  return { nodes: vizNodes, edges: dedupedEdges, communities };
}

// ── HTML Template ──────────────────────────────────────────────────────

export function generateHtml(
  nodes: VizNode[],
  edges: VizEdge[],
  communities: VizCommunity[],
  layout: string,
  opts?: { highlightDepth?: number },
): string {
  const data = JSON.stringify({ nodes, edges, communities });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>trace-mcp Graph</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--graph-bg, #1a1a2e); color: #eee; overflow: hidden; }
  canvas { display: block; }
  #controls { position: fixed; top: 12px; left: 12px; z-index: 10; display: flex; gap: 8px; align-items: center; }
  #controls select, #controls input, #controls button {
    background: #16213e; border: 1px solid #0f3460; color: #eee; padding: 6px 10px; border-radius: 4px; font-size: 13px;
  }
  #controls input { width: 200px; }
  #controls button:hover { background: #0f3460; cursor: pointer; }
  #stats { position: fixed; bottom: 12px; left: 12px; z-index: 10; font-size: 12px; color: #888; }
  .tooltip {
    position: fixed; background: #16213e; color: #eee; padding: 10px 14px; border-radius: 6px;
    font-size: 12px; pointer-events: none; border: 1px solid #0f3460; max-width: 300px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4); display: none; z-index: 20;
  }
  .tooltip strong { color: #e94560; }
  #minimap {
    position: fixed; bottom: 12px; right: 12px; z-index: 10;
    border: 1px solid #0f3460; border-radius: 6px;
    cursor: pointer;
    box-shadow: 0 2px 12px rgba(0,0,0,0.4);
  }
</style>
</head>
<body>
<div id="controls">
  <select id="colorBy">
    <option value="neutral">Color: Neutral</option>
    <option value="community">Color: Community</option>
    <option value="language">Color: Language</option>
    <option value="framework_role">Color: Role</option>
  </select>
  <input id="search" type="text" placeholder="Filter nodes\u2026">
  <button id="export-mermaid">Export Mermaid</button>
</div>
<div id="stats"></div>
<div id="tooltip" class="tooltip"></div>
<canvas id="graph"></canvas>
<canvas id="minimap" width="200" height="140"></canvas>
<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
const DATA = ${data};
const LAYOUT = ${JSON.stringify(layout)};
const N = DATA.nodes.length;
// Send stats to parent iframe host (Electron app reads these)
if (window.parent !== window) {
  window.parent.postMessage({ type: 'graphStats', nodes: DATA.nodes.length, edges: DATA.edges.length, communities: DATA.communities.length }, '*');
}
let THEME = new URLSearchParams(window.location.search).get('theme') || 'dark';
let IS_LIGHT = THEME === 'light';

function applyTheme(t) {
  THEME = t; IS_LIGHT = t === 'light';
  TH.bg = IS_LIGHT ? '#f0f0f0' : '#1a1a2e';
  TH.text = IS_LIGHT ? '#222' : '#dde';
  TH.labelShadow = IS_LIGHT ? 'rgba(255,255,255,0.8)' : '#0d0d1a';
  TH.edge = IS_LIGHT ? '#999' : '#556';
  TH.edgeAlpha = IS_LIGHT ? 0.25 : 0.18;
  TH.hullAlpha = IS_LIGHT ? 0.08 : 0.06;
  TH.groupLabel = IS_LIGHT ? '#333' : '#eee';
  TH.groupLabelShadow = IS_LIGHT ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.7)';
  TH.groupLabelAlpha = IS_LIGHT ? 0.6 : 0.5;
  TH.nodeBorder = IS_LIGHT ? 'rgba(0,0,0,' : 'rgba(255,255,255,';
  TH.nodeBorderHover = IS_LIGHT ? 0.7 : 0.95;
  TH.nodeBorderNormal = IS_LIGHT ? 0.25 : 0.4;
  document.body.style.background = TH.bg;
  if (typeof scheduleFrame === 'function') scheduleFrame();
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  applyTheme(e.matches ? 'dark' : 'light');
});
// Theme-aware palette
let TH = {
  bg: IS_LIGHT ? '#f0f0f0' : '#1a1a2e',
  text: IS_LIGHT ? '#222' : '#dde',
  textDim: IS_LIGHT ? '#666' : '#888',
  labelShadow: IS_LIGHT ? 'rgba(255,255,255,0.8)' : '#0d0d1a',
  edge: IS_LIGHT ? '#999' : '#556',
  edgeAlpha: IS_LIGHT ? 0.25 : 0.18,
  hullAlpha: IS_LIGHT ? 0.08 : 0.06,
  groupLabel: IS_LIGHT ? '#333' : '#eee',
  groupLabelShadow: IS_LIGHT ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.7)',
  groupLabelAlpha: IS_LIGHT ? 0.6 : 0.5,
  nodeBorder: IS_LIGHT ? 'rgba(0,0,0,' : 'rgba(255,255,255,',
  nodeBorderHover: IS_LIGHT ? 0.7 : 0.95,
  nodeBorderNormal: IS_LIGHT ? 0.25 : 0.4,
};
const canvas = document.getElementById('graph');
const ctx = canvas.getContext('2d');
const dpr = window.devicePixelRatio || 1;
let W = window.innerWidth, H = window.innerHeight;
if (IS_LIGHT) document.body.style.background = '#f0f0f0';

function resize() {
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scheduleFrame();
}
window.addEventListener('resize', resize);

// --- Color ---
const comColors = new Map(); DATA.communities.forEach(c => comColors.set(c.id, c.color));
const langScale = d3.scaleOrdinal(d3.schemeTableau10);
const roleScale = d3.scaleOrdinal(d3.schemePastel1);
let colorMode = 'neutral';

// Viewport-relative importance — recomputed each frame
let visMinImp = 0, visMaxImp = 1;

function lerpColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function nodeColor(d) {
  if (colorMode === 'language') return langScale(d.language || 'unknown');
  if (colorMode === 'framework_role') return roleScale(d.framework_role || 'none');
  if (colorMode === 'community') return comColors.get(d.community) || '#4e79a7';
  return IS_LIGHT ? '#7C7C85' : '#A0A0AB';
}

// Parse color string to [r,g,b]
function hexToRgb(color) {
  if (color.startsWith('rgb')) {
    const m = color.match(/\\d+/g);
    return m ? [+m[0], +m[1], +m[2]] : [128, 128, 128];
  }
  const c = parseInt(color.slice(1), 16);
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}

// Pre-compute
DATA.nodes.forEach(d => {
  d._r = 3 + d.importance * 10; // base radius, overridden per-frame by viewport importance
  d._alpha = 1;        // animated alpha (current)
  d._targetAlpha = 1;  // target alpha
});

// --- Build adjacency ---
const adjSet = new Map();
DATA.nodes.forEach(d => adjSet.set(d.id, new Set()));
DATA.edges.forEach(e => {
  const si = typeof e.source === 'object' ? e.source.id : e.source;
  const ti = typeof e.target === 'object' ? e.target.id : e.target;
  adjSet.get(si)?.add(ti); adjSet.get(ti)?.add(si);
});

// BFS to collect neighbors at N levels deep — returns Map<nodeId, depthLevel>
let highlightDepth = ${opts?.highlightDepth ?? 1};
function getNeighborsAtDepth(startId, maxDepth) {
  const depthMap = new Map(); // nodeId → depth level (1-based)
  let frontier = new Set([startId]);
  for (let d = 1; d <= maxDepth && frontier.size > 0; d++) {
    const next = new Set();
    for (const id of frontier) {
      const neighbors = adjSet.get(id);
      if (!neighbors) continue;
      for (const n of neighbors) {
        if (!depthMap.has(n) && n !== startId) {
          depthMap.set(n, d);
          next.add(n);
        }
      }
    }
    frontier = next;
  }
  return depthMap;
}

// ═══ Directory spatial clustering ═══
function getDirGroup(id) {
  const parts = id.split('/');
  if (parts.length <= 2) return parts[0] || '.';
  return parts.slice(0, 2).join('/');
}
const dirGroupMap = new Map();
const dirGroupNodes = new Map();
DATA.nodes.forEach(n => {
  const key = getDirGroup(n.id);
  dirGroupMap.set(n.id, key);
  if (!dirGroupNodes.has(key)) dirGroupNodes.set(key, []);
  dirGroupNodes.get(key).push(n);
});

// Assign a color to each dir group
const dirGroupColors = new Map();
const DG_PALETTE = ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948','#b07aa1','#ff9da7','#9c755f','#bab0ac','#86bcb6','#8cd17d'];
let dgi = 0;
for (const key of dirGroupNodes.keys()) {
  dirGroupColors.set(key, DG_PALETTE[dgi % DG_PALETTE.length]);
  dgi++;
}

// Custom clustering force — attracts same-dir nodes toward their centroid
function forceCluster(strength) {
  let nodes;
  function force(alpha) {
    const centroids = new Map();
    for (const [key, members] of dirGroupNodes) {
      let cx = 0, cy = 0;
      for (const n of members) { cx += n.x; cy += n.y; }
      centroids.set(key, { x: cx / members.length, y: cy / members.length });
    }
    for (const n of nodes) {
      const c = centroids.get(dirGroupMap.get(n.id));
      if (c) {
        n.vx += (c.x - n.x) * alpha * strength;
        n.vy += (c.y - n.y) * alpha * strength;
      }
    }
  }
  force.initialize = (_) => { nodes = _; };
  return force;
}

// --- Force simulation ---
const sim = d3.forceSimulation(DATA.nodes)
  .force('link', d3.forceLink(DATA.edges).id(d => d.id).distance(N > 5000 ? 30 : 60).strength(N > 5000 ? 0.1 : 0.3))
  .force('charge', d3.forceManyBody().strength(N > 5000 ? -30 : N > 1000 ? -80 : -200).theta(N > 5000 ? 1.5 : 0.9))
  .force('center', d3.forceCenter(W / 2, H / 2))
  .force('cluster', forceCluster(0.35))
  .alphaDecay(N > 5000 ? 0.05 : 0.0228)
  .velocityDecay(N > 5000 ? 0.6 : 0.4)
  .stop();

const preTicks = Math.min(300, Math.max(50, Math.ceil(Math.log(N + 1) * 40)));
let ticksDone = 0;
const TICK_BATCH = N > 5000 ? 5 : 15;
let layoutDone = false;
let frameRequested = false;
(function tickBatch() {
  const t0 = performance.now();
  while (ticksDone < preTicks && performance.now() - t0 < 12) { sim.tick(); ticksDone++; }
  scheduleFrame();
  if (ticksDone < preTicks) {
    document.getElementById('stats').textContent = 'Laying out… ' + Math.round(ticksDone / preTicks * 100) + '%';
    setTimeout(tickBatch, 0);
  } else {
    layoutDone = true;
    sim.on('tick', scheduleFrame);
    document.getElementById('stats').textContent = N + ' nodes, ' + DATA.edges.length + ' edges, '
      + DATA.communities.length + ' communities, ' + dirGroupNodes.size + ' groups';
  }
})();

// --- Transform ---
let tx = 0, ty = 0, tk = 1;

// --- Quadtree + spatial structures ---
let qtree = null;
let positionsDirty = true;

// Spatial hash grid for viewport culling — O(visible) instead of O(all)
const CELL_SIZE = 200;
let spatialGrid = new Map();
function rebuildSpatialGrid() {
  spatialGrid = new Map();
  for (const d of DATA.nodes) {
    if (d.x == null) continue;
    const key = (Math.floor(d.x / CELL_SIZE)) + ',' + (Math.floor(d.y / CELL_SIZE));
    let cell = spatialGrid.get(key);
    if (!cell) { cell = []; spatialGrid.set(key, cell); }
    cell.push(d);
  }
}
function getVisibleNodes(vx0, vy0, vx1, vy1, pad) {
  const cx0 = Math.floor((vx0 - pad) / CELL_SIZE);
  const cy0 = Math.floor((vy0 - pad) / CELL_SIZE);
  const cx1 = Math.floor((vx1 + pad) / CELL_SIZE);
  const cy1 = Math.floor((vy1 + pad) / CELL_SIZE);
  const result = [];
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cy = cy0; cy <= cy1; cy++) {
      const cell = spatialGrid.get(cx + ',' + cy);
      if (cell) for (let i = 0; i < cell.length; i++) result.push(cell[i]);
    }
  }
  return result;
}

// Edge spatial index — bucket edges by source cell for fast viewport culling
let edgeBuckets = new Map();
function rebuildEdgeBuckets() {
  edgeBuckets = new Map();
  for (const e of DATA.edges) {
    const s = e.source, t = e.target;
    if (s.x == null || t.x == null) continue;
    const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
    const key = (Math.floor(mx / CELL_SIZE)) + ',' + (Math.floor(my / CELL_SIZE));
    let bucket = edgeBuckets.get(key);
    if (!bucket) { bucket = []; edgeBuckets.set(key, bucket); }
    bucket.push(e);
  }
}
function getVisibleEdges(vx0, vy0, vx1, vy1, pad) {
  const cx0 = Math.floor((vx0 - pad) / CELL_SIZE) - 1;
  const cy0 = Math.floor((vy0 - pad) / CELL_SIZE) - 1;
  const cx1 = Math.floor((vx1 + pad) / CELL_SIZE) + 1;
  const cy1 = Math.floor((vy1 + pad) / CELL_SIZE) + 1;
  const result = [];
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cy = cy0; cy <= cy1; cy++) {
      const bucket = edgeBuckets.get(cx + ',' + cy);
      if (bucket) for (let i = 0; i < bucket.length; i++) result.push(bucket[i]);
    }
  }
  return result;
}

// Hull cache — only recompute when positions change
let cachedHulls = new Map();
function rebuildHullCache() {
  cachedHulls = new Map();
  for (const [key, members] of dirGroupNodes) {
    if (members.length < 3) continue;
    const mainHull = computeHull(members, 25);
    const miniHull = computeHull(members, 15);
    if (mainHull) cachedHulls.set(key, { main: mainHull, mini: miniHull });
  }
}

// LOD: community aggregates for zoomed-out rendering
const LOD_THRESHOLD = N > 5000 ? 0.25 : 0.12;
const communityAgg = new Map();
for (const c of DATA.communities) {
  communityAgg.set(c.id, { id: c.id, color: c.color, label: c.label, nodes: [], cx: 0, cy: 0, r: 0 });
}
for (const d of DATA.nodes) {
  const agg = communityAgg.get(d.community);
  if (agg) agg.nodes.push(d);
}
function updateCommunityAgg() {
  for (const [, agg] of communityAgg) {
    if (agg.nodes.length === 0) continue;
    let cx = 0, cy = 0;
    for (const n of agg.nodes) { cx += n.x || 0; cy += n.y || 0; }
    agg.cx = cx / agg.nodes.length;
    agg.cy = cy / agg.nodes.length;
    agg.r = Math.sqrt(agg.nodes.length) * 3 + 5;
  }
}

// Aggregated inter-community edges for LOD
let communityEdges = null;
function buildCommunityEdges() {
  const map = new Map();
  for (const e of DATA.edges) {
    const sc = (e.source.community ?? e.source), tc = (e.target.community ?? e.target);
    if (typeof sc !== 'number' || typeof tc !== 'number' || sc === tc) continue;
    const key = Math.min(sc, tc) + ':' + Math.max(sc, tc);
    map.set(key, (map.get(key) || 0) + 1);
  }
  communityEdges = [];
  for (const [key, weight] of map) {
    const [a, b] = key.split(':').map(Number);
    const aggA = communityAgg.get(a), aggB = communityAgg.get(b);
    if (aggA && aggB) communityEdges.push({ a: aggA, b: aggB, weight });
  }
}

function rebuildQuadtree() {
  qtree = d3.quadtree(DATA.nodes, d => d.x, d => d.y);
  positionsDirty = true;
}

// --- Animation ---
let highlightId = null;
let highlightSet = null;
let hoveredNode = null;
let searchQ = '';
let animating = false;

function scheduleFrame() {
  if (!frameRequested) { frameRequested = true; requestAnimationFrame(frame); }
}

let mmCounter = 0;
function frame() {
  frameRequested = false;
  // Rebuild spatial structures only when positions changed
  if (positionsDirty) {
    rebuildSpatialGrid();
    rebuildEdgeBuckets();
    rebuildHullCache();
    updateCommunityAgg();
    if (layoutDone && !communityEdges) buildCommunityEdges();
    positionsDirty = false;
  }
  updateAlphas();
  draw();
  // Minimap: every 5th frame during simulation, always when idle
  if (++mmCounter % 5 === 0 || sim.alpha() <= sim.alphaMin()) drawMinimap();
  if (animating || sim.alpha() > sim.alphaMin()) scheduleFrame();
}

function updateAlphas() {
  const dimSearch = searchQ.length > 0;
  // Fast path: nothing to dim — skip entire iteration
  if (!highlightId && !dimSearch && !animating) return;
  animating = false;
  const speed = 0.15;
  for (const d of DATA.nodes) {
    let target = 1;
    if (highlightId) {
      if (d.id === highlightId) target = 1;
      else if (highlightSet?.has(d.id)) {
        const nd = highlightSet.get(d.id) ?? 1;
        target = Math.max(0.3, 1 - nd * 0.1);
      } else target = 0.06;
    } else if (dimSearch) {
      target = (d.label.toLowerCase().includes(searchQ) || d.id.toLowerCase().includes(searchQ)) ? 1 : 0.06;
    }
    d._targetAlpha = target;
    if (Math.abs(d._alpha - target) > 0.01) {
      d._alpha += (target - d._alpha) * speed;
      animating = true;
    } else {
      d._alpha = target;
    }
  }
}

// --- Hull computation ---
function computeHull(nodes, padding) {
  if (nodes.length < 3) return null;
  const pts = nodes.filter(n => n.x != null).map(n => [n.x, n.y]);
  if (pts.length < 3) return null;
  const hull = d3.polygonHull(pts);
  if (!hull) return null;
  // Expand outward from centroid
  let cx = 0, cy = 0;
  for (const [hx, hy] of hull) { cx += hx; cy += hy; }
  cx /= hull.length; cy /= hull.length;
  return hull.map(([hx, hy]) => {
    const dx = hx - cx, dy = hy - cy;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    return [hx + dx / len * padding, hy + dy / len * padding];
  });
}

function drawSmoothHull(hull, fillColor, alpha) {
  if (!hull || hull.length < 3) return;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = fillColor;
  ctx.beginPath();
  const n = hull.length;
  const mx = (a, b) => (a[0] + b[0]) / 2;
  const my = (a, b) => (a[1] + b[1]) / 2;
  ctx.moveTo(mx(hull[n - 1], hull[0]), my(hull[n - 1], hull[0]));
  for (let i = 0; i < n; i++) {
    const next = [(hull[i][0] + hull[(i + 1) % n][0]) / 2, (hull[i][1] + hull[(i + 1) % n][1]) / 2];
    ctx.quadraticCurveTo(hull[i][0], hull[i][1], next[0], next[1]);
  }
  ctx.closePath();
  ctx.fill();
  // Subtle border
  ctx.globalAlpha = alpha * 0.6;
  ctx.strokeStyle = fillColor;
  ctx.lineWidth = 1.5 / tk;
  ctx.stroke();
}

function draw() {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.translate(tx, ty);
  ctx.scale(tk, tk);

  const vx0 = -tx / tk, vy0 = -ty / tk;
  const vx1 = (W - tx) / tk, vy1 = (H - ty) / tk;
  const pad = 60 / tk;
  const isHigh = N > 3000;

  // ── LOD: at low zoom, draw community aggregates instead of individual nodes ──
  const useLOD = tk < LOD_THRESHOLD && !highlightId && N > 2000;

  if (useLOD) {
    // Draw community hulls from cache
    for (const [key, cached] of cachedHulls) {
      const color = dirGroupColors.get(key) || '#4e79a7';
      drawSmoothHull(cached.main, color, TH.hullAlpha);
    }
    // Draw aggregated inter-community edges
    if (communityEdges) {
      ctx.lineCap = 'round';
      ctx.strokeStyle = TH.edge;
      ctx.beginPath();
      for (const ce of communityEdges) {
        const a = ce.a, b = ce.b;
        if (a.cx < vx0 - 200 && b.cx < vx0 - 200) continue;
        if (a.cx > vx1 + 200 && b.cx > vx1 + 200) continue;
        ctx.globalAlpha = Math.min(0.5, TH.edgeAlpha + ce.weight * 0.01);
        ctx.lineWidth = Math.min(4, 0.5 + ce.weight * 0.15) / tk;
        ctx.moveTo(a.cx, a.cy);
        ctx.lineTo(b.cx, b.cy);
      }
      ctx.stroke();
    }
    // Draw community aggregates as circles
    for (const [, agg] of communityAgg) {
      if (agg.nodes.length === 0) continue;
      if (agg.cx < vx0 - agg.r || agg.cx > vx1 + agg.r || agg.cy < vy0 - agg.r || agg.cy > vy1 + agg.r) continue;
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = agg.color;
      ctx.beginPath();
      ctx.arc(agg.cx, agg.cy, agg.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = IS_LIGHT ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 1 / tk;
      ctx.stroke();
      // Label
      const fs = Math.max(6, Math.min(14, agg.r * 0.6)) / tk;
      ctx.font = '600 ' + fs + 'px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = TH.text;
      ctx.textAlign = 'center';
      ctx.fillText(agg.nodes.length + '', agg.cx, agg.cy + fs * 0.35);
    }
    ctx.textAlign = 'start';
    ctx.restore();
    rebuildQuadtree();
    return;
  }

  // ── Normal rendering (zoomed in enough) ──
  // Use spatial grid for visible nodes — O(visible) not O(all)
  const visible = getVisibleNodes(vx0, vy0, vx1, vy1, pad);

  // Viewport-relative importance from visible nodes only
  visMinImp = 1; visMaxImp = 0;
  for (let i = 0; i < visible.length; i++) {
    const d = visible[i];
    if (d.importance < visMinImp) visMinImp = d.importance;
    if (d.importance > visMaxImp) visMaxImp = d.importance;
  }

  // ── Directory hulls (from cache) ──
  for (const [key, cached] of cachedHulls) {
    const color = dirGroupColors.get(key) || '#4e79a7';
    drawSmoothHull(cached.main, color, TH.hullAlpha);
  }

  // ── Directory labels (zoom-dependent, readable) ──
  ctx.textAlign = 'center';
  for (const [key, members] of dirGroupNodes) {
    if (members.length < 2) continue;
    const minZoom = members.length > 20 ? 0.1 : members.length > 8 ? 0.3 : 0.6;
    const maxZoom = members.length > 20 ? 1.5 : members.length > 8 ? 2.5 : 3.5;
    if (tk < minZoom || tk > maxZoom) continue;
    let cx = 0, cy = 0;
    for (const n of members) { cx += n.x; cy += n.y; }
    cx /= members.length; cy /= members.length;
    if (cx < vx0 - 100 || cx > vx1 + 100 || cy < vy0 - 100 || cy > vy1 + 100) continue;
    const dirLabel = key.replace(/\\//g, ' / ') + ' (' + members.length + ')';
    const fontSize = Math.max(8, Math.min(13, 10 / tk));
    const fs = fontSize / tk;
    ctx.font = '600 ' + fs + 'px -apple-system, BlinkMacSystemFont, sans-serif';
    const ly = cy - 20 / tk;
    ctx.globalAlpha = TH.groupLabelAlpha * 0.7;
    ctx.fillStyle = TH.groupLabelShadow;
    ctx.fillText(dirLabel, cx + 1.2 / tk, ly + 1.2 / tk);
    ctx.globalAlpha = TH.groupLabelAlpha;
    ctx.fillStyle = TH.groupLabel;
    ctx.fillText(dirLabel, cx, ly);
  }

  // ── Edges — use spatial buckets ──
  ctx.lineCap = 'round';
  ctx.globalAlpha = highlightId ? 0.03 : TH.edgeAlpha;
  ctx.strokeStyle = TH.edge;
  ctx.lineWidth = (isHigh ? 0.4 : 0.8) / tk;
  ctx.beginPath();
  const visibleEdges = getVisibleEdges(vx0, vy0, vx1, vy1, pad);
  for (let i = 0; i < visibleEdges.length; i++) {
    const e = visibleEdges[i];
    const s = e.source, t = e.target;
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(t.x, t.y);
  }
  ctx.stroke();

  // Highlighted edges — draw all edges in the highlight subgraph, colored by depth
  if (highlightId && highlightSet) {
    const depthColors = ['#ff2050', '#ff8c00', '#ffe000', '#00e050', '#00c8ff', '#6060ff', '#c040ff', '#ff40a0', '#ff6060', '#aaaaaa'];
    // Group edges by max depth of their endpoints
    const edgesByDepth = new Map();
    for (const e of DATA.edges) {
      const si = e.source.id ?? e.source, ti = e.target.id ?? e.target;
      // Both ends must be in highlight set or be the root
      const sInSet = si === highlightId || highlightSet.has(si);
      const tInSet = ti === highlightId || highlightSet.has(ti);
      if (!sInSet || !tInSet) continue;
      const sDepth = si === highlightId ? 0 : (highlightSet.get(si) ?? 99);
      const tDepth = ti === highlightId ? 0 : (highlightSet.get(ti) ?? 99);
      const edgeDepth = Math.max(sDepth, tDepth);
      if (!edgesByDepth.has(edgeDepth)) edgesByDepth.set(edgeDepth, []);
      edgesByDepth.get(edgeDepth).push(e);
    }
    // Draw deeper edges first (behind), closer edges on top
    const depths = [...edgesByDepth.keys()].sort((a, b) => b - a);
    for (const d of depths) {
      const color = depthColors[Math.min(d, depthColors.length - 1)];
      const alpha = Math.max(0.15, 0.9 - d * 0.12);
      const width = Math.max(0.8, 3.5 - d * 0.4);
      // Glow pass
      ctx.globalAlpha = alpha * 0.35;
      ctx.strokeStyle = color;
      ctx.lineWidth = (width + 2.5) / tk;
      ctx.beginPath();
      for (const e of edgesByDepth.get(d)) {
        ctx.moveTo(e.source.x, e.source.y);
        ctx.lineTo(e.target.x, e.target.y);
      }
      ctx.stroke();
      // Core pass
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width / tk;
      ctx.stroke();
    }
  }

  // ── Nodes ──
  const labelFontSize = Math.max(8, Math.min(12, 10 / tk));
  const labelCandidates = [];
  ctx.textAlign = 'center';

  for (let vi = 0; vi < visible.length; vi++) {
    const d = visible[vi];
    if (d.x == null) continue;

    // Absolute importance → radius (stable, no viewport distortion)
    const r = 3 + d.importance * 8;
    d._r = r;
    // Viewport-relative normImp for labels only
    const visRange = visMaxImp - visMinImp || 0.01;
    const normImp = Math.max(0, Math.min(1, (d.importance - visMinImp) / visRange));
    const a = d._alpha;
    const isHovered = d === hoveredNode;
    const isHighlighted = highlightId && d.id === highlightId;
    const color = nodeColor(d);
    const [cr, cg, cb] = hexToRgb(color);

    // Hover/highlight — macOS accent ring
    if ((isHovered || isHighlighted) && a > 0.5) {
      ctx.globalAlpha = 0.6 * a;
      ctx.strokeStyle = IS_LIGHT ? '#007AFF' : '#0A84FF';
      ctx.lineWidth = 2 / tk;
      ctx.beginPath();
      ctx.arc(d.x, d.y, r + 2.5 / tk, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Solid flat fill
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + a + ')';
    ctx.beginPath();
    ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
    ctx.fill();

    // 0.5px border — slightly lighter/darker for definition
    ctx.globalAlpha = 0.3 * a;
    ctx.strokeStyle = IS_LIGHT ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 0.5 / tk;
    ctx.stroke();

    // Collect label candidates (drawn in second pass)
    const labelZoomThreshold = 0.15 + (1 - normImp) * 1.8;
    const showThisLabel = tk > labelZoomThreshold || isHovered || isHighlighted;
    if (showThisLabel && a > 0.3) {
      const fontSize = (isHovered ? labelFontSize + 2 : labelFontSize) / tk;
      ctx.font = '500 ' + fontSize + 'px -apple-system, BlinkMacSystemFont, sans-serif';
      const tw = ctx.measureText(d.label).width;
      const labelY = d.y + r + fontSize + 2 / tk;
      labelCandidates.push({
        d, label: d.label, x: d.x, y: labelY, w: tw, h: fontSize,
        importance: d.importance, isHovered, isHighlighted, a, fontSize,
      });
    }
  }

  // ── Label collision avoidance ──
  // Sort: hovered/highlighted first, then by importance desc
  labelCandidates.sort((a, b) => {
    if (a.isHovered || a.isHighlighted) return -1;
    if (b.isHovered || b.isHighlighted) return 1;
    return b.importance - a.importance;
  });
  const placedBoxes = [];
  const PAD_X = 4 / tk, PAD_Y = 2 / tk;
  for (const lc of labelCandidates) {
    const bx = lc.x - lc.w / 2 - PAD_X;
    const by = lc.y - lc.h - PAD_Y;
    const bw = lc.w + PAD_X * 2;
    const bh = lc.h + PAD_Y * 2;
    // Check overlap with already placed labels
    let overlaps = false;
    for (const pb of placedBoxes) {
      if (bx < pb.x + pb.w && bx + bw > pb.x && by < pb.y + pb.h && by + bh > pb.y) {
        overlaps = true; break;
      }
    }
    if (overlaps && !lc.isHovered && !lc.isHighlighted) continue;
    placedBoxes.push({ x: bx, y: by, w: bw, h: bh });
    // Draw label
    ctx.font = '500 ' + lc.fontSize + 'px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.globalAlpha = lc.a * 0.6;
    ctx.fillStyle = TH.labelShadow;
    ctx.fillText(lc.label, lc.x + 0.7 / tk, lc.y + 0.7 / tk);
    ctx.globalAlpha = lc.a * (lc.isHovered ? 1 : 0.85);
    ctx.fillStyle = lc.isHovered ? (IS_LIGHT ? '#000' : '#fff') : TH.text;
    ctx.fillText(lc.label, lc.x, lc.y);
  }

  ctx.textAlign = 'start';
  ctx.restore();
  rebuildQuadtree();
}

// ── Minimap ──
const mmCanvas = document.getElementById('minimap');
const mmCtx = mmCanvas.getContext('2d');
const MM_W = 200, MM_H = 140;
let mmBounds = { minX: 0, maxX: 1, minY: 0, maxY: 1, scale: 1, offX: 0, offY: 0 };

function drawMinimap() {
  mmCtx.fillStyle = IS_LIGHT ? 'rgba(240,240,240,0.9)' : 'rgba(26,26,46,0.9)';
  mmCtx.fillRect(0, 0, MM_W, MM_H);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of DATA.nodes) {
    if (n.x != null) {
      if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
    }
  }
  const p = 40;
  minX -= p; minY -= p; maxX += p; maxY += p;
  const ww = maxX - minX || 1, wh = maxY - minY || 1;
  const sc = Math.min(MM_W / ww, MM_H / wh);
  const ox = (MM_W - ww * sc) / 2, oy = (MM_H - wh * sc) / 2;
  mmBounds = { minX, maxX, minY, maxY, scale: sc, offX: ox, offY: oy };

  // Hull backgrounds on minimap (from cache)
  for (const [key, cached] of cachedHulls) {
    const hull = cached.mini;
    if (!hull) continue;
    mmCtx.globalAlpha = 0.15;
    mmCtx.fillStyle = dirGroupColors.get(key) || '#4e79a7';
    mmCtx.beginPath();
    for (let i = 0; i < hull.length; i++) {
      const sx = (hull[i][0] - minX) * sc + ox;
      const sy = (hull[i][1] - minY) * sc + oy;
      if (i === 0) mmCtx.moveTo(sx, sy); else mmCtx.lineTo(sx, sy);
    }
    mmCtx.closePath();
    mmCtx.fill();
  }

  // Nodes as dots
  for (const n of DATA.nodes) {
    if (n.x == null) continue;
    const sx = (n.x - minX) * sc + ox;
    const sy = (n.y - minY) * sc + oy;
    mmCtx.fillStyle = nodeColor(n);
    mmCtx.globalAlpha = 0.7;
    mmCtx.fillRect(sx - 0.8, sy - 0.8, 1.6, 1.6);
  }

  // Viewport rectangle
  const vx = (-tx / tk - minX) * sc + ox;
  const vy = (-ty / tk - minY) * sc + oy;
  const vw = (W / tk) * sc;
  const vh = (H / tk) * sc;
  mmCtx.globalAlpha = 0.15;
  mmCtx.fillStyle = '#fff';
  mmCtx.fillRect(vx, vy, vw, vh);
  mmCtx.globalAlpha = 0.8;
  mmCtx.strokeStyle = '#e94560';
  mmCtx.lineWidth = 1.5;
  mmCtx.strokeRect(vx, vy, vw, vh);
}

// Minimap click → navigate
mmCanvas.addEventListener('click', (e) => {
  const rect = mmCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const b = mmBounds;
  const wx = (mx - b.offX) / b.scale + b.minX;
  const wy = (my - b.offY) / b.scale + b.minY;
  const nt = d3.zoomIdentity.translate(W / 2 - wx * tk, H / 2 - wy * tk).scale(tk);
  d3.select(canvas).transition().duration(300).call(zoomBehavior.transform, nt);
});

// --- Zoom & Pan (native macOS trackpad gestures) ---
const zoomBehavior = d3.zoom()
  .scaleExtent([0.02, 20])
  .filter((e) => {
    // Block wheel events from D3 — we handle them manually below
    // to separate two-finger scroll (pan) from pinch (zoom)
    if (e.type === 'wheel') return false;
    // Allow everything else (drag, dblclick, etc.) with default filter logic
    return !e.ctrlKey && !e.button;
  })
  .on('zoom', (e) => {
    tx = e.transform.x; ty = e.transform.y; tk = e.transform.k;
    scheduleFrame();
  });
d3.select(canvas).call(zoomBehavior);

// Custom wheel: pinch (ctrlKey) → zoom, two-finger scroll → pan
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const sel = d3.select(canvas);
  const t = d3.zoomTransform(canvas);
  if (e.ctrlKey) {
    // Pinch-to-zoom: browsers set ctrlKey for trackpad pinch gestures
    const factor = Math.pow(2, -e.deltaY * 0.01);
    const newK = Math.max(0.02, Math.min(20, t.k * factor));
    const r = newK / t.k;
    const px = e.offsetX, py = e.offsetY;
    const nt = d3.zoomIdentity
      .translate(px - r * (px - t.x), py - r * (py - t.y))
      .scale(newK);
    sel.call(zoomBehavior.transform, nt);
  } else {
    // Two-finger swipe → pan
    const nt = d3.zoomIdentity
      .translate(t.x - e.deltaX, t.y - e.deltaY)
      .scale(t.k);
    sel.call(zoomBehavior.transform, nt);
  }
}, { passive: false });

// --- Mouse ---
const tooltip = document.getElementById('tooltip');
let dragNode = null;
let wasDragged = false;

function worldCoords(e) {
  return [(e.offsetX - tx) / tk, (e.offsetY - ty) / tk];
}

function findNode(wx, wy) {
  if (!qtree) return null;
  let found = null, bestD = Infinity;
  qtree.visit((node, x0, y0, x1, y1) => {
    if (!node.length) {
      let d = node.data;
      do {
        const dx = wx - d.x, dy = wy - d.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < d._r + 5 && dist < bestD) { bestD = dist; found = d; }
      } while (d = d.next);
    }
    return x0 > wx + 25 || x1 < wx - 25 || y0 > wy + 25 || y1 < wy - 25;
  });
  return found;
}

canvas.addEventListener('mousemove', (e) => {
  if (dragNode) {
    const [wx, wy] = worldCoords(e);
    dragNode.fx = wx; dragNode.fy = wy;
    wasDragged = true;
    sim.alpha(0.1).restart();
    return;
  }
  const [wx, wy] = worldCoords(e);
  const n = findNode(wx, wy);
  if (n !== hoveredNode) {
    hoveredNode = n;
    canvas.style.cursor = n ? 'pointer' : 'default';
    if (n) {
      tooltip.style.display = 'block';
      const dirKey = dirGroupMap.get(n.id);
      tooltip.innerHTML = '<strong>' + esc(n.label) + '</strong><br>'
        + '<span style="color:#888">' + esc(n.id) + '</span><br>'
        + (n.repo ? '<span style="color:#76b7b2">Repo: ' + esc(n.repo) + '</span><br>' : '')
        + esc(n.type) + (n.language ? ' \u00b7 ' + esc(n.language) : '')
        + (n.framework_role ? ' \u00b7 ' + esc(n.framework_role) : '') + '<br>'
        + (dirKey ? '<span style="color:#76b7b2">' + esc(dirKey) + '</span> \u00b7 ' : '')
        + 'Community ' + n.community + ' \u00b7 Importance ' + n.importance;
    } else {
      tooltip.style.display = 'none';
    }
    scheduleFrame();
  }
  if (n) {
    tooltip.style.left = Math.min(e.clientX + 14, W - 280) + 'px';
    tooltip.style.top = Math.max(4, e.clientY - 14) + 'px';
  }
});

canvas.addEventListener('mousedown', (e) => {
  const [wx, wy] = worldCoords(e);
  const n = findNode(wx, wy);
  if (n) {
    e.stopPropagation();
    dragNode = n;
    wasDragged = false;
    n.fx = wx; n.fy = wy;
    sim.alphaTarget(0.3).restart();
    d3.select(canvas).on('.zoom', null);
  }
});

canvas.addEventListener('mouseup', () => {
  if (dragNode) {
    dragNode.fx = null; dragNode.fy = null;
    const wasDrag = wasDragged;
    dragNode = null;
    sim.alphaTarget(0);
    d3.select(canvas).call(zoomBehavior);
    if (wasDrag) return;
  }
});

canvas.addEventListener('click', (e) => {
  if (wasDragged) { wasDragged = false; return; }
  const [wx, wy] = worldCoords(e);
  const n = findNode(wx, wy);
  if (n) {
    highlightId = n.id;
    highlightSet = getNeighborsAtDepth(n.id, highlightDepth);
  } else {
    highlightId = null;
    highlightSet = null;
  }
  scheduleFrame();
});

canvas.addEventListener('mouseleave', () => {
  hoveredNode = null;
  tooltip.style.display = 'none';
  scheduleFrame();
});

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// --- Controls ---
document.getElementById('search').addEventListener('input', (e) => {
  searchQ = e.target.value.toLowerCase();
  scheduleFrame();
});

document.getElementById('colorBy').addEventListener('change', (e) => {
  colorMode = e.target.value;
  scheduleFrame();
});

document.getElementById('export-mermaid').addEventListener('click', () => {
  let md = 'graph LR\\n';
  const safe = (s) => s.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 40);
  DATA.edges.forEach(e => {
    const s = typeof e.source === 'object' ? e.source.id : e.source;
    const t = typeof e.target === 'object' ? e.target.id : e.target;
    md += '  ' + safe(s) + ' --> ' + safe(t) + '\\n';
  });
  navigator.clipboard.writeText(md).then(() => alert('Mermaid copied to clipboard'));
});

resize();

// --- postMessage API for parent iframe communication ---
window.addEventListener('message', (evt) => {
  if (!evt.data) return;
  if (evt.data.type === 'setHighlightDepth') {
    highlightDepth = evt.data.depth || 1;
    // Re-highlight current node with new depth
    if (highlightId) {
      highlightSet = getNeighborsAtDepth(highlightId, highlightDepth);
      scheduleFrame();
    }
    return;
  }
  if (evt.data.type !== 'focusNode') return;
  const fileId = evt.data.id;
  if (!fileId) return;
  // Find the node by id (exact or suffix match for file paths)
  const node = DATA.nodes.find(n => n.id === fileId)
    || DATA.nodes.find(n => n.id.endsWith('/' + fileId) || n.id.endsWith(fileId));
  if (!node || node.x == null) return;
  // Select it
  highlightId = node.id;
  highlightSet = getNeighborsAtDepth(node.id, highlightDepth);
  // Zoom to it
  const zoomK = 2.5;
  const nt = d3.zoomIdentity.translate(W / 2 - node.x * zoomK, H / 2 - node.y * zoomK).scale(zoomK);
  d3.select(canvas).transition().duration(600).call(zoomBehavior.transform, nt);
});
</script>
</body>
</html>`;
}

// ── Tool Entry Points ──────────────────────────────────────────────────

export function visualizeGraph(
  store: Store,
  opts: VisualizeGraphOptions,
): TraceMcpResult<VisualizeGraphResult> {
  const { nodes, edges, communities } = buildGraphData(store, opts);

  if (nodes.length === 0) {
    return err(validationError('No nodes found for the given scope. Try a broader scope or ensure the project is indexed.'));
  }

  const layout = opts.layout ?? 'force';
  const html = generateHtml(nodes, edges, communities, layout, { highlightDepth: opts.highlightDepth });
  const outputPath = opts.output ?? path.join(process.env.TMPDIR ?? '/tmp', 'trace-mcp-graph.html');

  fs.writeFileSync(outputPath, html, 'utf-8');

  return ok({
    outputPath,
    nodes: nodes.length,
    edges: edges.length,
    communities: communities.length,
  });
}

export function getDependencyDiagram(
  store: Store,
  opts: MermaidDiagramOptions,
): TraceMcpResult<MermaidDiagramResult> {
  const { nodes, edges } = buildGraphData(store, {
    scope: opts.scope,
    depth: opts.depth ?? 2,
  });

  const maxNodes = opts.maxNodes ?? 30;
  const format = opts.format ?? 'mermaid';

  // Trim to maxNodes by importance
  const sorted = [...nodes].sort((a, b) => b.importance - a.importance);
  const topNodes = sorted.slice(0, maxNodes);
  const nodeSet = new Set(topNodes.map((n) => n.id));
  const filteredEdges = edges.filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target));

  if (format === 'dot') {
    const lines = ['digraph G {', '  rankdir=LR;', '  node [shape=box, style=rounded];'];
    for (const n of topNodes) {
      const safeId = n.id.replace(/[^a-zA-Z0-9_]/g, '_');
      lines.push(`  ${safeId} [label="${n.label}"];`);
    }
    for (const e of filteredEdges) {
      const src = e.source.replace(/[^a-zA-Z0-9_]/g, '_');
      const tgt = e.target.replace(/[^a-zA-Z0-9_]/g, '_');
      lines.push(`  ${src} -> ${tgt} [label="${e.type}"];`);
    }
    lines.push('}');
    return ok({ diagram: lines.join('\n'), format: 'dot', nodes: topNodes.length, edges: filteredEdges.length });
  }

  // Mermaid
  const lines = ['graph LR'];
  const safeId = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 40);
  for (const n of topNodes) {
    lines.push(`  ${safeId(n.id)}[${n.label}]`);
  }
  for (const e of filteredEdges) {
    lines.push(`  ${safeId(e.source)} -->|${e.type}| ${safeId(e.target)}`);
  }

  return ok({
    diagram: lines.join('\n'),
    format: 'mermaid',
    nodes: topNodes.length,
    edges: filteredEdges.length,
  });
}
