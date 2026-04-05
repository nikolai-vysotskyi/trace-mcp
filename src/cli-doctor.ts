/**
 * `trace-mcp doctor` command.
 * Scans for competing MCP servers, hooks, CLAUDE.md injections, and other
 * artifacts that may conflict with trace-mcp. Optionally fixes them.
 */

import { Command } from 'commander';
import * as p from '@clack/prompts';
import { detectConflicts, type Conflict, type ConflictSeverity } from './init/conflict-detector.js';
import { fixConflict, fixAllConflicts, type FixResult } from './init/conflict-resolver.js';
import { findProjectRoot } from './project-root.js';

const SEVERITY_ICON: Record<ConflictSeverity, string> = {
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
  .description('Check for competing tools that may conflict with trace-mcp')
  .option('--fix', 'Automatically fix all fixable conflicts')
  .option('--fix-interactive', 'Fix conflicts interactively (ask for each)')
  .option('--dry-run', 'Show what --fix would do without making changes')
  .option('--json', 'Output results as JSON')
  .action(async (opts: {
    fix?: boolean;
    fixInteractive?: boolean;
    dryRun?: boolean;
    json?: boolean;
  }) => {
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
        console.log(JSON.stringify({ conflicts, fixes: results }, null, 2));
      } else {
        console.log(JSON.stringify(report, null, 2));
      }
      return;
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
    ].filter(Boolean).join(', ');

    p.note(`Found ${conflicts.length} conflict${conflicts.length > 1 ? 's' : ''}: ${summary}`, 'Scan results');

    // Display each conflict
    const lines: string[] = [];
    for (const c of conflicts) {
      lines.push(`  [${SEVERITY_LABEL[c.severity]}] ${c.summary}`);
      lines.push(`    ${c.detail}`);
      lines.push(`    Target: ${shortPath(c.target)}${c.fixable ? '  (auto-fixable)' : '  (manual fix)'}`);
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
          results.push({ conflictId: conflict.id, action: 'skipped', detail: 'User skipped', target: conflict.target });
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

    p.outro(critical.length > 0
      ? 'Critical conflicts detected — fix them for trace-mcp to work correctly.'
      : 'Minor conflicts detected — trace-mcp will work but may not be preferred by the AI.',
    );
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  const cwd = process.cwd();
  if (p.startsWith(cwd)) return p.slice(cwd.length + 1) || '.';
  return p;
}
