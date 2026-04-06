import type { Store, SymbolRow } from '../../db/store.js';
import { ok, err, type TraceMcpResult } from '../../errors.js';
import { notFound } from '../../errors.js';
import { isGitRepo } from '../git/git-analysis.js';
import { execSync } from 'node:child_process';

// ─── Pennant (feature-flag) types ────────────────────────────────────────────

interface PennantUsageSite {
  filePath: string;
  line: number;
  usageType: string;
}

interface PennantImpactResult {
  featureName: string;
  definedIn: { filePath: string; line: number }[];
  checkedBy: PennantUsageSite[];
  gatedRoutes: { filePath: string; line: number }[];
}

// ─── Enriched dependent (per-file, deduped) ─────────────────────────────────

interface DependentSymbol {
  symbolId: string;
  symbolName: string;
  symbolKind: string;
  complexity?: number;
  isExported?: boolean;
}

interface EnrichedDependent {
  path: string;
  edgeTypes: string[];
  depth: number;
  hasTests?: boolean;
  symbols?: DependentSymbol[];
}

// ─── Grouped summaries ──────────────────────────────────────────────────────

interface ModuleImpact {
  module: string;
  count: number;
  files: string[];
  maxDepth: number;
  hasUntested: boolean;
}

interface CoChangeHidden {
  file: string;
  confidence: number;
  /** true if already in dependency graph, false = hidden coupling */
  inGraph: boolean;
}

interface ImpactSummary {
  totalFiles: number;
  totalSymbols: number;
  maxDepth: number;
  crossBoundary: boolean;
  publicApiAffected: number;
  untestedDependents: number;
  highComplexityDependents: number;
  sentence: string;
}

interface RiskSignals {
  score: number;
  level: 'low' | 'medium' | 'high' | 'critical';
  publicApiBreaking: boolean;
  untestedRatio: number;
  maxComplexity: number;
  mitigations: string[];
}

// ─── Breaking changes ────────────────────────────────────────────────────────

interface BreakingChange {
  symbolId: string;
  symbolName: string;
  kind: string;
  consumers: number;
  consumerFiles: string[];
}

// ─── Raw dependent (internal, before dedup) ─────────────────────────────────

interface RawDependent {
  path: string;
  symbolId?: string;
  symbolName?: string;
  symbolKind?: string;
  edgeType: string;
  depth: number;
  complexity?: number;
  hasTests?: boolean;
  isExported?: boolean;
  fileId?: number;
}

// ─── Main result ─────────────────────────────────────────────────────────────

export interface ChangeImpactResult {
  target: { path: string; symbolId?: string; symbolName?: string; kind?: string };
  summary: ImpactSummary;
  risk: RiskSignals;
  affectedTests: { total: number; files: string[] };
  breakingChanges?: BreakingChange[];
  byModule?: ModuleImpact[];
  byEdgeType?: Record<string, number>;
  byDepth?: Record<number, number>;
  coChangeHidden?: CoChangeHidden[];
  dependents: EnrichedDependent[];
  totalAffected: number;
  truncated?: boolean;
  pennant?: PennantImpactResult;
  /** When symbol_ids are provided, only those symbols are analyzed (diff-aware mode) */
  scopedToSymbols?: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getModule(filePath: string, depth = 2): string {
  const parts = filePath.split('/');
  return parts.length <= depth ? parts[0] : parts.slice(0, depth).join('/');
}

function riskLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score >= 0.75) return 'critical';
  if (score >= 0.5) return 'high';
  if (score >= 0.25) return 'medium';
  return 'low';
}

function round(v: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

function clamp01(v: number, ceiling: number): number {
  return Math.min(v / ceiling, 1);
}

// ─── Test coverage helpers (batch) ───────────────────────────────────────────

function getTestedFileIds(store: Store): Set<number> {
  const rows = store.db.prepare(`
    SELECT DISTINCT
      CASE
        WHEN n.node_type = 'file' THEN n.ref_id
        WHEN n.node_type = 'symbol' THEN (SELECT file_id FROM symbols WHERE id = n.ref_id)
      END AS fid
    FROM edges e
    JOIN edge_types et ON e.edge_type_id = et.id
    JOIN nodes n ON e.target_node_id = n.id
    WHERE et.name = 'test_covers'
  `).all() as Array<{ fid: number | null }>;
  const set = new Set<number>();
  for (const r of rows) if (r.fid != null) set.add(r.fid);
  return set;
}

// ─── Co-change lookup ────────────────────────────────────────────────────────

function getCoChangesForFile(
  store: Store,
  filePath: string,
  graphFiles: Set<string>,
): CoChangeHidden[] {
  try {
    const rows = store.db.prepare(`
      SELECT
        CASE WHEN file_a = ? THEN file_b ELSE file_a END AS co_file,
        confidence
      FROM co_changes
      WHERE (file_a = ? OR file_b = ?)
        AND confidence >= 0.3
        AND co_change_count >= 3
      ORDER BY confidence DESC
      LIMIT 15
    `).all(filePath, filePath, filePath) as Array<{ co_file: string; confidence: number }>;

    return rows.map((r) => ({
      file: r.co_file,
      confidence: round(r.confidence),
      inGraph: graphFiles.has(r.co_file),
    }));
  } catch {
    // co_changes table may not exist yet
    return [];
  }
}

// ─── Affected tests (for target + dependents) ───────────────────────────────

function findAffectedTests(
  store: Store,
  targetPath: string,
  dependentPaths: string[],
): { total: number; files: string[] } {
  const seen = new Set<string>();
  const allPaths = [targetPath, ...dependentPaths];

  for (const p of allPaths) {
    const file = store.getFile(p);
    if (!file) continue;

    // Check file-level test_covers
    const fileNodeId = store.getNodeId('file', file.id);
    if (fileNodeId != null) {
      collectTestFiles(store, fileNodeId, seen);
    }

    // Check symbol-level test_covers
    const symbols = store.getSymbolsByFile(file.id);
    for (const sym of symbols) {
      const symNodeId = store.getNodeId('symbol', sym.id);
      if (symNodeId != null) {
        collectTestFiles(store, symNodeId, seen);
      }
    }
  }

  const files = [...seen].sort();
  return { total: files.length, files };
}

function collectTestFiles(store: Store, nodeId: number, seen: Set<string>): void {
  const incoming = store.getIncomingEdges(nodeId);
  for (const edge of incoming) {
    if (edge.edge_type_name !== 'test_covers') continue;
    const ref = store.getNodeRef(edge.source_node_id);
    if (!ref) continue;

    let fileId: number | undefined;
    if (ref.nodeType === 'file') {
      fileId = ref.refId;
    } else if (ref.nodeType === 'symbol') {
      const s = store.getSymbolById(ref.refId);
      if (s) fileId = s.file_id;
    }
    if (fileId != null) {
      const f = store.getFileById(fileId);
      if (f) seen.add(f.path);
    }
  }
}

// ─── Git churn for a single file (lightweight) ──────────────────────────────

function getFileChurn(cwd: string, filePath: string, days: number): number {
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const output = execSync(
      `git log --since="${since}" --oneline -- "${filePath}" | wc -l`,
      { cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return parseInt(output.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN: getChangeImpact
// ═════════════════════════════════════════════════════════════════════════════

export function getChangeImpact(
  store: Store,
  opts: { filePath?: string; symbolId?: string; symbolIds?: string[] },
  depth = 3,
  maxDependents = 200,
  cwd?: string,
): TraceMcpResult<ChangeImpactResult> {
  let startNodeIds: number[] = [];
  let targetPath: string;
  let targetSymbolId: string | undefined;
  let targetSymbolName: string | undefined;
  let targetKind: string | undefined;
  let scopedToSymbols: string[] | undefined;

  // ── Diff-aware mode: scope to specific changed symbols ──
  if (opts.symbolIds && opts.symbolIds.length > 0) {
    scopedToSymbols = opts.symbolIds;
    let firstSym: SymbolRow | undefined;
    for (const sid of opts.symbolIds) {
      const sym = store.getSymbolBySymbolId(sid);
      if (!sym) continue;
      if (!firstSym) firstSym = sym;
      const nid = store.getNodeId('symbol', sym.id);
      if (nid != null) startNodeIds.push(nid);
    }
    if (!firstSym) {
      return err(notFound(opts.symbolIds[0]));
    }
    const file = store.getFileById(firstSym.file_id);
    targetPath = file?.path ?? 'unknown';
    targetSymbolId = firstSym.symbol_id;
    targetSymbolName = firstSym.name;
    targetKind = firstSym.kind;
    startNodeIds = [...new Set(startNodeIds)];
  } else if (opts.symbolId) {
    const sym = store.getSymbolBySymbolId(opts.symbolId);
    if (!sym) {
      return err(notFound(opts.symbolId));
    }
    const nodeId = store.getNodeId('symbol', sym.id);
    if (nodeId != null) startNodeIds.push(nodeId);
    const file = store.getFileById(sym.file_id);
    targetPath = file?.path ?? 'unknown';
    targetSymbolId = opts.symbolId;
    targetSymbolName = sym.name;
    targetKind = sym.kind;
  } else if (opts.filePath) {
    const file = store.getFile(opts.filePath);
    if (!file) {
      return err(notFound(opts.filePath));
    }
    targetPath = file.path;

    // Multi-root: start from BOTH file node AND all exported symbol nodes
    const fileNodeId = store.getNodeId('file', file.id);
    if (fileNodeId != null) startNodeIds.push(fileNodeId);

    const symbols = store.getSymbolsByFile(file.id);
    const primarySymbol = symbols.find((s) => s.kind === 'class') ?? symbols[0];
    if (primarySymbol) {
      targetSymbolId = primarySymbol.symbol_id;
      targetSymbolName = primarySymbol.name;
      targetKind = primarySymbol.kind;
    }
    for (const sym of symbols) {
      const nid = store.getNodeId('symbol', sym.id);
      if (nid != null) startNodeIds.push(nid);
    }
    startNodeIds = [...new Set(startNodeIds)];
  } else {
    return err(notFound('', ['Provide either filePath, symbolId, or symbolIds']));
  }

  // Pennant feature flag check
  const pennant = getPennantImpact(store, opts.symbolId ?? opts.filePath ?? '');

  if (startNodeIds.length === 0) {
    const emptySummary: ImpactSummary = {
      totalFiles: 0, totalSymbols: 0, maxDepth: 0,
      crossBoundary: false, publicApiAffected: 0,
      untestedDependents: 0, highComplexityDependents: 0,
      sentence: 'No dependents found.',
    };
    const emptyRisk: RiskSignals = {
      score: 0, level: 'low', publicApiBreaking: false,
      untestedRatio: 0, maxComplexity: 0, mitigations: [],
    };
    return ok({
      target: { path: targetPath, symbolId: targetSymbolId, symbolName: targetSymbolName, kind: targetKind },
      summary: emptySummary,
      risk: emptyRisk,
      dependents: [],
      affectedTests: { total: 0, files: [] },
      totalAffected: 0,
    });
  }

  // ── Batch: get tested file IDs for enrichment ──
  const testedFileIds = getTestedFileIds(store);

  // ── BFS traversal (multi-root) → raw entries ──
  const rawDeps: RawDependent[] = [];
  const visited = new Set<number>();
  for (const nid of startNodeIds) visited.add(nid);

  traverseIncoming(store, startNodeIds, maxDependents, depth, visited, rawDeps, testedFileIds);

  const truncated = rawDeps.length >= maxDependents;

  // ── Dedup: merge per-file, collect edge types + symbols ──
  const dependents = deduplicateByFile(rawDeps);

  // ── Compute stats from raw entries (before dedup, for accurate edge/depth counts) ──
  const byEdgeType: Record<string, number> = {};
  const byDepth: Record<number, number> = {};
  for (const raw of rawDeps) {
    byEdgeType[raw.edgeType] = (byEdgeType[raw.edgeType] ?? 0) + 1;
    byDepth[raw.depth] = (byDepth[raw.depth] ?? 0) + 1;
  }

  // ── Compute stats from deduped dependents ──
  const moduleMap = new Map<string, { files: Set<string>; maxDepth: number; hasUntested: boolean }>();
  const graphFiles = new Set<string>();
  const targetModule = getModule(targetPath);
  let crossBoundary = false;
  let publicApiAffected = 0;
  let untestedDependents = 0;
  let highComplexityDependents = 0;
  let maxComplexity = 0;
  let maxDepthSeen = 0;

  for (const dep of dependents) {
    const mod = getModule(dep.path);
    if (mod !== targetModule) crossBoundary = true;
    let modEntry = moduleMap.get(mod);
    if (!modEntry) {
      modEntry = { files: new Set(), maxDepth: 0, hasUntested: false };
      moduleMap.set(mod, modEntry);
    }
    modEntry.files.add(dep.path);
    modEntry.maxDepth = Math.max(modEntry.maxDepth, dep.depth);
    if (dep.hasTests === false) modEntry.hasUntested = true;

    graphFiles.add(dep.path);
    if (dep.hasTests === false) untestedDependents++;
    if (dep.depth > maxDepthSeen) maxDepthSeen = dep.depth;

    for (const sym of dep.symbols ?? []) {
      if (sym.isExported) publicApiAffected++;
      if ((sym.complexity ?? 0) > 15) highComplexityDependents++;
      if ((sym.complexity ?? 0) > maxComplexity) maxComplexity = sym.complexity ?? 0;
    }
  }

  const byModule: ModuleImpact[] = [...moduleMap.entries()]
    .map(([mod, data]) => ({
      module: mod,
      count: data.files.size,
      files: [...data.files],
      maxDepth: data.maxDepth,
      hasUntested: data.hasUntested,
    }))
    .sort((a, b) => b.count - a.count);

  // ── Affected tests ──
  const affectedTests = findAffectedTests(
    store,
    targetPath,
    dependents.slice(0, 50).map((d) => d.path),
  );

  // ── Co-change hidden dependencies ──
  graphFiles.add(targetPath);
  const coChangeAll = getCoChangesForFile(store, targetPath, graphFiles);
  const coChangeHidden = coChangeAll.filter((c) => !c.inGraph);

  // ── Target's own test coverage and churn ──
  const targetFile = store.getFile(targetPath);
  const targetHasTests = targetFile ? testedFileIds.has(targetFile.id) : false;

  let churnCommits = 0;
  if (cwd && isGitRepo(cwd)) {
    churnCommits = getFileChurn(cwd, targetPath, 180);
  }

  // ── Risk signals ──
  const totalFiles = dependents.length || 1;
  const untestedRatio = round(untestedDependents / totalFiles);
  const blastScore = clamp01(dependents.length, 50);
  const complexityScore = clamp01(maxComplexity, 20);
  const testGapScore = targetHasTests ? 0 : 0.8;
  const churnScore = clamp01(churnCommits, 30);
  const publicApiScore = publicApiAffected > 0 ? 0.3 : 0;

  const riskScore = round(
    0.30 * blastScore +
    0.20 * complexityScore +
    0.20 * testGapScore +
    0.15 * churnScore +
    0.15 * publicApiScore,
  );

  const mitigations: string[] = [];
  if (!targetHasTests) mitigations.push('Add test coverage for the target before modifying');
  if (blastScore > 0.5) mitigations.push(`High blast radius (${dependents.length} files) — consider incremental rollout`);
  if (complexityScore > 0.7) mitigations.push('High complexity in dependents — review carefully for regressions');
  if (untestedRatio > 0.5) mitigations.push(`${untestedDependents}/${totalFiles} dependents lack tests — add integration tests`);
  if (publicApiAffected > 0) mitigations.push(`${publicApiAffected} public API symbol(s) affected — check for breaking changes`);
  if (churnCommits > 15) mitigations.push(`High churn (${churnCommits} commits/180d) — review recent history`);
  if (coChangeHidden.length > 0) {
    mitigations.push(`${coChangeHidden.length} hidden coupling(s) via git history: ${coChangeHidden.slice(0, 3).map((c) => c.file).join(', ')}`);
  }

  const risk: RiskSignals = {
    score: riskScore,
    level: riskLevel(riskScore),
    publicApiBreaking: publicApiAffected > 0,
    untestedRatio,
    maxComplexity,
    mitigations,
  };

  // ── Summary sentence ──
  const modCount = byModule.length;
  const symCount = dependents.reduce((s, d) => s + (d.symbols?.length ?? 0), 0);
  const parts: string[] = [];
  parts.push(`${dependents.length} file(s) across ${modCount} module(s)`);
  if (publicApiAffected > 0) parts.push(`${publicApiAffected} public API`);
  if (untestedDependents > 0) parts.push(`${untestedDependents} untested`);
  if (highComplexityDependents > 0) parts.push(`${highComplexityDependents} high-complexity`);
  if (affectedTests.total > 0) parts.push(`${affectedTests.total} test(s) to run`);
  if (coChangeHidden.length > 0) parts.push(`${coChangeHidden.length} hidden coupling(s)`);

  const summary: ImpactSummary = {
    totalFiles: dependents.length,
    totalSymbols: symCount,
    maxDepth: maxDepthSeen,
    crossBoundary,
    publicApiAffected,
    untestedDependents,
    highComplexityDependents,
    sentence: `Impact: ${parts.join(', ')}.${risk.level !== 'low' ? ` Risk: ${risk.level}.` : ''}`,
  };

  // ── Breaking change detection ──
  const breakingChanges = detectBreakingChanges(store, targetPath, scopedToSymbols);

  if (breakingChanges.length > 0) {
    const totalConsumers = breakingChanges.reduce((s, b) => s + b.consumers, 0);
    mitigations.push(`${breakingChanges.length} exported symbol(s) with ${totalConsumers} consumer(s) — signature change = breaking`);
    parts.push(`${breakingChanges.length} breaking risk(s)`);
    // Recalculate sentence with breaking changes included
    summary.sentence = `Impact: ${parts.join(', ')}.${risk.level !== 'low' ? ` Risk: ${risk.level}.` : ''}`;
  }

  // ── Build result, omitting empty optional sections ──
  const result: ChangeImpactResult = {
    target: { path: targetPath, symbolId: targetSymbolId, symbolName: targetSymbolName, kind: targetKind },
    summary,
    risk,
    affectedTests,
    dependents,
    totalAffected: dependents.length,
  };

  if (breakingChanges.length > 0) result.breakingChanges = breakingChanges;
  if (byModule.length > 0) result.byModule = byModule;
  if (Object.keys(byEdgeType).length > 0) result.byEdgeType = byEdgeType;
  if (Object.keys(byDepth).length > 0) result.byDepth = byDepth;
  if (coChangeHidden.length > 0) result.coChangeHidden = coChangeHidden;
  if (truncated) result.truncated = true;
  if (pennant) result.pennant = pennant;
  if (scopedToSymbols) result.scopedToSymbols = scopedToSymbols;

  return ok(result);
}

// ═════════════════════════════════════════════════════════════════════════════
// Dedup: merge raw entries by file path
// ═════════════════════════════════════════════════════════════════════════════

function deduplicateByFile(rawDeps: RawDependent[]): EnrichedDependent[] {
  const fileMap = new Map<string, {
    edgeTypes: Set<string>;
    depth: number;
    hasTests?: boolean;
    symbols: DependentSymbol[];
  }>();

  for (const raw of rawDeps) {
    let entry = fileMap.get(raw.path);
    if (!entry) {
      entry = { edgeTypes: new Set(), depth: raw.depth, hasTests: raw.hasTests, symbols: [] };
      fileMap.set(raw.path, entry);
    }
    entry.edgeTypes.add(raw.edgeType);
    entry.depth = Math.min(entry.depth, raw.depth); // shallowest wins
    if (raw.hasTests != null) entry.hasTests = raw.hasTests;

    if (raw.symbolId && raw.symbolName && raw.symbolKind) {
      // Avoid duplicate symbols
      if (!entry.symbols.some((s) => s.symbolId === raw.symbolId)) {
        const sym: DependentSymbol = {
          symbolId: raw.symbolId,
          symbolName: raw.symbolName,
          symbolKind: raw.symbolKind,
        };
        if (raw.complexity != null) sym.complexity = raw.complexity;
        if (raw.isExported != null) sym.isExported = raw.isExported;
        entry.symbols.push(sym);
      }
    }
  }

  const result: EnrichedDependent[] = [];
  for (const [path, entry] of fileMap) {
    const dep: EnrichedDependent = {
      path,
      edgeTypes: [...entry.edgeTypes],
      depth: entry.depth,
    };
    if (entry.hasTests != null) dep.hasTests = entry.hasTests;
    if (entry.symbols.length > 0) dep.symbols = entry.symbols;
    result.push(dep);
  }

  // Sort: shallowest first, then alphabetical
  result.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// BFS traversal (multi-root) → raw entries
// ═════════════════════════════════════════════════════════════════════════════

function traverseIncoming(
  store: Store,
  startNodeIds: number[],
  maxDependents: number,
  maxDepth: number,
  visited: Set<number>,
  rawDeps: RawDependent[],
  testedFileIds: Set<number>,
): void {
  let frontier = startNodeIds;

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (frontier.length === 0 || rawDeps.length >= maxDependents) break;

    const allEdges = store.getEdgesForNodesBatch(frontier);

    const frontierSet = new Set(frontier);
    const newFrontier: number[] = [];
    const sourceNodeIds: number[] = [];
    const edgeBySource = new Map<number, string>();

    for (const edge of allEdges) {
      if (rawDeps.length + sourceNodeIds.length >= maxDependents) break;
      if (!frontierSet.has(edge.target_node_id)) continue;
      if (edge.source_node_id === edge.target_node_id) continue;

      const srcId = edge.source_node_id;
      if (visited.has(srcId)) continue;
      visited.add(srcId);

      sourceNodeIds.push(srcId);
      edgeBySource.set(srcId, edge.edge_type_name);
      newFrontier.push(srcId);
    }

    if (sourceNodeIds.length === 0) break;

    // Batch resolve node refs
    const nodeRefs = store.getNodeRefsBatch(sourceNodeIds);

    const symbolIds: number[] = [];
    const fileIds: number[] = [];
    for (const [, ref] of nodeRefs) {
      if (ref.nodeType === 'symbol') symbolIds.push(ref.refId);
      else if (ref.nodeType === 'file') fileIds.push(ref.refId);
    }

    const symbolMap = symbolIds.length > 0 ? store.getSymbolsByIds(symbolIds) : new Map<number, SymbolRow>();
    const fileMap = fileIds.length > 0 ? store.getFilesByIds(fileIds) : new Map();

    const symFileIds = new Set<number>();
    for (const sym of symbolMap.values()) symFileIds.add(sym.file_id);
    const symFiles = symFileIds.size > 0 ? store.getFilesByIds([...symFileIds]) : new Map();

    // Batch fetch complexity
    const complexityMap = new Map<number, number>();
    if (symbolIds.length > 0) {
      const placeholders = symbolIds.map(() => '?').join(',');
      const rows = store.db.prepare(
        `SELECT id, cyclomatic FROM symbols WHERE id IN (${placeholders}) AND cyclomatic IS NOT NULL`,
      ).all(...symbolIds) as Array<{ id: number; cyclomatic: number }>;
      for (const r of rows) complexityMap.set(r.id, r.cyclomatic);
    }

    for (const srcId of sourceNodeIds) {
      if (rawDeps.length >= maxDependents) break;

      const ref = nodeRefs.get(srcId);
      if (!ref) continue;

      let filePath: string | undefined;
      let symbolId: string | undefined;
      let symbolName: string | undefined;
      let symbolKind: string | undefined;
      let complexity: number | undefined;
      let isExported: boolean | undefined;
      let fileId: number | undefined;

      if (ref.nodeType === 'symbol') {
        const sym = symbolMap.get(ref.refId);
        if (sym) {
          symbolId = sym.symbol_id;
          symbolName = sym.name;
          symbolKind = sym.kind;
          filePath = symFiles.get(sym.file_id)?.path;
          fileId = sym.file_id;
          complexity = complexityMap.get(sym.id);

          if (sym.metadata) {
            try {
              const meta = JSON.parse(sym.metadata) as Record<string, unknown>;
              isExported = meta.exported === true || meta.exported === 1;
            } catch { /* ignore */ }
          }
        }
      } else if (ref.nodeType === 'file') {
        const f = fileMap.get(ref.refId);
        filePath = f?.path;
        fileId = f?.id;
      }

      if (filePath) {
        rawDeps.push({
          path: filePath,
          edgeType: edgeBySource.get(srcId) ?? 'unknown',
          depth,
          symbolId,
          symbolName,
          symbolKind,
          complexity,
          hasTests: fileId != null ? testedFileIds.has(fileId) : undefined,
          isExported,
          fileId,
        });
      }
    }

    frontier = newFrontier;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Breaking change detection
// ═════════════════════════════════════════════════════════════════════════════

function detectBreakingChanges(
  store: Store,
  targetPath: string,
  scopedSymbolIds?: string[],
): BreakingChange[] {
  const file = store.getFile(targetPath);
  if (!file) return [];

  const symbols = store.getSymbolsByFile(file.id);
  const breaking: BreakingChange[] = [];

  for (const sym of symbols) {
    // Only check exported symbols
    if (!sym.metadata) continue;
    let meta: Record<string, unknown>;
    try { meta = JSON.parse(sym.metadata) as Record<string, unknown>; } catch { continue; }
    if (meta.exported !== true && meta.exported !== 1) continue;

    // If scoped to specific symbols, only check those
    if (scopedSymbolIds && !scopedSymbolIds.includes(sym.symbol_id)) continue;

    // Find consumers: who imports/calls/uses this specific symbol
    const nodeId = store.getNodeId('symbol', sym.id);
    if (nodeId == null) continue;

    const incoming = store.getIncomingEdges(nodeId);
    const consumerFiles = new Set<string>();
    for (const edge of incoming) {
      // Skip test_covers — tests are not "consumers" for breaking change purposes
      if (edge.edge_type_name === 'test_covers') continue;

      const ref = store.getNodeRef(edge.source_node_id);
      if (!ref) continue;

      if (ref.nodeType === 'symbol') {
        const s = store.getSymbolById(ref.refId);
        if (s) {
          const f = store.getFileById(s.file_id);
          if (f && f.path !== targetPath) consumerFiles.add(f.path);
        }
      } else if (ref.nodeType === 'file') {
        const f = store.getFileById(ref.refId);
        if (f && f.path !== targetPath) consumerFiles.add(f.path);
      }
    }

    if (consumerFiles.size > 0) {
      breaking.push({
        symbolId: sym.symbol_id,
        symbolName: sym.name,
        kind: sym.kind,
        consumers: consumerFiles.size,
        consumerFiles: [...consumerFiles].slice(0, 10), // cap for readability
      });
    }
  }

  // Sort: most consumers first
  breaking.sort((a, b) => b.consumers - a.consumers);
  return breaking;
}

// ═════════════════════════════════════════════════════════════════════════════
// Pennant feature flag impact
// ═════════════════════════════════════════════════════════════════════════════

function getPennantImpact(store: Store, name: string): PennantImpactResult | null {
  if (!name) return null;

  const definedIn: { filePath: string; line: number }[] = [];
  const checkedBy: PennantUsageSite[] = [];
  const gatedRoutes: { filePath: string; line: number }[] = [];

  for (const edgeType of ['feature_defined_in', 'feature_checked_by', 'feature_gates_route']) {
    const edges = store.getEdgesByType(edgeType);
    for (const edge of edges) {
      if (!edge.metadata) continue;
      let meta: Record<string, unknown>;
      try { meta = JSON.parse(edge.metadata) as Record<string, unknown>; } catch { continue; }
      if (meta.featureName !== name) continue;

      const filePath = String(meta.filePath ?? '');
      const line = Number(meta.line ?? 0);

      if (edgeType === 'feature_defined_in') {
        definedIn.push({ filePath, line });
      } else if (edgeType === 'feature_checked_by') {
        checkedBy.push({ filePath, line, usageType: String(meta.usageType ?? '') });
      } else if (edgeType === 'feature_gates_route') {
        gatedRoutes.push({ filePath, line });
      }
    }
  }

  if (definedIn.length === 0 && checkedBy.length === 0 && gatedRoutes.length === 0) return null;
  return { featureName: name, definedIn, checkedBy, gatedRoutes };
}
