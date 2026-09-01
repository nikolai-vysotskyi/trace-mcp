/**
 * `trace-mcp doctor` command.
 * Scans for competing MCP servers, hooks, CLAUDE.md injections, and other
 * artifacts that may conflict with trace-mcp. Optionally fixes them.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import * as p from '@clack/prompts';
import Database from 'better-sqlite3';
import { Command } from 'commander';
import { DECISIONS_DB_PATH, REGISTRY_PATH, TOPOLOGY_DB_PATH } from '../global.js';
import { type ConflictSeverity, detectConflicts } from '../init/conflict-detector.js';
import { type FixResult, fixAllConflicts, fixConflict } from '../init/conflict-resolver.js';
import {
  getLauncherConfigPath,
  getLauncherDir,
  getLauncherPath,
  readInstalledLauncherVersion,
  readLauncherConfig,
} from '../init/launcher.js';
import { LAUNCHER_VERSION } from '../init/types.js';
import { findProjectRoot } from '../project-root.js';
import {
  type EphemeralProjectCandidate,
  findEphemeralProjects,
  findOverlappingProjects,
  findUnregisteredNestedRepos,
  inspectRegistry,
  pruneStaleProjects,
  unregisterProject,
} from '../registry.js';
import { TopologyStore } from '../topology/topology-db.js';
import { DecisionStore } from '../memory/decision-store.js';

const _SEVERITY_ICON: Record<ConflictSeverity, string> = {
  critical: 'X',
  warning: '!',
  info: '-',
};

const SEVERITY_LABEL: Record<ConflictSeverity, string> = {
  critical: 'CRITICAL',
  warning: 'WARNING',
  info: 'INFO',
};

export const doctorCommand = new Command('doctor')
  .description('Check trace-mcp health: registry/DB integrity and competing tools')
  .option('--fix', 'Automatically fix all fixable conflicts')
  .option('--fix-interactive', 'Fix conflicts interactively (ask for each)')
  .option('--dry-run', 'Show what --fix would do without making changes')
  .option('--json', 'Output results as JSON')
  .option('--launcher', 'Diagnose the stable-launcher shim instead of scanning conflicts')
  .action(
    async (opts: {
      fix?: boolean;
      fixInteractive?: boolean;
      dryRun?: boolean;
      json?: boolean;
      launcher?: boolean;
    }) => {
      if (opts.launcher) {
        const code = diagnoseLauncher({ json: opts.json });
        process.exit(code);
      }

      // Registry/DB integrity (#168) — independent of project conflicts. Surfaces
      // stale registrations (deleted folders, missing/corrupt DBs) that would
      // otherwise only manifest as runtime "Project not found" errors.
      const registry = diagnoseRegistry();
      const hasRegistryIssues =
        registry.staleCount > 0 ||
        registry.overlaps.length > 0 ||
        registry.unregisteredNestedRepos.length > 0 ||
        registry.ephemeralProjects.length > 0;

      // Topology & Decisions hygiene — dead services/subprojects and orphaned decisions
      const topology = diagnoseTopology();
      const hasTopologyIssues = topology.staleCount > 0;

      const decisions = diagnoseDecisions();
      const hasDecisionsIssues = decisions.staleRoots.length > 0;

      // --fix / --dry-run also clean up the registry itself (TRA-18): missing-root
      // entries and overlap containers have one unambiguous remediation each, so
      // (unlike project conflicts) they don't need an interactive per-item prompt.
      const registryFix: RegistryFixResult | null =
        hasRegistryIssues && (opts.fix || opts.dryRun)
          ? fixRegistryIssues(registry, { dryRun: opts.dryRun })
          : null;

      let topologyFix: TopologyFixResult | null =
        hasTopologyIssues && (opts.fix || opts.dryRun)
          ? fixTopologyIssues(topology, { dryRun: opts.dryRun })
          : null;

      let decisionsFix: DecisionsFixResult | null =
        hasDecisionsIssues && (opts.fix || opts.dryRun)
          ? fixDecisionsIssues(decisions, { dryRun: opts.dryRun })
          : null;

      // Detect project root (optional — doctor works without it)
      let projectRoot: string | undefined;
      try {
        projectRoot = findProjectRoot(process.cwd());
      } catch {
        // Not in a project — scan global only
      }

      const report = detectConflicts(projectRoot);
      const { conflicts } = report;

      // --- JSON output ---
      if (opts.json) {
        if (opts.fix || opts.dryRun) {
          const results = fixAllConflicts(conflicts, { dryRun: opts.dryRun });
          console.log(
            JSON.stringify(
              {
                registry,
                registryFix,
                topology,
                topologyFix,
                decisions,
                decisionsFix,
                conflicts,
                fixes: results,
              },
              null,
              2,
            ),
          );
        } else {
          console.log(JSON.stringify({ registry, topology, decisions, ...report }, null, 2));
        }
        return;
      }

      printRegistryReport(registry);
      printTopologyReport(topology);
      printDecisionsReport(decisions);

      if (registryFix) {
        printRegistryFixResult(registryFix, { dryRun: !!opts.dryRun });
      } else if (opts.fixInteractive && hasRegistryIssues) {
        printRegistryFixResult(await fixRegistryIssuesInteractive(registry), { dryRun: false });
      }

      if (topologyFix) {
        printTopologyFixResult(topologyFix, { dryRun: !!opts.dryRun });
      } else if (opts.fixInteractive && hasTopologyIssues) {
        const answer = await p.confirm({
          message: `Remove ${topology.staleServices.length} dead service(s) and ${topology.staleSubprojects.length} dead subproject(s) from topology.db (folders deleted)?`,
          initialValue: true,
        });
        if (!p.isCancel(answer) && answer) {
          topologyFix = fixTopologyIssues(topology, { dryRun: false });
          printTopologyFixResult(topologyFix, { dryRun: false });
        }
      }

      if (decisionsFix) {
        printDecisionsFixResult(decisionsFix, { dryRun: !!opts.dryRun });
      } else if (opts.fixInteractive && hasDecisionsIssues) {
        const answer = await p.confirm({
          message: `Remove ${decisions.staleDecisionsCount} orphaned decision(s) across ${decisions.staleRoots.length} deleted project root(s) from decisions.db?`,
          initialValue: true,
        });
        if (!p.isCancel(answer) && answer) {
          decisionsFix = fixDecisionsIssues(decisions, { dryRun: false });
          printDecisionsFixResult(decisionsFix, { dryRun: false });
        }
      }

      // --- No conflicts ---
      if (conflicts.length === 0) {
        if (!opts.json) {
          p.intro('trace-mcp doctor');
          p.note('No competing tools or conflicting configurations detected.', 'All clear');
          p.outro('trace-mcp has exclusive control of code intelligence.');
        }
        return;
      }

      // --- Report conflicts ---
      p.intro('trace-mcp doctor');

      const critical = conflicts.filter((c) => c.severity === 'critical');
      const warnings = conflicts.filter((c) => c.severity === 'warning');
      const info = conflicts.filter((c) => c.severity === 'info');

      const summary = [
        critical.length > 0 ? `${critical.length} critical` : '',
        warnings.length > 0 ? `${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : '',
        info.length > 0 ? `${info.length} info` : '',
      ]
        .filter(Boolean)
        .join(', ');

      p.note(
        `Found ${conflicts.length} conflict${conflicts.length > 1 ? 's' : ''}: ${summary}`,
        'Scan results',
      );

      // Display each conflict
      const lines: string[] = [];
      for (const c of conflicts) {
        lines.push(`  [${SEVERITY_LABEL[c.severity]}] ${c.summary}`);
        lines.push(`    ${c.detail}`);
        lines.push(
          `    Target: ${shortPath(c.target)}${c.fixable ? '  (auto-fixable)' : '  (manual fix)'}`,
        );
        lines.push('');
      }
      console.log(lines.join('\n'));

      // --- Auto-fix mode ---
      if (opts.fix) {
        const fixable = conflicts.filter((c) => c.fixable);
        if (fixable.length === 0) {
          p.note('No auto-fixable conflicts found. Manual intervention required.', 'Fix');
          p.outro('See details above for manual fix instructions.');
          return;
        }

        if (!opts.dryRun) {
          const confirm = await p.confirm({
            message: `Fix ${fixable.length} conflict${fixable.length > 1 ? 's' : ''} automatically?`,
            initialValue: true,
          });
          if (p.isCancel(confirm) || !confirm) {
            p.cancel('No changes made.');
            return;
          }
        }

        const results = fixAllConflicts(fixable, { dryRun: opts.dryRun });
        printFixResults(results, opts.dryRun);
        return;
      }

      // --- Interactive fix mode ---
      if (opts.fixInteractive) {
        const fixable = conflicts.filter((c) => c.fixable);
        if (fixable.length === 0) {
          p.note('No auto-fixable conflicts found.', 'Fix');
          p.outro('See details above for manual fix instructions.');
          return;
        }

        const results: FixResult[] = [];
        for (const conflict of fixable) {
          const answer = await p.confirm({
            message: `Fix: ${conflict.summary}?`,
            initialValue: conflict.severity === 'critical',
          });
          if (p.isCancel(answer)) {
            p.cancel('Stopped.');
            if (results.length > 0) printFixResults(results);
            return;
          }
          if (answer) {
            results.push(fixConflict(conflict, { dryRun: opts.dryRun }));
          } else {
            results.push({
              conflictId: conflict.id,
              action: 'skipped',
              detail: 'User skipped',
              target: conflict.target,
            });
          }
        }

        printFixResults(results, opts.dryRun);
        return;
      }

      // --- No fix requested — just suggest ---
      const fixable = conflicts.filter((c) => c.fixable);
      if (fixable.length > 0) {
        p.note(
          `${fixable.length} conflict${fixable.length > 1 ? 's' : ''} can be fixed automatically.\n` +
            'Run with --fix to fix all, or --fix-interactive to choose individually.',
          'Tip',
        );
      }

      p.outro(
        critical.length > 0
          ? 'Critical conflicts detected — fix them for trace-mcp to work correctly.'
          : 'Minor conflicts detected — trace-mcp will work but may not be preferred by the AI.',
      );
    },
  );

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Registry / DB integrity (#168)
// ---------------------------------------------------------------------------

type RegistryEntryStatus = 'ok' | 'missing_root' | 'db_missing' | 'db_unreadable';

interface RegistryEntryHealth {
  root: string;
  name: string;
  dbPath: string;
  status: RegistryEntryStatus;
}

interface RegistryOverlapReport {
  ancestorName: string;
  ancestorRoot: string;
  descendantName: string;
  descendantRoot: string;
}

interface UnregisteredNestedRepoReport {
  parentName: string;
  parentRoot: string;
  nestedRepoRoot: string;
}

export interface RegistryHealthReport {
  registryPath: string;
  registryExists: boolean;
  registryCorrupt: boolean;
  entries: RegistryEntryHealth[];
  staleCount: number;
  /** Project pairs where one registered root contains another — double indexing/watching. */
  overlaps: RegistryOverlapReport[];
  /** Sibling repos (own `.git`) found under a registered root that were never registered — zero index coverage. */
  unregisteredNestedRepos: UnregisteredNestedRepoReport[];
  /** One-shot Multica agent-run workdirs that are still registered long after their run ended (TRA-94). */
  ephemeralProjects: EphemeralProjectCandidate[];
}

/** Open a project DB read-only and run a trivial query to confirm it's intact. */
function checkDbReadable(dbPath: string): boolean {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      db.prepare('SELECT count(*) FROM sqlite_master').get();
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export function diagnoseRegistry(): RegistryHealthReport {
  const inspection = inspectRegistry();
  const entries: RegistryEntryHealth[] = inspection.entries.map((e) => {
    let status: RegistryEntryStatus;
    if (!fs.existsSync(e.root)) {
      status = 'missing_root';
    } else if (!fs.existsSync(e.dbPath)) {
      status = 'db_missing';
    } else {
      status = checkDbReadable(e.dbPath) ? 'ok' : 'db_unreadable';
    }
    return { root: e.root, name: e.name, dbPath: e.dbPath, status };
  });
  return {
    registryPath: REGISTRY_PATH,
    registryExists: inspection.exists,
    registryCorrupt: inspection.corrupt,
    entries,
    staleCount: entries.filter((e) => e.status !== 'ok').length,
    overlaps: findOverlappingProjects().map((o) => ({
      ancestorName: o.ancestor.name,
      ancestorRoot: o.ancestor.root,
      descendantName: o.descendant.name,
      descendantRoot: o.descendant.root,
    })),
    unregisteredNestedRepos: findUnregisteredNestedRepos(),
    ephemeralProjects: findEphemeralProjects(),
  };
}

// ---------------------------------------------------------------------------
// Topology DB integrity
// ---------------------------------------------------------------------------

export interface TopologyHealthReport {
  topologyPath: string;
  topologyExists: boolean;
  staleServices: Array<{ id: number; name: string; repoRoot: string }>;
  staleSubprojects: Array<{ id: number; name: string; repoRoot: string; projectRoot: string }>;
  staleCount: number;
}

export function diagnoseTopology(): TopologyHealthReport {
  if (!fs.existsSync(TOPOLOGY_DB_PATH)) {
    return {
      topologyPath: TOPOLOGY_DB_PATH,
      topologyExists: false,
      staleServices: [],
      staleSubprojects: [],
      staleCount: 0,
    };
  }
  try {
    const topoStore = new TopologyStore(TOPOLOGY_DB_PATH, { readonly: true });
    try {
      const stale = topoStore.findStale();
      return {
        topologyPath: TOPOLOGY_DB_PATH,
        topologyExists: true,
        staleServices: stale.staleServices.map((s) => ({
          id: s.id,
          name: s.name,
          repoRoot: s.repo_root,
        })),
        staleSubprojects: stale.staleSubprojects.map((s) => ({
          id: s.id,
          name: s.name,
          repoRoot: s.repo_root,
          projectRoot: s.project_root,
        })),
        staleCount: stale.staleServices.length + stale.staleSubprojects.length,
      };
    } finally {
      topoStore.close();
    }
  } catch {
    return {
      topologyPath: TOPOLOGY_DB_PATH,
      topologyExists: true,
      staleServices: [],
      staleSubprojects: [],
      staleCount: 0,
    };
  }
}

export interface TopologyFixResult {
  removedServices: string[];
  removedSubprojects: string[];
}

export function fixTopologyIssues(
  t: TopologyHealthReport,
  opts: { dryRun?: boolean },
): TopologyFixResult {
  if (opts.dryRun) {
    return {
      removedServices: t.staleServices.map((s) => s.name),
      removedSubprojects: t.staleSubprojects.map((s) => s.name),
    };
  }
  if (!fs.existsSync(TOPOLOGY_DB_PATH)) {
    return { removedServices: [], removedSubprojects: [] };
  }
  try {
    const topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
    try {
      const res = topoStore.pruneStale();
      return {
        removedServices: res.removedServices.map((s) => s.name),
        removedSubprojects: res.removedSubprojects.map((s) => s.name),
      };
    } finally {
      topoStore.close();
    }
  } catch {
    return { removedServices: [], removedSubprojects: [] };
  }
}

// ---------------------------------------------------------------------------
// Decision Memory DB integrity
// ---------------------------------------------------------------------------

export interface DecisionsHealthReport {
  decisionsPath: string;
  decisionsExists: boolean;
  staleRoots: string[];
  staleDecisionsCount: number;
  staleDecisions: Array<{ id: number; title: string; projectRoot: string }>;
}

export function diagnoseDecisions(): DecisionsHealthReport {
  if (!fs.existsSync(DECISIONS_DB_PATH)) {
    return {
      decisionsPath: DECISIONS_DB_PATH,
      decisionsExists: false,
      staleRoots: [],
      staleDecisionsCount: 0,
      staleDecisions: [],
    };
  }
  try {
    const store = new DecisionStore(DECISIONS_DB_PATH, { readonly: true });
    try {
      const stale = store.findStale();
      return {
        decisionsPath: DECISIONS_DB_PATH,
        decisionsExists: true,
        staleRoots: stale.staleRoots,
        staleDecisionsCount: stale.decisionsCount,
        staleDecisions: stale.staleDecisions.map((d) => ({
          id: d.id,
          title: d.title,
          projectRoot: d.project_root,
        })),
      };
    } finally {
      store.close();
    }
  } catch {
    return {
      decisionsPath: DECISIONS_DB_PATH,
      decisionsExists: true,
      staleRoots: [],
      staleDecisionsCount: 0,
      staleDecisions: [],
    };
  }
}

export interface DecisionsFixResult {
  removedRoots: string[];
  removedDecisions: number;
}

export function fixDecisionsIssues(
  d: DecisionsHealthReport,
  opts: { dryRun?: boolean },
): DecisionsFixResult {
  if (opts.dryRun) {
    return {
      removedRoots: d.staleRoots,
      removedDecisions: d.staleDecisionsCount,
    };
  }
  if (!fs.existsSync(DECISIONS_DB_PATH)) {
    return { removedRoots: [], removedDecisions: 0 };
  }
  try {
    const store = new DecisionStore(DECISIONS_DB_PATH);
    try {
      const res = store.pruneStale({ staleRoots: d.staleRoots, includeMinedSessions: true });
      return {
        removedRoots: res.staleRoots,
        removedDecisions: res.decisions,
      };
    } finally {
      store.close();
    }
  } catch {
    return { removedRoots: [], removedDecisions: 0 };
  }
}

export interface BlockedOverlapContainer {
  root: string;
  name: string;
  /** Unregistered nested repos under this container that would lose all index coverage. */
  orphanedPaths: string[];
}

export interface RegistryFixResult {
  /** Roots removed (or, in dry-run, that would be removed) because the folder is gone. */
  removedMissingRoots: string[];
  /** Ancestor roots removed (or previewed) because a descendant is also registered. */
  removedOverlapContainers: string[];
  /**
   * Overlap containers `--fix` deliberately left alone (TRA-111): unregistering
   * them would drop index coverage for a nested repo that is only reachable via
   * the container's broad indexing and was never registered on its own. Fix via
   * `trace-mcp add <orphanedPath>` (register the orphan) then re-run doctor, or
   * `trace-mcp remove <root>` to accept the coverage loss explicitly.
   */
  blockedOverlapContainers: BlockedOverlapContainer[];
  /** One-shot Multica agent-run workdirs removed (or previewed) because they're past the TTL. */
  removedEphemeralProjects: string[];
}

/** Nested-repo paths under `containerRoot` that only have coverage via the container. */
function orphanedPathsForContainer(
  containerRoot: string,
  unregisteredNestedRepos: RegistryHealthReport['unregisteredNestedRepos'],
): string[] {
  return unregisteredNestedRepos
    .filter((nr) => nr.parentRoot === containerRoot)
    .map((nr) => nr.nestedRepoRoot);
}

/**
 * Apply (or preview, when dryRun) the registry remediations `doctor` already knows
 * how to describe: drop entries whose folder is gone (same as `prune --apply`'s
 * registry sweep), drop the *ancestor* of an overlapping pair — the descendant is
 * always the more specific, intentional registration, so removing the container is
 * the unambiguous fix `printRegistryReport` already tells the user to run by hand —
 * and unregister stale one-shot Multica workdirs (TRA-94). Unregistering the latter
 * doesn't free their index DB by itself — it turns them into `orphan_unregistered`
 * candidates for `trace-mcp prune --apply` to actually delete.
 *
 * An overlap container is only auto-removed when doing so is loss-free. If an
 * unregistered nested repo under it depends on the container's broad indexing for
 * its only coverage (TRA-111), the container is reported in `blockedOverlapContainers`
 * instead — removing it there would silently zero out that repo's index coverage.
 */
export function fixRegistryIssues(
  r: RegistryHealthReport,
  opts: { dryRun?: boolean },
): RegistryFixResult {
  const missingRoots = r.entries.filter((e) => e.status === 'missing_root').map((e) => e.root);
  const allOverlapContainers = [...new Set(r.overlaps.map((o) => o.ancestorRoot))];
  const ephemeralRoots = r.ephemeralProjects.map((e) => e.root);

  const overlapContainers: string[] = [];
  const blockedOverlapContainers: BlockedOverlapContainer[] = [];
  for (const root of allOverlapContainers) {
    const orphanedPaths = orphanedPathsForContainer(root, r.unregisteredNestedRepos);
    if (orphanedPaths.length > 0) {
      const name = r.overlaps.find((o) => o.ancestorRoot === root)?.ancestorName ?? root;
      blockedOverlapContainers.push({ root, name, orphanedPaths });
    } else {
      overlapContainers.push(root);
    }
  }

  if (opts.dryRun) {
    return {
      removedMissingRoots: missingRoots,
      removedOverlapContainers: overlapContainers,
      blockedOverlapContainers,
      removedEphemeralProjects: ephemeralRoots,
    };
  }

  const removedMissingRoots = pruneStaleProjects();
  for (const root of overlapContainers) unregisterProject(root);
  for (const root of ephemeralRoots) unregisterProject(root);
  return {
    removedMissingRoots,
    removedOverlapContainers: overlapContainers,
    blockedOverlapContainers,
    removedEphemeralProjects: ephemeralRoots,
  };
}

/**
 * Interactive counterpart to {@link fixRegistryIssues}: asks once for the missing-root
 * sweep and once per overlapping pair, so `--fix-interactive` covers registry issues too
 * instead of leaving them to a separate manual `prune`/`remove` step.
 */
export async function fixRegistryIssuesInteractive(
  r: RegistryHealthReport,
): Promise<RegistryFixResult> {
  const removedMissingRoots: string[] = [];
  const missingRoots = r.entries.filter((e) => e.status === 'missing_root');
  if (missingRoots.length > 0) {
    const answer = await p.confirm({
      message: `Remove ${missingRoots.length} stale registry entr${missingRoots.length === 1 ? 'y' : 'ies'} (folder deleted)?`,
      initialValue: true,
    });
    if (!p.isCancel(answer) && answer) removedMissingRoots.push(...pruneStaleProjects());
  }

  const removedOverlapContainers: string[] = [];
  const blockedOverlapContainers: BlockedOverlapContainer[] = [];
  const overlapsByContainer = new Map(r.overlaps.map((o) => [o.ancestorRoot, o]));
  for (const o of overlapsByContainer.values()) {
    const orphanedPaths = orphanedPathsForContainer(o.ancestorRoot, r.unregisteredNestedRepos);
    const warning =
      orphanedPaths.length > 0
        ? `\n  WARNING: also drops index coverage for ${orphanedPaths.length} unregistered nested repo${orphanedPaths.length === 1 ? '' : 's'}:\n` +
          orphanedPaths.map((p) => `    ${shortPath(p)}`).join('\n')
        : '';
    const answer = await p.confirm({
      message: `Remove overlap container "${o.ancestorName}" (${shortPath(o.ancestorRoot)}), keeping "${o.descendantName}"?${warning}`,
      initialValue: orphanedPaths.length === 0,
    });
    if (p.isCancel(answer)) continue;
    if (answer) {
      unregisterProject(o.ancestorRoot);
      removedOverlapContainers.push(o.ancestorRoot);
    } else if (orphanedPaths.length > 0) {
      blockedOverlapContainers.push({ root: o.ancestorRoot, name: o.ancestorName, orphanedPaths });
    }
  }

  const removedEphemeralProjects: string[] = [];
  if (r.ephemeralProjects.length > 0) {
    const answer = await p.confirm({
      message: `Unregister ${r.ephemeralProjects.length} one-shot Multica workdir project${r.ephemeralProjects.length === 1 ? '' : 's'} (run finished, never revisited)?`,
      initialValue: true,
    });
    if (!p.isCancel(answer) && answer) {
      for (const e of r.ephemeralProjects) {
        unregisterProject(e.root);
        removedEphemeralProjects.push(e.root);
      }
    }
  }

  return {
    removedMissingRoots,
    removedOverlapContainers,
    blockedOverlapContainers,
    removedEphemeralProjects,
  };
}

function printRegistryFixResult(fix: RegistryFixResult, opts: { dryRun: boolean }): void {
  const lines: string[] = [];
  const verb = opts.dryRun ? 'Would remove' : 'Removed';
  if (fix.removedMissingRoots.length > 0) {
    lines.push(
      `${verb} ${fix.removedMissingRoots.length} stale entr${fix.removedMissingRoots.length === 1 ? 'y' : 'ies'} (folder deleted):`,
    );
    for (const r of fix.removedMissingRoots) lines.push(`  ${shortPath(r)}`);
  }
  if (fix.removedOverlapContainers.length > 0) {
    lines.push(
      `${verb} ${fix.removedOverlapContainers.length} overlap container${fix.removedOverlapContainers.length === 1 ? '' : 's'}:`,
    );
    for (const r of fix.removedOverlapContainers) lines.push(`  ${shortPath(r)}`);
  }
  if (fix.blockedOverlapContainers.length > 0) {
    lines.push(
      `Left ${fix.blockedOverlapContainers.length} overlap container${fix.blockedOverlapContainers.length === 1 ? '' : 's'} in place ` +
        '(removing would drop index coverage for unregistered nested repos):',
    );
    for (const b of fix.blockedOverlapContainers) {
      lines.push(`  ${b.name} (${shortPath(b.root)})`);
      for (const orphan of b.orphanedPaths) lines.push(`    at risk: ${shortPath(orphan)}`);
    }
    lines.push(
      "  Register the orphaned path(s) with 'trace-mcp add <path>', then re-run doctor — " +
        "or 'trace-mcp remove <container>' to accept the coverage loss explicitly.",
    );
  }
  if (fix.removedEphemeralProjects.length > 0) {
    lines.push(
      `${verb} ${fix.removedEphemeralProjects.length} one-shot Multica workdir project${fix.removedEphemeralProjects.length === 1 ? '' : 's'} ` +
        `(follow up with 'trace-mcp prune --apply' to reclaim their index DBs):`,
    );
    for (const r of fix.removedEphemeralProjects) lines.push(`  ${shortPath(r)}`);
  }
  if (lines.length === 0) return;
  console.log(lines.join('\n'));
  console.log('');
}

const REGISTRY_STATUS_LABEL: Record<RegistryEntryStatus, string> = {
  ok: 'OK',
  missing_root: 'WARNING (folder deleted)',
  db_missing: 'WARNING (index DB missing)',
  db_unreadable: 'WARNING (index DB unreadable/corrupt)',
};

function printRegistryReport(r: RegistryHealthReport): void {
  if (r.registryCorrupt) {
    console.log(
      `[CRITICAL] Project registry is corrupt: ${shortPath(r.registryPath)}\n` +
        '  trace-mcp is treating it as empty, so no projects are visible. Re-register ' +
        'with `trace-mcp add <path>` (existing per-project indexes are reused).',
    );
    return;
  }
  if (!r.registryExists || r.entries.length === 0) {
    console.log(
      'Registry: no projects registered yet. Run `trace-mcp add <project-path>` to register one.',
    );
    return;
  }
  console.log(
    `Registry: ${r.entries.length} project${r.entries.length > 1 ? 's' : ''}` +
      (r.staleCount > 0 ? `, ${r.staleCount} need attention` : ' — all healthy') +
      ` (${shortPath(r.registryPath)})`,
  );
  for (const e of r.entries) {
    if (e.status === 'ok') continue;
    console.log(`  [${REGISTRY_STATUS_LABEL[e.status]}] ${e.name}  ${shortPath(e.root)}`);
  }
  if (r.staleCount > 0) {
    console.log('  Clean up stale registrations with `trace-mcp prune --apply`.');
  }
  for (const o of r.overlaps) {
    console.log(
      `  [WARNING (overlapping roots)] "${o.ancestorName}" (${shortPath(o.ancestorRoot)}) ` +
        `contains "${o.descendantName}" (${shortPath(o.descendantRoot)})`,
    );
  }
  if (r.overlaps.length > 0) {
    console.log(
      '  Overlapping roots index and watch the same files twice — every change costs ' +
        'double CPU. Keep the per-project registrations and remove the container: ' +
        '`trace-mcp remove <container-path>`.',
    );
  }
  for (const nr of r.unregisteredNestedRepos) {
    console.log(
      `  [WARNING (unregistered nested repo)] "${nr.parentName}" (${shortPath(nr.parentRoot)}) ` +
        `contains an unregistered repo: ${shortPath(nr.nestedRepoRoot)}`,
    );
  }
  if (r.unregisteredNestedRepos.length > 0) {
    console.log(
      '  Files under these repos have zero index coverage — searches/lookups will silently ' +
        'miss them. Register each one: `trace-mcp add <nested-repo-path>`.',
    );
  }
  for (const e of r.ephemeralProjects) {
    console.log(
      `  [WARNING (stale one-shot workdir)] "${e.name}" (${shortPath(e.root)}) — ` +
        `added ${Math.round(e.ageHours / 24)}d ago, never revisited`,
    );
  }
  if (r.ephemeralProjects.length > 0) {
    console.log(
      '  These look like one-shot Multica agent-run checkouts: the run that created them is ' +
        'long finished and nothing will ever query them again, but they still get permanently ' +
        'reindexed. A running daemon deregisters them by itself once they are 3 days old ' +
        '(TRA-335); to reclaim them now, `trace-mcp doctor --fix`, or `trace-mcp remove <path>` ' +
        'then `trace-mcp prune --apply`.',
    );
  }
  console.log('');
}

function printTopologyReport(t: TopologyHealthReport): void {
  if (!t.topologyExists || t.staleCount === 0) return;
  console.log(
    `Topology: ${t.staleCount} dead entr${t.staleCount === 1 ? 'y' : 'ies'} in topology.db (folder deleted):`,
  );
  for (const s of t.staleServices) {
    console.log(`  [service] ${s.name}  ${shortPath(s.repoRoot)}`);
  }
  for (const sub of t.staleSubprojects) {
    console.log(`  [subproject] ${sub.name}  ${shortPath(sub.repoRoot)}`);
  }
  console.log(
    "  Clean up dead topology entries with 'trace-mcp prune --apply' or 'trace-mcp doctor --fix'.\n",
  );
}

function printDecisionsReport(d: DecisionsHealthReport): void {
  if (!d.decisionsExists || d.staleRoots.length === 0) return;
  console.log(
    `Decision Memory: ${d.staleDecisionsCount} orphaned decision(s) across ${d.staleRoots.length} deleted project root(s) in decisions.db:`,
  );
  for (const root of d.staleRoots) {
    console.log(`  ${shortPath(root)}`);
  }
  console.log(
    "  Clean up orphaned decisions with 'trace-mcp memory prune --apply', 'trace-mcp prune --apply', or 'trace-mcp doctor --fix'.\n",
  );
}

function printTopologyFixResult(fix: TopologyFixResult, opts: { dryRun: boolean }): void {
  const verb = opts.dryRun ? 'Would remove' : 'Removed';
  const total = fix.removedServices.length + fix.removedSubprojects.length;
  if (total === 0) return;
  const lines = [
    `${verb} ${total} dead topology entr${total === 1 ? 'y' : 'ies'} (folder deleted):`,
  ];
  for (const s of fix.removedServices) lines.push(`  [service] ${s}`);
  for (const sub of fix.removedSubprojects) lines.push(`  [subproject] ${sub}`);
  console.log(lines.join('\n'));
  console.log('');
}

function printDecisionsFixResult(fix: DecisionsFixResult, opts: { dryRun: boolean }): void {
  const verb = opts.dryRun ? 'Would remove' : 'Removed';
  if (fix.removedRoots.length === 0 && fix.removedDecisions === 0) return;
  const lines = [
    `${verb} ${fix.removedDecisions} orphaned decision(s) across ${fix.removedRoots.length} deleted project root(s):`,
  ];
  for (const r of fix.removedRoots) lines.push(`  ${shortPath(r)}`);
  console.log(lines.join('\n'));
  console.log('');
}

function printFixResults(results: FixResult[], dryRun?: boolean) {
  const prefix = dryRun ? '(dry run) ' : '';
  const applied = results.filter((r) => r.action !== 'skipped');
  const skipped = results.filter((r) => r.action === 'skipped');

  if (applied.length > 0) {
    const lines = applied.map((r) => `  ${prefix}${r.action}: ${r.detail}`);
    p.note(lines.join('\n'), dryRun ? 'Would fix' : 'Fixed');
  }

  if (skipped.length > 0) {
    const lines = skipped.map((r) => `  ${r.detail}`);
    p.note(lines.join('\n'), 'Skipped');
  }

  if (!dryRun && applied.length > 0) {
    p.outro(`Fixed ${applied.length} conflict${applied.length > 1 ? 's' : ''}.`);
  } else if (dryRun) {
    p.outro('Dry run complete — no changes made. Run with --fix to apply.');
  }
}

function shortPath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  const cwd = process.cwd();
  if (p.startsWith(cwd)) return p.slice(cwd.length + 1) || '.';
  return p;
}

interface LauncherReport {
  launcherDir: string;
  launcherPath: string;
  configPath: string;
  installedVersion: string | null;
  shippedVersion: string;
  upToDate: boolean;
  configExists: boolean;
  config: Partial<ReturnType<typeof readLauncherConfig>>;
  nodeExists: boolean;
  cliExists: boolean;
  executionCheck: { ok: boolean; detail: string };
  ok: boolean;
}

function diagnoseLauncher(opts: { json?: boolean }): 0 | 1 {
  const launcherPath = getLauncherPath();
  const configPath = getLauncherConfigPath();
  const installedVersion = readInstalledLauncherVersion();
  const config = readLauncherConfig();

  const nodeExists = !!config.node && fs.existsSync(config.node);
  const cliExists = !!config.cli && fs.existsSync(config.cli);

  let executionCheck: LauncherReport['executionCheck'] = {
    ok: false,
    detail: 'launcher not installed',
  };
  if (fs.existsSync(launcherPath)) {
    const run = spawnSync(launcherPath, ['--version'], { encoding: 'utf-8', timeout: 10_000 });
    if (run.status === 0) {
      executionCheck = { ok: true, detail: `trace-mcp ${run.stdout.trim()}` };
    } else {
      const err = (run.stderr ?? '').trim() || `exit ${run.status}`;
      executionCheck = { ok: false, detail: err };
    }
  }

  const report: LauncherReport = {
    launcherDir: getLauncherDir(),
    launcherPath,
    configPath,
    installedVersion,
    shippedVersion: LAUNCHER_VERSION,
    upToDate: installedVersion === LAUNCHER_VERSION,
    configExists: fs.existsSync(configPath),
    config,
    nodeExists,
    cliExists,
    executionCheck,
    ok: false,
  };
  report.ok =
    installedVersion === LAUNCHER_VERSION &&
    report.configExists &&
    nodeExists &&
    cliExists &&
    executionCheck.ok;

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  p.intro('trace-mcp doctor --launcher');

  const lines: string[] = [
    `Launcher dir:       ${shortPath(report.launcherDir)}`,
    `Launcher path:      ${shortPath(report.launcherPath)}`,
    `Installed version:  ${installedVersion ?? '(not installed)'}`,
    `Shipped version:    ${LAUNCHER_VERSION}`,
    `Up-to-date:         ${report.upToDate ? 'yes' : 'NO — run `trace-mcp init` to upgrade'}`,
    '',
    `Config file:        ${shortPath(report.configPath)}`,
    `Config exists:      ${report.configExists ? 'yes' : 'NO'}`,
    `  TRACE_MCP_NODE    ${config.node ?? '(unset)'}${config.node && !nodeExists ? ' — MISSING' : ''}`,
    `  TRACE_MCP_CLI     ${config.cli ?? '(unset)'}${config.cli && !cliExists ? ' — MISSING' : ''}`,
    `  TRACE_MCP_VERSION ${config.version ?? '(unset)'}`,
    '',
    `Execution check:    ${executionCheck.ok ? 'OK' : 'FAIL'}`,
    `  ${executionCheck.detail}`,
  ];
  p.note(lines.join('\n'), report.ok ? 'Launcher healthy' : 'Launcher issues detected');

  if (report.ok) {
    p.outro('MCP clients can spawn trace-mcp via the stable shim.');
  } else {
    p.outro('Fix: run `trace-mcp init` to reinstall the launcher and refresh config.');
  }
  return report.ok ? 0 : 1;
}
