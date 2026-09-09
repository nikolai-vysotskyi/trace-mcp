/**
 * `trace blast` (and `trace impact`) command.
 *
 * Exposes change impact and blast-radius analysis via the CLI for external
 * harnesses (e.g. `vibe`, `lastlight`), CI gates, and shell scripts without
 * requiring an active MCP client transport.
 *
 * Modes:
 *   - Target mode: `trace blast src/foo.ts` or `trace blast myFunc`
 *     Analyzes the callers and blast radius of a specific file, symbol, or `file:line`.
 *   - Diff mode: `trace blast` or `trace blast --since origin/main`
 *     Analyzes symbols changed in git diff hunks and returns their individual
 *     and combined blast radius across the codebase.
 *
 * Exit codes:
 *   0 = Analysis succeeded (and risk is below --fail-on threshold)
 *   1 = Error occurred (missing index, invalid target/ref) OR risk >= --fail-on
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { initializeDatabase } from '../db/schema.js';
import { Store } from '../db/store.js';
import { formatToolError } from '../errors.js';
import { ensureGlobalDirs, getDbPath } from '../global.js';
import { findProjectRoot, hasRootMarkers } from '../project-root.js';
import { getProject } from '../registry.js';
import {
  type BreakingChange,
  type EnrichedDependent,
  getChangeImpact,
  type ImpactSummary,
  type ModuleImpact,
  type RiskSignals,
} from '../tools/analysis/impact.js';
import { isGitRepo } from '../tools/git/git-analysis.js';
import { type ChangedSymbolEntry, getChangedSymbols } from '../tools/quality/changed-symbols.js';
import { resolveSymbolInput } from '../tools/shared/resolve.js';
import { findUnsafeRef } from '../utils/git-env.js';

export interface BlastCliOpts {
  depth?: string;
  maxDependents?: string;
  since?: string;
  until?: string;
  diff?: boolean;
  project?: string;
  format?: 'text' | 'json';
  json?: boolean;
  failOn?: 'critical' | 'high' | 'medium' | 'low' | 'none';
}

export interface BlastReport {
  mode: 'diff' | 'target';
  target?: {
    path: string;
    symbolId?: string;
    symbolName?: string;
    kind?: string;
  };
  git?: {
    since: string;
    until: string;
    changedFiles: number;
    summary: { added: number; modified: number; removed: number; renamed: number };
  };
  changedSymbols?: ChangedSymbolEntry[];
  summary: ImpactSummary;
  risk: RiskSignals;
  totalAffected: number;
  dependents: EnrichedDependent[];
  affectedTests: { total: number; files: string[]; truncated?: boolean };
  breakingChanges?: BreakingChange[];
  byModule?: ModuleImpact[];
  byEdgeType?: Record<string, number>;
  byDepth?: Record<number, number>;
  staleFiles?: string[];
  note?: string;
}

const RISK_LEVEL_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

function resolveDbPath(projectRoot: string): string {
  const entry = getProject(projectRoot);
  if (entry) return entry.dbPath;
  return getDbPath(projectRoot);
}

export function formatBlastText(report: BlastReport): string {
  const lines: string[] = [];

  lines.push('=== Blast Radius & Impact Analysis ===');

  if (report.mode === 'target' && report.target) {
    const symDesc = report.target.symbolName
      ? ` (${report.target.symbolName}${report.target.kind ? ` [${report.target.kind}]` : ''})`
      : '';
    lines.push(`Target:         ${report.target.path}${symDesc}`);
  } else if (report.mode === 'diff' && report.git) {
    lines.push(`Diff Range:     ${report.git.since}..${report.git.until}`);
    lines.push(
      `Changed Files:  ${report.git.changedFiles} (added: ${report.git.summary.added}, modified: ${report.git.summary.modified}, removed: ${report.git.summary.removed})`,
    );
  }

  const riskLevelUpper = (report.risk?.level ?? 'low').toUpperCase();
  lines.push(`Risk Level:     ${riskLevelUpper} (score: ${report.risk?.score ?? 0}/100)`);
  lines.push(
    `Total Affected: ${report.totalAffected} dependents across ${report.summary?.totalFiles ?? 0} files (max depth: ${report.summary?.maxDepth ?? 0})`,
  );
  if (report.affectedTests) {
    lines.push(`Affected Tests: ${report.affectedTests.total} test files`);
  }
  if (report.breakingChanges && report.breakingChanges.length > 0) {
    lines.push(`Breaking Changes: ${report.breakingChanges.length} potential breaking change(s)`);
  }

  if (report.summary?.sentence) {
    lines.push('');
    lines.push(`Summary: ${report.summary.sentence}`);
  }

  if (report.risk?.mitigations && report.risk.mitigations.length > 0) {
    lines.push('');
    lines.push('Risk Mitigations:');
    for (const m of report.risk.mitigations) {
      lines.push(`  • ${m}`);
    }
  }

  if (report.changedSymbols && report.changedSymbols.length > 0) {
    lines.push('');
    lines.push(`Changed Symbols (${report.changedSymbols.length}):`);
    for (const s of report.changedSymbols) {
      const kindLetter = s.changeKind.charAt(0).toUpperCase();
      const blast = s.blastRadius !== undefined ? ` — blast radius: ${s.blastRadius} callers` : '';
      lines.push(`  [${kindLetter}] ${s.file}  ${s.name} [${s.kind}]${blast}`);
    }
  }

  if (report.dependents && report.dependents.length > 0) {
    lines.push('');
    lines.push(`Impacted Dependents (${report.dependents.length} files):`);
    // Display up to 15 dependent files in text mode
    const shown = report.dependents.slice(0, 15);
    for (const dep of shown) {
      const edgeStr = dep.edgeTypes?.length ? ` [${dep.edgeTypes.join(', ')}]` : '';
      lines.push(`  ${dep.path} (depth ${dep.depth})${edgeStr}`);
      if (dep.symbols && dep.symbols.length > 0) {
        for (const sym of dep.symbols.slice(0, 5)) {
          lines.push(`    - ${sym.symbolName} [${sym.symbolKind}]`);
        }
        if (dep.symbols.length > 5) {
          lines.push(`    ... (${dep.symbols.length - 5} more symbols)`);
        }
      }
    }
    if (report.dependents.length > 15) {
      lines.push(`  ... and ${report.dependents.length - 15} more files`);
    }
  }

  if (report.affectedTests?.files && report.affectedTests.files.length > 0) {
    lines.push('');
    lines.push(`Affected Test Files (${report.affectedTests.files.length}):`);
    for (const testFile of report.affectedTests.files.slice(0, 10)) {
      lines.push(`  • ${testFile}`);
    }
    if (report.affectedTests.files.length > 10) {
      lines.push(`  ... (${report.affectedTests.files.length - 10} more test files)`);
    }
  }

  if (report.breakingChanges && report.breakingChanges.length > 0) {
    lines.push('');
    lines.push('Breaking Changes:');
    for (const bc of report.breakingChanges) {
      lines.push(
        `  • ${bc.symbolName} [${bc.kind}] — ${bc.consumers} direct consumer(s) in ${bc.consumerFiles?.length ?? 0} file(s)`,
      );
    }
  }

  if (report.staleFiles && report.staleFiles.length > 0) {
    lines.push('');
    lines.push(
      `Note: ${report.staleFiles.length} file(s) modified since indexing. Run \`trace index\` to update index.`,
    );
  }

  if (report.note) {
    lines.push('');
    lines.push(`Note: ${report.note}`);
  }

  return lines.join('\n');
}

export const blastCommand = new Command('blast')
  .alias('impact')
  .description('Analyze blast radius and change impact for a file, symbol, or git diff')
  .argument(
    '[target]',
    'Target file path, symbol name/ID/FQN, or path:line (default: analyze git diff hunks)',
  )
  .option('-d, --depth <n>', 'Max traversal depth for caller/dependent graph', '3')
  .option('--max-dependents <n>', 'Cap on returned dependents', '200')
  .option(
    '--since <ref>',
    'Git base ref for diff mode (default: auto-detected base branch merge-base)',
  )
  .option('--until <ref>', 'Git target ref for diff mode (default: HEAD)', 'HEAD')
  .option('--diff', 'Analyze git diff hunks even if target file is specified')
  .option('--project <dir>', 'Project directory (default: auto-detected from cwd)')
  .option('--format <fmt>', 'Output format: text | json (default: text)', 'text')
  .option('--json', 'Output results as JSON (shorthand for --format json)')
  .option(
    '--fail-on <level>',
    'Exit code 1 if risk reaches or exceeds level: critical | high | medium | low | none',
    'none',
  )
  .action(async (target: string | undefined, opts: BlastCliOpts) => {
    const startDir = opts.project ? path.resolve(opts.project) : process.cwd();
    let projectRoot: string;
    try {
      projectRoot = findProjectRoot(startDir);
    } catch {
      if (hasRootMarkers(startDir)) {
        projectRoot = startDir;
      } else {
        console.error(`No project found in ${startDir}. Run \`trace init && trace add\` first.`);
        process.exit(1);
        return;
      }
    }

    const dbPath = resolveDbPath(projectRoot);
    if (!fs.existsSync(dbPath)) {
      console.error(`Project not indexed. Run \`trace init && trace add\` first.`);
      process.exit(1);
      return;
    }

    ensureGlobalDirs();
    const configResult = await loadConfig(projectRoot);
    const config = configResult.isOk() ? configResult.value : undefined;

    const db = initializeDatabase(dbPath);
    const store = new Store(db);

    const depth = Math.max(1, Math.min(20, parseInt(opts.depth ?? '3', 10) || 3));
    const maxDependents = Math.max(1, parseInt(opts.maxDependents ?? '200', 10) || 200);
    const isJson = opts.json || opts.format === 'json';

    try {
      let report: BlastReport;

      // Decide mode: diff vs target
      if (!target || opts.diff) {
        // --- DIFF MODE ---
        if (!isGitRepo(projectRoot)) {
          console.error(
            'Git diff mode requires a git repository. Run inside a git repository or specify a target: trace blast <target>',
          );
          process.exit(1);
          return;
        }

        const unsafe = findUnsafeRef({
          since: opts.since,
          until: opts.until,
          defaultBaseBranch: config?.git?.defaultBaseBranch,
        });
        if (unsafe) {
          console.error(`Invalid git ref for "${unsafe.name}": ${JSON.stringify(unsafe.value)}.`);
          process.exit(1);
          return;
        }

        const changedRes = await getChangedSymbols(store, projectRoot, {
          since: opts.since,
          until: opts.until,
          includeBlastRadius: true,
          maxBlastDepth: depth,
          defaultBaseBranch: config?.git?.defaultBaseBranch,
        });

        if (changedRes.isErr()) {
          console.error(JSON.stringify(formatToolError(changedRes.error)));
          process.exit(1);
          return;
        }

        let changedSymbols = changedRes.value.changedSymbols;

        if (target) {
          const normTarget = target.replace(/\\/g, '/');
          changedSymbols = changedSymbols.filter(
            (s) =>
              s.file === normTarget ||
              s.file.endsWith(`/${normTarget}`) ||
              s.name === target ||
              s.symbolId === target,
          );
        }

        if (changedSymbols.length === 0) {
          report = {
            mode: 'diff',
            git: {
              since: changedRes.value.since,
              until: changedRes.value.until,
              changedFiles: changedRes.value.changedFiles,
              summary: changedRes.value.summary,
            },
            changedSymbols: [],
            summary: {
              totalFiles: 0,
              totalSymbols: 0,
              maxDepth: 0,
              crossBoundary: false,
              publicApiAffected: 0,
              untestedDependents: 0,
              highComplexityDependents: 0,
              sentence: target
                ? `No changed symbols matching "${target}" detected in diff range.`
                : 'No changed symbols detected in diff range.',
            },
            risk: {
              score: 0,
              level: 'low',
              publicApiBreaking: false,
              untestedRatio: 0,
              maxComplexity: 0,
              mitigations: [],
            },
            totalAffected: 0,
            dependents: [],
            affectedTests: { total: 0, files: [] },
            staleFiles: changedRes.value.staleFiles,
          };
        } else {
          // Diff-aware impact analysis: scope to indexed symbols
          const validSymbolIds = changedSymbols
            .map((s) => s.symbolId)
            .filter((sid) => store.getSymbolBySymbolId(sid) != null)
            .slice(0, 50);

          if (validSymbolIds.length > 0) {
            const impactRes = getChangeImpact(
              store,
              { symbolIds: validSymbolIds },
              depth,
              maxDependents,
              projectRoot,
            );

            if (impactRes.isErr()) {
              console.error(JSON.stringify(formatToolError(impactRes.error)));
              process.exit(1);
              return;
            }

            const impact = impactRes.value;
            report = {
              mode: 'diff',
              git: {
                since: changedRes.value.since,
                until: changedRes.value.until,
                changedFiles: changedRes.value.changedFiles,
                summary: changedRes.value.summary,
              },
              changedSymbols,
              summary: impact.summary,
              risk: impact.risk,
              totalAffected: impact.totalAffected,
              dependents: impact.dependents,
              affectedTests: impact.affectedTests,
              breakingChanges: impact.breakingChanges,
              byModule: impact.byModule,
              byEdgeType: impact.byEdgeType,
              byDepth: impact.byDepth,
              staleFiles: changedRes.value.staleFiles,
            };
          } else {
            // Symbols detected in git diff, but not yet present in store
            report = {
              mode: 'diff',
              git: {
                since: changedRes.value.since,
                until: changedRes.value.until,
                changedFiles: changedRes.value.changedFiles,
                summary: changedRes.value.summary,
              },
              changedSymbols,
              summary: {
                totalFiles: changedRes.value.changedFiles,
                totalSymbols: changedSymbols.length,
                maxDepth: 0,
                crossBoundary: false,
                publicApiAffected: 0,
                untestedDependents: 0,
                highComplexityDependents: 0,
                sentence: `${changedSymbols.length} changed symbol(s) detected in git diff.`,
              },
              risk: {
                score: 10,
                level: 'low',
                publicApiBreaking: false,
                untestedRatio: 0,
                maxComplexity: 0,
                mitigations: [],
              },
              totalAffected: 0,
              dependents: [],
              affectedTests: { total: 0, files: [] },
              staleFiles: changedRes.value.staleFiles,
              note: 'Changed symbols are newly added or unindexed. Run `trace index` to index them.',
            };
          }
        }
      } else {
        // --- TARGET MODE ---
        let lookupTarget = target;
        let targetLine: number | undefined;
        const lineMatch = target.match(/^(.*?):(\d+)$/);
        if (lineMatch) {
          lookupTarget = lineMatch[1];
          targetLine = parseInt(lineMatch[2], 10);
        }

        const absPath = path.isAbsolute(lookupTarget)
          ? lookupTarget
          : path.resolve(startDir, lookupTarget);
        const relPath = path.relative(projectRoot, absPath).replace(/\\/g, '/');

        let targetFilePath: string | undefined;
        let targetSymbolId: string | undefined;
        let targetFqn: string | undefined;

        const file = store.getFile(lookupTarget) ?? store.getFile(relPath);
        if (file) {
          targetFilePath = file.path;
          if (targetLine !== undefined) {
            const syms = store.getSymbolsByFile(file.id);
            const containing = syms.find(
              (s) =>
                (s.line_start ?? 0) <= targetLine! &&
                (s.line_end ?? s.line_start ?? 0) >= targetLine!,
            );
            if (containing) {
              targetSymbolId = containing.symbol_id;
            }
          }
        } else {
          // Try resolving as symbol
          const resolved = resolveSymbolInput(store, {
            symbolId: lookupTarget,
            fqn: lookupTarget,
          });
          if (resolved) {
            targetSymbolId = resolved.symbol.symbol_id;
            targetFqn = resolved.symbol.fqn ?? undefined;
          } else {
            if (fs.existsSync(absPath)) {
              console.error(
                `File "${lookupTarget}" exists on disk but is not indexed. Run \`trace add\` or \`trace index-file\` first.`,
              );
            } else {
              const count = store.countSymbolsByName(lookupTarget);
              if (count > 1) {
                console.error(
                  `Multiple symbols (${count}) match name "${lookupTarget}". Please qualify with file path or symbol ID.`,
                );
              } else {
                console.error(
                  `Target "${target}" not found in project index (neither as file nor symbol).`,
                );
              }
            }
            process.exit(1);
            return;
          }
        }

        const impactRes = getChangeImpact(
          store,
          {
            filePath: targetFilePath,
            symbolId: targetSymbolId,
            fqn: targetFqn,
          },
          depth,
          maxDependents,
          projectRoot,
        );

        if (impactRes.isErr()) {
          console.error(JSON.stringify(formatToolError(impactRes.error)));
          process.exit(1);
          return;
        }

        const impact = impactRes.value;
        report = {
          mode: 'target',
          target: impact.target,
          summary: impact.summary,
          risk: impact.risk,
          totalAffected: impact.totalAffected,
          dependents: impact.dependents,
          affectedTests: impact.affectedTests,
          breakingChanges: impact.breakingChanges,
          byModule: impact.byModule,
          byEdgeType: impact.byEdgeType,
          byDepth: impact.byDepth,
        };
      }

      // Format output
      if (isJson) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatBlastText(report)}\n`);
      }

      // Check fail-on threshold
      const failLevel = opts.failOn ?? 'none';
      if (failLevel !== 'none') {
        const failRank = RISK_LEVEL_RANK[failLevel] ?? 0;
        const currentRank = RISK_LEVEL_RANK[report.risk?.level ?? 'none'] ?? 0;
        if (failRank > 0 && currentRank >= failRank) {
          process.exit(1);
        }
      }
    } finally {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
  });
