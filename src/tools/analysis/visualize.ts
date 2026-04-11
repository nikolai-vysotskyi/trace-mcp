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
  maxFiles?: number;        // max seed files for file-level graph (default: 10000)
  maxNodes?: number;        // max viz nodes for symbol-level graph (default: 100000)
  topoStore?: TopologyStore; // federation topology store — when set, merges connected federated repos
  projectRoot?: string;      // current project root — used to scope federation to connected repos only
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
  repo?: string;  // set when merging federated repos
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

  // Federation: when scope='project' and topoStore is available, merge all federated repos
  if (scope === 'project' && opts.topoStore) {
    try {
      const fedResult = buildFederatedGraph(store, opts);
      if (fedResult) return fedResult;
    } catch (e) {
      logger.warn({ error: e }, 'Federation graph merge failed, falling back to single-project');
    }
  }

  return buildSingleProjectGraph(store, opts, scope, depth, granularity, hideIsolated);
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
    seedFiles = store.getAllFiles();
  } else {
    const allFiles = store.getAllFiles();
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
 * Federation-aware graph: only include repos that are directly connected
 * to the current project via cross-service edges in topology.
 */
function buildFederatedGraph(
  mainStore: Store,
  opts: VisualizeGraphOptions,
): { nodes: VizNode[]; edges: VizEdge[]; communities: VizCommunity[] } | null {
  const topoStore = opts.topoStore!;
  const projectRoot = opts.projectRoot;
  if (!projectRoot) return null;

  const allRepos = topoStore.getAllFederatedRepos();
  if (allRepos.length === 0) return null;

  // Auto-federation: only include repos whose root is a strict sub-directory
  // of the current project. Sibling/unrelated projects are never auto-included.
  // To federate unrelated repos, the user must explicitly configure it.
  const normalizedRoot = projectRoot.endsWith('/') ? projectRoot : projectRoot + '/';
  const repos = allRepos.filter((r) => r.repo_root.startsWith(normalizedRoot));

  if (repos.length === 0) return null; // no connected repos — skip federation

  const allNodes: VizNode[] = [];
  const allEdges: VizEdge[] = [];

  // Build graph for main project
  const mainResult = buildSingleProjectGraph(
    mainStore, opts, 'project', opts.depth ?? 2,
    opts.granularity ?? 'file', opts.hideIsolated === true,
  );

  const mainPrefix = currentRepo?.name ?? 'main';

  for (const n of mainResult.nodes) {
    n.repo = mainPrefix;
    allNodes.push(n);
  }
  allEdges.push(...mainResult.edges);

  // Build graph for each connected federated repo
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
      logger.warn({ repo: repo.name, error: e }, 'Failed to load federated repo for graph');
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
  const visitedNodes = new Set(allSeedNodeIds);
  let frontier = new Set(allSeedNodeIds);

  for (let d = 0; d < depth && frontier.size > 0; d++) {
    const nextFrontier = new Set<number>();
    const batchEdges = d === 0
      ? filteredEdges
      : store.getEdgesForNodesBatch([...frontier]);

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

  // 5. Build file-level viz nodes
  const vizNodeMap = new Map<string, VizNode>();
  for (const [, file] of allFilesById) {
    if (vizNodeMap.has(file.path)) continue;
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
  const allEdgesForGraph = store.getEdgesForNodesBatch([...visitedNodes]);
  const edgeMap = new Map<string, VizEdge>();

  for (const edge of allEdgesForGraph) {
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
  for (const [nodeId, ref] of fileNodeRefs) {
    if (ref.nodeType === 'file') {
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
  const vizNodes: VizNode[] = [];
  const fileIdToVizIds = new Map<number, string[]>();
  const symbolIdToVizId = new Map<number, string>(); // symbol DB id → symbol_id string

  for (const sym of symbolsById.values()) {
    const file = store.getFileById(sym.file_id);
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
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #eee; overflow: hidden; }
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
</style>
</head>
<body>
<div id="controls">
  <select id="colorBy">
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
<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
const DATA = ${data};
const LAYOUT = ${JSON.stringify(layout)};
const N = DATA.nodes.length;
const canvas = document.getElementById('graph');
const ctx = canvas.getContext('2d');
const dpr = window.devicePixelRatio || 1;
let W = window.innerWidth, H = window.innerHeight;

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
let colorMode = 'community';

function nodeColor(d) {
  if (colorMode === 'language') return langScale(d.language || 'unknown');
  if (colorMode === 'framework_role') return roleScale(d.framework_role || 'none');
  return comColors.get(d.community) || '#4e79a7';
}

// Parse hex to rgb for alpha blending
function hexToRgb(hex) {
  const c = parseInt(hex.slice(1), 16);
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}

// Pre-compute
DATA.nodes.forEach(d => {
  d._r = 3 + d.importance * 10;
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

// --- Force simulation ---
const sim = d3.forceSimulation(DATA.nodes)
  .force('link', d3.forceLink(DATA.edges).id(d => d.id).distance(N > 5000 ? 30 : 60).strength(N > 5000 ? 0.1 : 0.3))
  .force('charge', d3.forceManyBody().strength(N > 5000 ? -30 : N > 1000 ? -80 : -200).theta(N > 5000 ? 1.5 : 0.9))
  .force('center', d3.forceCenter(W / 2, H / 2))
  .alphaDecay(N > 5000 ? 0.05 : 0.0228)
  .velocityDecay(N > 5000 ? 0.6 : 0.4)
  .stop();

// Pre-settle: compute layout synchronously so there's no initial "explosion"
const preTicks = Math.min(300, Math.max(50, Math.ceil(Math.log(N + 1) * 40)));
for (let i = 0; i < preTicks; i++) sim.tick();

// Now enable live ticks only for drag interactions
sim.on('tick', scheduleFrame);

// --- Transform ---
let tx = 0, ty = 0, tk = 1;

// --- Quadtree ---
let qtree = null;
function rebuildQuadtree() {
  qtree = d3.quadtree(DATA.nodes, d => d.x, d => d.y);
}

// --- Animation ---
let highlightId = null;
let highlightSet = null;
let hoveredNode = null;
let searchQ = '';
let animating = false;
let frameRequested = false;

function scheduleFrame() {
  if (!frameRequested) { frameRequested = true; requestAnimationFrame(frame); }
}

function frame() {
  frameRequested = false;
  updateAlphas();
  draw();
  if (animating || sim.alpha() > sim.alphaMin()) scheduleFrame();
}

function updateAlphas() {
  const dimSearch = searchQ.length > 0;
  animating = false;
  const speed = 0.15; // lerp speed
  for (const d of DATA.nodes) {
    let target = 1;
    if (highlightId) {
      target = (d.id === highlightId || highlightSet?.has(d.id)) ? 1 : 0.06;
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

  // ── Edges ──
  // Background edges (dim)
  ctx.lineCap = 'round';
  ctx.globalAlpha = highlightId ? 0.03 : 0.18;
  ctx.strokeStyle = '#556';
  ctx.lineWidth = (isHigh ? 0.4 : 0.8) / tk;
  ctx.beginPath();
  for (const e of DATA.edges) {
    const s = e.source, t = e.target;
    if (s.x == null || t.x == null) continue;
    if (Math.max(s.x, t.x) < vx0 - pad || Math.min(s.x, t.x) > vx1 + pad ||
        Math.max(s.y, t.y) < vy0 - pad || Math.min(s.y, t.y) > vy1 + pad) continue;
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(t.x, t.y);
  }
  ctx.stroke();

  // Highlighted edges with glow
  if (highlightId && highlightSet) {
    // Glow layer
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = '#e94560';
    ctx.lineWidth = 4 / tk;
    ctx.beginPath();
    for (const e of DATA.edges) {
      const si = e.source.id ?? e.source, ti = e.target.id ?? e.target;
      if ((si === highlightId && highlightSet.has(ti)) || (ti === highlightId && highlightSet.has(si))) {
        ctx.moveTo(e.source.x, e.source.y);
        ctx.lineTo(e.target.x, e.target.y);
      }
    }
    ctx.stroke();
    // Core line
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1.5 / tk;
    ctx.stroke();
  }

  // ── Nodes ──
  const showLabels = tk > (isHigh ? 1.5 : N > 500 ? 0.6 : 0.3);
  const labelFontSize = Math.max(8, Math.min(12, 10 / tk));
  ctx.textAlign = 'center';

  for (const d of DATA.nodes) {
    if (d.x == null) continue;
    if (d.x < vx0 - pad || d.x > vx1 + pad || d.y < vy0 - pad || d.y > vy1 + pad) continue;

    const r = d._r;
    const a = d._alpha;
    const isHovered = d === hoveredNode;
    const isHighlighted = highlightId && d.id === highlightId;
    const color = nodeColor(d);
    const [cr, cg, cb] = hexToRgb(color);

    // Outer glow for hovered/highlighted
    if ((isHovered || isHighlighted) && a > 0.5) {
      ctx.globalAlpha = 0.35 * a;
      ctx.shadowColor = 'rgba(' + cr + ',' + cg + ',' + cb + ',0.9)';
      ctx.shadowBlur = 16 / tk;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(d.x, d.y, r + 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Node body — radial gradient for 3D look
    ctx.globalAlpha = a;
    if (!isHigh || a > 0.5) {
      const grad = ctx.createRadialGradient(d.x - r * 0.3, d.y - r * 0.3, r * 0.1, d.x, d.y, r);
      grad.addColorStop(0, 'rgba(' + Math.min(255, cr + 80) + ',' + Math.min(255, cg + 80) + ',' + Math.min(255, cb + 80) + ',' + a + ')');
      grad.addColorStop(0.7, 'rgba(' + cr + ',' + cg + ',' + cb + ',' + a + ')');
      grad.addColorStop(1, 'rgba(' + Math.max(0, cr - 30) + ',' + Math.max(0, cg - 30) + ',' + Math.max(0, cb - 30) + ',' + a + ')');
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = color;
    }
    ctx.beginPath();
    ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
    ctx.fill();

    // Border — white stroke
    ctx.strokeStyle = isHovered
      ? 'rgba(255,255,255,' + (0.95 * a) + ')'
      : 'rgba(255,255,255,' + (0.4 * a) + ')';
    ctx.lineWidth = (isHovered ? 2 : 1) / tk;
    ctx.stroke();

    // Label — centered below node
    if ((showLabels || isHovered || isHighlighted) && a > 0.3) {
      const fontSize = (isHovered ? labelFontSize + 2 : labelFontSize) / tk;
      ctx.font = '500 ' + fontSize + 'px -apple-system, BlinkMacSystemFont, sans-serif';
      const labelY = d.y + r + fontSize + 2 / tk;
      // Shadow for readability
      ctx.globalAlpha = a * 0.6;
      ctx.fillStyle = '#0d0d1a';
      ctx.fillText(d.label, d.x + 0.7 / tk, labelY + 0.7 / tk);
      // Text
      ctx.globalAlpha = a * (isHovered ? 1 : 0.9);
      ctx.fillStyle = isHovered ? '#fff' : '#dde';
      ctx.fillText(d.label, d.x, labelY);
    }
  }
  ctx.textAlign = 'start';

  ctx.restore();
  rebuildQuadtree();
}

// --- Zoom & Pan ---
const zoomBehavior = d3.zoom()
  .scaleExtent([0.02, 20])
  .on('zoom', (e) => {
    tx = e.transform.x; ty = e.transform.y; tk = e.transform.k;
    scheduleFrame();
  });
d3.select(canvas).call(zoomBehavior);

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
      tooltip.innerHTML = '<strong>' + esc(n.label) + '</strong><br>'
        + '<span style="color:#888">' + esc(n.id) + '</span><br>'
        + (n.repo ? '<span style="color:#76b7b2">Repo: ' + esc(n.repo) + '</span><br>' : '')
        + esc(n.type) + (n.language ? ' \u00b7 ' + esc(n.language) : '')
        + (n.framework_role ? ' \u00b7 ' + esc(n.framework_role) : '') + '<br>'
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
    if (wasDrag) return; // don't trigger click after drag
  }
});

canvas.addEventListener('click', (e) => {
  if (wasDragged) { wasDragged = false; return; }
  const [wx, wy] = worldCoords(e);
  const n = findNode(wx, wy);
  if (n) {
    highlightId = n.id;
    highlightSet = adjSet.get(n.id) || new Set();
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

document.getElementById('stats').textContent = N + ' nodes, ' + DATA.edges.length + ' edges, ' + DATA.communities.length + ' communities';

resize();
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
  const html = generateHtml(nodes, edges, communities, layout);
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
