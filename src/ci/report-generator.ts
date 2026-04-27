/**
 * CI Report Generator — pure-logic engine for change impact reports.
 *
 * Takes a list of changed files and produces a structured report with:
 * - Blast radius (transitive dependents)
 * - Test coverage gaps
 * - Risk score (complexity x churn x coupling x blast)
 * - Architecture violations
 * - Dead code introduced
 *
 * No CLI concerns, no git — pure data in, report out.
 */
import type { Store } from '../db/store.js';
import { getChangeImpact, } from '../tools/analysis/impact.js';
import { getDeadExports } from '../tools/analysis/introspect.js';
import { getUntestedExports } from '../tools/analysis/introspect.js';
import { getCouplingMetrics, type CouplingResult } from '../tools/analysis/graph-analysis.js';
import {
  getLayerViolations,
  detectLayerPreset,
  type LayerDefinition,
  type LayerViolation,
} from '../tools/analysis/layer-violations.js';
import { getChurnRate } from '../tools/git/git-analysis.js';
import { DomainStore } from '../intent/domain-store.js';
import { getFileOwnership } from '../tools/git/git-ownership.js';
import { TopologyStore } from '../topology/topology-db.js';
import { TOPOLOGY_DB_PATH } from '../global.js';
import { logger } from '../logger.js';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

interface CIReportInput {
  changedFiles: string[];
  store: Store;
  rootPath: string;
  layers?: LayerDefinition[];
  /** Enable domain/ownership/deployment analysis (default true) */
  enableProjectAware?: boolean;
}

// ── Project-aware analysis types ──

interface DomainAnalysis {
  domainsAffected: Array<{ name: string; filesChanged: number; filesImpacted: number }>;
  crossDomainChanges: Array<{ from: string; to: string; edgeCount: number }>;
  reviewTeams: string[];
}

interface OwnershipAnalysis {
  owners: Array<{ file: string; primaryOwner: string; percentage: number }>;
  teamsCrossed: string[];
}

interface DeploymentImpact {
  servicesAffected: Array<{ name: string; type: string; filesChanged: number }>;
  crossServiceChanges: number;
}

interface ChangedFileInfo {
  path: string;
  symbolCount: number;
  avgCyclomatic: number;
}

interface BlastRadiusEntry {
  path: string;
  symbolId?: string;
  edgeType: string;
  depth: number;
}

interface TestCoverageGap {
  symbolId: string;
  name: string;
  kind: string;
  file: string;
  signature: string | null;
}

interface RiskFileEntry {
  file: string;
  complexity: number;
  churn: number;
  coupling: number;
  blastSize: number;
  score: number;
}

export interface CIReport {
  changedFiles: ChangedFileInfo[];
  blastRadius: {
    entries: BlastRadiusEntry[];
    totalAffected: number;
    truncated: boolean;
    riskSummary?: { file: string; riskLevel: string; sentence: string }[];
  };
  testCoverage: {
    gaps: TestCoverageGap[];
    totalExports: number;
    totalUntested: number;
  };
  riskAnalysis: {
    files: RiskFileEntry[];
    overallScore: number;
    overallLevel: 'low' | 'medium' | 'high' | 'critical';
  };
  architectureViolations: {
    violations: LayerViolation[];
    totalViolations: number;
    layersChecked: string[];
  };
  deadCode: {
    symbols: Array<{ symbolId: string; name: string; kind: string; file: string }>;
    totalDead: number;
  };
  // Project-aware sections (optional — present when enableProjectAware is true)
  domainAnalysis?: DomainAnalysis;
  ownershipAnalysis?: OwnershipAnalysis;
  deploymentImpact?: DeploymentImpact;
  // Baseline comparison (present when historical data exists)
  baseline?: import('./baseline.js').BaselineComparison | null;
  summary: {
    changedFileCount: number;
    affectedFileCount: number;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    untestedGaps: number;
    violations: number;
    deadExports: number;
    domainsCrossed?: number;
    servicesAffected?: number;
  };
}

// ═══════════════════════════════════════════════════════════════════
// GENERATOR
// ═══════════════════════════════════════════════════════════════════

export function generateReport(input: CIReportInput): CIReport {
  const { changedFiles, store, rootPath, layers } = input;

  // 1. Changed files + symbols
  const changedFileInfos = resolveChangedFiles(store, changedFiles);

  // 2. Blast radius
  const blastRadius = computeBlastRadius(store, changedFiles);

  // 3. Test coverage gaps (filtered to affected files)
  const testCoverage = computeTestCoverageGaps(store, changedFiles, blastRadius.entries);

  // 4. Risk score
  const riskAnalysis = computeRiskScores(store, rootPath, changedFileInfos, blastRadius);

  // 5. Architecture violations
  const architectureViolations = computeArchViolations(store, changedFiles, layers);

  // 6. Dead code introduced
  const deadCode = computeDeadCode(store, changedFiles);

  // 7–9. Project-aware analysis (optional, never fails the report)
  let domainAnalysis: DomainAnalysis | undefined;
  let ownershipAnalysis: OwnershipAnalysis | undefined;
  let deploymentImpact: DeploymentImpact | undefined;

  if (input.enableProjectAware !== false) {
    try {
      domainAnalysis = computeDomainAnalysis(store, changedFiles, blastRadius.entries);
    } catch (e) {
      logger.debug({ error: e }, 'CI report: domain analysis skipped');
    }
    try {
      ownershipAnalysis = computeOwnershipAnalysis(rootPath, changedFiles);
    } catch (e) {
      logger.debug({ error: e }, 'CI report: ownership analysis skipped');
    }
    try {
      deploymentImpact = computeDeploymentImpact(changedFiles, rootPath);
    } catch (e) {
      logger.debug({ error: e }, 'CI report: deployment impact skipped');
    }
  }

  // Summary
  const summary: CIReport['summary'] = {
    changedFileCount: changedFiles.length,
    affectedFileCount: blastRadius.totalAffected,
    riskLevel: riskAnalysis.overallLevel,
    untestedGaps: testCoverage.gaps.length,
    violations: architectureViolations.totalViolations,
    deadExports: deadCode.totalDead,
    ...(domainAnalysis ? { domainsCrossed: domainAnalysis.domainsAffected.length } : {}),
    ...(deploymentImpact ? { servicesAffected: deploymentImpact.servicesAffected.length } : {}),
  };

  return {
    changedFiles: changedFileInfos,
    blastRadius,
    testCoverage,
    riskAnalysis,
    architectureViolations,
    deadCode,
    ...(domainAnalysis ? { domainAnalysis } : {}),
    ...(ownershipAnalysis ? { ownershipAnalysis } : {}),
    ...(deploymentImpact ? { deploymentImpact } : {}),
    summary,
  };
}

// ═══════════════════════════════════════════════════════════════════
// INTERNAL FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

function resolveChangedFiles(store: Store, changedFiles: string[]): ChangedFileInfo[] {
  const infos: ChangedFileInfo[] = [];

  for (const filePath of changedFiles) {
    const file = store.getFile(filePath);
    if (!file) {
      infos.push({ path: filePath, symbolCount: 0, avgCyclomatic: 0 });
      continue;
    }

    const symbols = store.getSymbolsByFile(file.id);
    const cyclomatics = symbols
      .map((s) => {
        if (!s.metadata) return 0;
        try {
          const meta = JSON.parse(s.metadata) as Record<string, unknown>;
          return typeof meta.cyclomatic === 'number' ? meta.cyclomatic : 0;
        } catch {
          return 0;
        }
      })
      .filter((c) => c > 0);

    const avg =
      cyclomatics.length > 0 ? cyclomatics.reduce((a, b) => a + b, 0) / cyclomatics.length : 0;

    infos.push({
      path: filePath,
      symbolCount: symbols.length,
      avgCyclomatic: Math.round(avg * 100) / 100,
    });
  }

  return infos;
}

function computeBlastRadius(store: Store, changedFiles: string[]): CIReport['blastRadius'] {
  const allEntries: BlastRadiusEntry[] = [];
  const seenPaths = new Set(changedFiles);
  let truncated = false;
  const riskSummary: { file: string; riskLevel: string; sentence: string }[] = [];

  for (const filePath of changedFiles) {
    const result = getChangeImpact(store, { filePath }, 2, 100);
    if (result.isErr()) continue;

    const impact = result.value;
    if (impact.truncated) truncated = true;

    for (const dep of impact.dependents) {
      if (seenPaths.has(dep.path)) continue;
      seenPaths.add(dep.path);
      allEntries.push({
        path: dep.path,
        symbolId: dep.symbols?.[0]?.symbolId,
        edgeType: dep.edgeTypes.join(', '),
        depth: dep.depth,
      });
    }

    if (impact.totalAffected > 3) {
      riskSummary.push({
        file: filePath,
        riskLevel: impact.risk.level,
        sentence: impact.summary.sentence,
      });
    }
  }

  // Sort by depth then path
  allEntries.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));

  return {
    entries: allEntries,
    totalAffected: allEntries.length,
    truncated,
    ...(riskSummary.length > 0 ? { riskSummary } : {}),
  };
}

function computeTestCoverageGaps(
  store: Store,
  changedFiles: string[],
  blastEntries: BlastRadiusEntry[],
): CIReport['testCoverage'] {
  const untestedResult = getUntestedExports(store);

  // Build set of affected files (changed + blast radius)
  const affectedFiles = new Set([...changedFiles, ...blastEntries.map((e) => e.path)]);

  // Filter to only affected files
  const gaps = untestedResult.untested
    .filter((item) => affectedFiles.has(item.file))
    .map((item) => ({
      symbolId: item.symbol_id,
      name: item.name,
      kind: item.kind,
      file: item.file,
      signature: item.signature,
    }));

  return {
    gaps,
    totalExports: untestedResult.total_exports,
    totalUntested: gaps.length,
  };
}

function computeRiskScores(
  store: Store,
  rootPath: string,
  changedFileInfos: ChangedFileInfo[],
  blastRadius: CIReport['blastRadius'],
): CIReport['riskAnalysis'] {
  // Get coupling metrics for all files
  const couplingResults = getCouplingMetrics(store);
  const couplingByFile = new Map<string, CouplingResult>();
  for (const c of couplingResults) {
    couplingByFile.set(c.file, c);
  }

  // Get churn rates
  const churnEntries = getChurnRate(rootPath, { limit: 500 });
  const churnByFile = new Map<string, number>();
  for (const c of churnEntries) {
    churnByFile.set(c.file, c.churn_per_week);
  }

  // Build per-file blast radius: count how many blast entries were caused by each source file
  const blastByFile = new Map<string, number>();
  for (const filePath of changedFileInfos.map((i) => i.path)) {
    const result = getChangeImpact(store, { filePath }, 2, 100);
    if (result.isOk()) {
      blastByFile.set(filePath, result.value.totalAffected);
    }
  }

  // Total files in index for normalization
  const totalFiles = store.getAllFiles().length || 1;

  const files: RiskFileEntry[] = [];

  // Only score files that are in the index (skip .md, .json, .sh, etc.)
  const codeFiles = changedFileInfos.filter((info) => store.getFile(info.path));

  for (const info of codeFiles) {
    const coupling = couplingByFile.get(info.path);
    const churn = churnByFile.get(info.path) ?? 0;

    // Per-file blast radius
    const fileBlast = blastByFile.get(info.path) ?? 0;

    // Normalize each signal to 0-1
    const complexityNorm = Math.min(info.avgCyclomatic / 20, 1);
    const churnNorm = Math.min(churn / 5, 1);
    const couplingNorm = coupling ? coupling.instability : 0;
    const blastNorm = Math.min(fileBlast / totalFiles, 1);

    const score = 0.3 * complexityNorm + 0.25 * churnNorm + 0.25 * couplingNorm + 0.2 * blastNorm;

    files.push({
      file: info.path,
      complexity: Math.round(complexityNorm * 100) / 100,
      churn: Math.round(churnNorm * 100) / 100,
      coupling: Math.round(couplingNorm * 100) / 100,
      blastSize: fileBlast,
      score: Math.round(score * 100) / 100,
    });
  }

  files.sort((a, b) => b.score - a.score);

  const overallScore =
    files.length > 0 ? files.reduce((sum, f) => sum + f.score, 0) / files.length : 0;

  return {
    files,
    overallScore: Math.round(overallScore * 100) / 100,
    overallLevel: scoreToLevel(overallScore),
  };
}

function computeArchViolations(
  store: Store,
  changedFiles: string[],
  customLayers?: LayerDefinition[],
): CIReport['architectureViolations'] {
  // Use custom layers or try to auto-detect
  let layers = customLayers;
  if (!layers) {
    const detected = detectLayerPreset(store);
    if (detected) layers = detected.layers;
  }

  if (!layers || layers.length === 0) {
    return { violations: [], totalViolations: 0, layersChecked: [] };
  }

  const result = getLayerViolations(store, layers);
  const changedSet = new Set(changedFiles);

  // Filter to violations involving changed files
  const relevant = result.violations.filter(
    (v) => changedSet.has(v.source_file) || changedSet.has(v.target_file),
  );

  return {
    violations: relevant,
    totalViolations: relevant.length,
    layersChecked: result.layers_checked,
  };
}

function computeDeadCode(store: Store, changedFiles: string[]): CIReport['deadCode'] {
  const result = getDeadExports(store);
  const changedSet = new Set(changedFiles);

  // Filter to dead exports in changed files only
  const relevant = result.dead_exports
    .filter((d) => changedSet.has(d.file))
    .map((d) => ({
      symbolId: d.symbol_id,
      name: d.name,
      kind: d.kind,
      file: d.file,
    }));

  return {
    symbols: relevant,
    totalDead: relevant.length,
  };
}

function scoreToLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score >= 0.75) return 'critical';
  if (score >= 0.5) return 'high';
  if (score >= 0.25) return 'medium';
  return 'low';
}

// ═══════════════════════════════════════════════════════════════════
// PROJECT-AWARE ANALYSIS
// ═══════════════════════════════════════════════════════════════════

function computeDomainAnalysis(
  store: Store,
  changedFiles: string[],
  blastEntries: BlastRadiusEntry[],
): DomainAnalysis | undefined {
  const domainStore = new DomainStore(store.db);

  // Check if domains have been built (built during indexing or via get_domain_map)
  const allDomains = domainStore.getAllDomains();
  if (allDomains.length === 0) return undefined;

  // Map files → domains
  const domainCounts = new Map<string, { filesChanged: number; filesImpacted: number }>();

  for (const filePath of changedFiles) {
    const file = store.getFile(filePath);
    if (!file) continue;
    const domains = domainStore.getDomainsForFile(file.id);
    for (const d of domains) {
      const existing = domainCounts.get(d.name) ?? { filesChanged: 0, filesImpacted: 0 };
      existing.filesChanged++;
      domainCounts.set(d.name, existing);
    }
  }

  for (const entry of blastEntries) {
    const file = store.getFile(entry.path);
    if (!file) continue;
    const domains = domainStore.getDomainsForFile(file.id);
    for (const d of domains) {
      const existing = domainCounts.get(d.name) ?? { filesChanged: 0, filesImpacted: 0 };
      existing.filesImpacted++;
      domainCounts.set(d.name, existing);
    }
  }

  if (domainCounts.size === 0) return undefined;

  const domainsAffected = [...domainCounts.entries()]
    .map(([name, counts]) => ({ name, ...counts }))
    .sort((a, b) => b.filesChanged + b.filesImpacted - (a.filesChanged + a.filesImpacted));

  // Cross-domain dependencies
  const crossDomainDeps = domainStore.getCrossDomainDependencies();
  const affectedDomainNames = new Set(domainsAffected.map((d) => d.name));
  const crossDomainChanges = crossDomainDeps
    .filter(
      (dep) =>
        affectedDomainNames.has(dep.source_domain) || affectedDomainNames.has(dep.target_domain),
    )
    .map((dep) => ({ from: dep.source_domain, to: dep.target_domain, edgeCount: dep.edge_count }));

  // Review teams = domains with directly changed files
  const reviewTeams = domainsAffected.filter((d) => d.filesChanged > 0).map((d) => d.name);

  return { domainsAffected, crossDomainChanges, reviewTeams };
}

function computeOwnershipAnalysis(
  rootPath: string,
  changedFiles: string[],
): OwnershipAnalysis | undefined {
  if (changedFiles.length === 0) return undefined;

  const ownerships = getFileOwnership(rootPath, changedFiles);
  if (ownerships.length === 0) return undefined;

  const owners: OwnershipAnalysis['owners'] = [];
  const allAuthors = new Set<string>();

  for (const ownership of ownerships) {
    if (ownership.owners.length === 0) continue;
    const primary = ownership.owners[0];
    owners.push({
      file: ownership.file,
      primaryOwner: primary.author,
      percentage: primary.percentage,
    });
    for (const o of ownership.owners) {
      allAuthors.add(o.author);
    }
  }

  if (owners.length === 0) return undefined;

  return {
    owners: owners.sort((a, b) => a.file.localeCompare(b.file)),
    teamsCrossed: [...allAuthors].sort(),
  };
}

function computeDeploymentImpact(
  changedFiles: string[],
  rootPath: string,
): DeploymentImpact | undefined {
  if (changedFiles.length === 0) return undefined;

  let topoStore: TopologyStore;
  try {
    topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
  } catch {
    return undefined;
  }

  try {
    const services = topoStore.getAllServices();
    if (services.length === 0) return undefined;

    // Map changed files to services by repo_root
    const serviceCounts = new Map<string, { name: string; type: string; count: number }>();

    for (const _filePath of changedFiles) {
      for (const svc of services) {
        // Check if file belongs to this service's repo
        if (
          svc.repo_root &&
          (rootPath === svc.repo_root || rootPath.startsWith(svc.repo_root + '/'))
        ) {
          const key = svc.name;
          const existing = serviceCounts.get(key) ?? {
            name: svc.name,
            type: svc.service_type ?? 'unknown',
            count: 0,
          };
          existing.count++;
          serviceCounts.set(key, existing);
          break;
        }
      }
    }

    if (serviceCounts.size === 0) return undefined;

    const servicesAffected = [...serviceCounts.values()]
      .map((s) => ({ name: s.name, type: s.type, filesChanged: s.count }))
      .sort((a, b) => b.filesChanged - a.filesChanged);

    // Cross-service: count edges between affected services
    const affectedServiceNames = new Set(servicesAffected.map((s) => s.name));
    const allEdges = topoStore.getAllCrossServiceEdges();
    const crossServiceChanges = allEdges.filter(
      (e) => affectedServiceNames.has(e.source_name) || affectedServiceNames.has(e.target_name),
    ).length;

    return { servicesAffected, crossServiceChanges };
  } finally {
    topoStore.close();
  }
}
