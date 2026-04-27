/**
 * `trace-mcp analytics` command group.
 * Subcommands: sync, report, optimize, benchmark, coverage
 */

import { Command } from 'commander';
import { AnalyticsStore } from '../analytics/analytics-store.js';
import { formatBenchmarkMarkdown, runBenchmark } from '../analytics/benchmark.js';
import { analyzeRealSavings } from '../analytics/real-savings.js';
import { getOptimizationReport, getSessionAnalytics } from '../analytics/session-analytics.js';
import { syncAnalytics } from '../analytics/sync.js';
import { detectCoverage, detectCoverageRecursive } from '../analytics/tech-detector.js';
import { initializeDatabase } from '../db/schema.js';
import { Store } from '../db/store.js';
import { ensureGlobalDirs, getDbPath } from '../global.js';
import { findProjectRoot } from '../project-root.js';
import { getProject } from '../registry.js';

function resolveDbPath(projectRoot: string): string {
  const entry = getProject(projectRoot);
  if (entry) return entry.dbPath;
  return getDbPath(projectRoot);
}

function printSingleReport(result: ReturnType<typeof detectCoverage>): void {
  const { coverage, covered, gaps, unknown, deprecated } = result;
  const pct = coverage.coverage_pct;
  const pctIcon = pct >= 80 ? '✅' : pct >= 50 ? '⚠️ ' : '❌';

  console.log(
    `\n📦 Technology Coverage  ${pctIcon} ${coverage.covered}/${coverage.total_significant} significant deps (${pct}%)`,
  );
  console.log(`   Manifests: ${result.manifests_analyzed.join(', ')}\n`);

  // Covered — compact, just names
  if (covered.length > 0) {
    const names = covered.map((d) => d.name).join('  ');
    console.log(`✅ Covered (${covered.length}): ${names}`);
  }

  // Gaps — always verbose, these are actionable
  if (gaps.length > 0) {
    console.log(`\n⚠️  Gaps — no plugin (${gaps.length}):`);
    for (const g of gaps) {
      console.log(`   [${g.priority.padEnd(6)}] ${g.name} ${g.version}`);
    }
  }

  // Deprecated — actionable warnings with upgrade paths
  if (deprecated.length > 0) {
    console.log(`\n⛔ Deprecated packages (${deprecated.length}):`);
    for (const d of deprecated) {
      console.log(`   ${d.name} ${d.version} → ${d.successor}`);
    }
  }

  // Unknown — summary line, then only "likely" verbose
  if (unknown.length > 0) {
    const likely = unknown.filter((u) => u.needs_plugin === 'likely');
    const maybe = unknown.filter((u) => u.needs_plugin === 'maybe');
    const no = unknown.filter((u) => u.needs_plugin === 'no');

    const parts = [
      likely.length ? `🔴 needs plugin: ${likely.length}` : '',
      maybe.length ? `🟡 review: ${maybe.length}` : '',
      no.length ? `🟢 ok: ${no.length}` : '',
    ]
      .filter(Boolean)
      .join('  ·  ');

    console.log(`\n📋 Not in catalog (${unknown.length})  ${parts}`);

    if (likely.length > 0) {
      console.log(`   — should add to catalog:`);
      for (const u of likely) {
        console.log(`   ${u.name} [${u.ecosystem}] — ${u.reason}`);
      }
    }
    if (maybe.length > 0) {
      const names = maybe.map((u) => u.name).join('  ');
      console.log(`   — review: ${names}`);
    }
  }

  console.log('');
}

export const analyticsCommand = new Command('analytics').description(
  'AI agent session analytics: sync logs, view reports, find optimizations',
);

// --- sync ---
analyticsCommand
  .command('sync')
  .description('Parse Claude Code session logs into analytics database')
  .option('--full', 'Force full rescan of all sessions', false)
  .option('--project <path>', 'Filter by project path')
  .action(async (opts: { full: boolean; project?: string }) => {
    ensureGlobalDirs();
    const analyticsStore = new AnalyticsStore();
    try {
      const result = syncAnalytics(analyticsStore, { full: opts.full });
      console.log(
        `Scanned: ${result.files_scanned}, Parsed: ${result.files_parsed}, Skipped: ${result.files_skipped}, Errors: ${result.errors}`,
      );
    } finally {
      analyticsStore.close();
    }
  });

// --- report ---
analyticsCommand
  .command('report')
  .description('Show session analytics: token usage, costs, tool breakdown')
  .option('--period <p>', 'Period: today, week, month, all', 'week')
  .option('--project <path>', 'Filter by project path')
  .option('--format <fmt>', 'Output: text | json', 'text')
  .action(async (opts: { period: string; project?: string; format: string }) => {
    ensureGlobalDirs();
    const analyticsStore = new AnalyticsStore();
    try {
      const result = getSessionAnalytics(analyticsStore, {
        period: opts.period as 'today' | 'week' | 'month' | 'all',
        projectPath: opts.project,
      });

      if (opts.format === 'json') {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`\n📊 Session Analytics (${result.period})\n`);
      console.log(`Sessions: ${result.sessionsCount}`);
      console.log(`Tool calls: ${result.totals.toolCalls}`);
      console.log(`Input tokens: ${result.totals.inputTokens.toLocaleString()}`);
      console.log(`Output tokens: ${result.totals.outputTokens.toLocaleString()}`);
      console.log(`Cache read: ${result.totals.cacheReadTokens.toLocaleString()}`);
      console.log(`Estimated cost: $${result.totals.estimatedCostUsd.toFixed(2)}`);

      if (result.topTools.length > 0) {
        console.log(`\nTop tools:`);
        for (const t of result.topTools.slice(0, 10)) {
          console.log(
            `  ${t.name}: ${t.calls} calls (~${t.outputTokensEst.toLocaleString()} tokens)`,
          );
        }
      }

      if (result.topFiles.length > 0) {
        console.log(`\nTop files:`);
        for (const f of result.topFiles.slice(0, 10)) {
          console.log(`  ${f.path}: ${f.reads} reads (~${f.tokensEst.toLocaleString()} tokens)`);
        }
      }
    } finally {
      analyticsStore.close();
    }
  });

// --- optimize ---
analyticsCommand
  .command('optimize')
  .description('Detect token waste patterns and suggest optimizations')
  .option('--period <p>', 'Period: today, week, month, all', 'week')
  .option('--project <path>', 'Filter by project path')
  .option('--format <fmt>', 'Output: text | json', 'text')
  .action(async (opts: { period: string; project?: string; format: string }) => {
    ensureGlobalDirs();
    const analyticsStore = new AnalyticsStore();
    try {
      const result = getOptimizationReport(analyticsStore, {
        period: opts.period as 'today' | 'week' | 'month' | 'all',
        projectPath: opts.project,
      });

      if (opts.format === 'json') {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`\n🔍 Optimization Report (${result.period})\n`);
      console.log(
        `Current usage: ${result.currentUsage.totalTokens.toLocaleString()} tokens (~$${result.currentUsage.estimatedCostUsd.toFixed(2)})`,
      );

      if (result.optimizations.length === 0) {
        console.log('\nNo optimization opportunities found.');
      } else {
        for (const opt of result.optimizations) {
          const saved = opt.currentTokens - opt.potentialTokens;
          const pct = opt.currentTokens > 0 ? Math.round((saved / opt.currentTokens) * 100) : 0;
          console.log(`\n[${opt.severity}] ${opt.rule}: ${opt.occurrences} occurrences`);
          console.log(
            `  Current: ${opt.currentTokens.toLocaleString()} tokens → Potential: ${opt.potentialTokens.toLocaleString()} tokens`,
          );
          console.log(`  Savings: ${saved.toLocaleString()} tokens (${pct}%)`);
          console.log(`  ${opt.recommendation}`);
        }
        console.log(
          `\nTotal potential savings: ${result.totalPotentialSavings.tokens.toLocaleString()} tokens (~$${result.totalPotentialSavings.costUsd.toFixed(2)}, ${result.totalPotentialSavings.pct}%)`,
        );
      }
    } finally {
      analyticsStore.close();
    }
  });

// --- benchmark ---
analyticsCommand
  .command('benchmark')
  .description('Run synthetic token efficiency benchmark')
  .option('--queries <n>', 'Queries per scenario', '10')
  .option('--seed <n>', 'Random seed', '42')
  .option('--format <fmt>', 'Output: json | markdown | text', 'text')
  .action(async (opts: { queries: string; seed: string; format: string }) => {
    let projectRoot: string;
    try {
      projectRoot = findProjectRoot(process.cwd());
    } catch {
      projectRoot = process.cwd();
    }

    const dbPath = resolveDbPath(projectRoot);
    const db = initializeDatabase(dbPath);
    const store = new Store(db);
    try {
      const result = runBenchmark(store, {
        queries: parseInt(opts.queries, 10),
        seed: parseInt(opts.seed, 10),
        projectName: projectRoot,
      });

      if (opts.format === 'json') {
        console.log(JSON.stringify(result, null, 2));
      } else if (opts.format === 'markdown') {
        console.log(formatBenchmarkMarkdown(result));
      } else {
        console.log(`\n⚡ Token Efficiency Benchmark\n`);
        console.log(`Project: ${result.project}`);
        console.log(
          `Index: ${result.index_stats.files} files, ${result.index_stats.symbols} symbols\n`,
        );

        for (const s of result.scenarios) {
          const reduction = s.reduction_pct.toFixed(1);
          console.log(
            `${s.name}: ${s.baseline_tokens.toLocaleString()} → ${s.trace_mcp_tokens.toLocaleString()} tokens (${reduction}% reduction)`,
          );
        }

        console.log(
          `\nTotal: ${result.totals.baseline_tokens.toLocaleString()} → ${result.totals.trace_mcp_tokens.toLocaleString()} (${result.totals.reduction_pct}% reduction)`,
        );
      }
    } finally {
      db.close();
    }
  });

// --- coverage ---
analyticsCommand
  .command('coverage')
  .description('Show technology coverage: detected deps vs trace-mcp plugin support')
  .option('--format <fmt>', 'Output: text | json', 'text')
  .option('--no-recursive', 'Only scan root project (skip child/subproject directories)')
  .action(async (opts: { format: string; recursive: boolean }) => {
    let projectRoot: string;
    try {
      projectRoot = findProjectRoot(process.cwd());
    } catch {
      projectRoot = process.cwd();
    }

    if (!opts.recursive) {
      // Single-project mode (original behavior)
      const result = detectCoverage(projectRoot);

      if (opts.format === 'json') {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printSingleReport(result);
      return;
    }

    // Recursive multi-project mode (default)
    const result = detectCoverageRecursive(projectRoot);

    if (opts.format === 'json') {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const { aggregate, projects } = result;

    if (projects.length <= 1) {
      // Single project found — same output as before
      if (projects.length === 1) {
        printSingleReport(projects[0]);
      } else {
        console.log('\n📦 Technology Coverage Report\n');
        console.log('No manifests found.');
      }
      return;
    }

    // Multi-project summary — aggregate only, no per-project listing
    const {
      covered: covCount,
      total_significant: totalSig,
      coverage_pct: pct,
      total_projects,
    } = aggregate;
    const pctIcon = pct >= 80 ? '✅' : pct >= 50 ? '⚠️ ' : '❌';

    // Deduplicate gaps, unknowns, and deprecated across all projects
    const allGaps = new Map<string, (typeof projects)[0]['gaps'][0]>();
    const allUnknown = new Map<string, (typeof projects)[0]['unknown'][0]>();
    const allDeprecated = new Map<string, (typeof projects)[0]['deprecated'][0]>();
    for (const proj of projects) {
      for (const g of proj.gaps) if (!allGaps.has(g.name)) allGaps.set(g.name, g);
      for (const u of proj.unknown) if (!allUnknown.has(u.name)) allUnknown.set(u.name, u);
      for (const d of proj.deprecated) if (!allDeprecated.has(d.name)) allDeprecated.set(d.name, d);
    }
    const gaps = [...allGaps.values()].sort((a, b) => {
      const prio = { high: 0, medium: 1, low: 2 };
      return (
        (prio[a.priority as keyof typeof prio] ?? 3) - (prio[b.priority as keyof typeof prio] ?? 3)
      );
    });
    const unknown = [...allUnknown.values()];
    const likely = unknown.filter((u) => u.needs_plugin === 'likely');
    const maybe = unknown.filter((u) => u.needs_plugin === 'maybe');
    const deprecated = [...allDeprecated.values()];

    console.log(
      `\n📦 Technology Coverage  ${pctIcon} ${covCount}/${totalSig} significant deps (${pct}%)  ·  ${total_projects} projects\n`,
    );

    if (gaps.length > 0) {
      console.log(`⚠️  Gaps — no plugin (${gaps.length}):`);
      for (const g of gaps) {
        console.log(`   [${g.priority.padEnd(6)}] ${g.name}`);
      }
    }

    if (deprecated.length > 0) {
      console.log(`\n⛔ Deprecated packages (${deprecated.length}):`);
      for (const d of deprecated) {
        console.log(`   ${d.name} → ${d.successor}`);
      }
    }

    if (unknown.length > 0) {
      const parts = [
        likely.length ? `🔴 needs plugin: ${likely.length}` : '',
        maybe.length ? `🟡 review: ${maybe.length}` : '',
        unknown.length - likely.length - maybe.length
          ? `🟢 ok: ${unknown.length - likely.length - maybe.length}`
          : '',
      ]
        .filter(Boolean)
        .join('  ·  ');
      console.log(`\n📋 Not in catalog (${unknown.length})  ${parts}`);
      if (likely.length > 0) {
        console.log(`   — should add to catalog:`);
        for (const u of likely) console.log(`   ${u.name} [${u.ecosystem}] — ${u.reason}`);
      }
      if (maybe.length > 0) {
        console.log(`   — review: ${maybe.map((u) => u.name).join('  ')}`);
      }
    }

    console.log('');
  });

// --- savings ---
analyticsCommand
  .command('savings')
  .description('Analyze real savings: how much trace-mcp could save vs raw file reads')
  .option('--period <p>', 'Period: today, week, month, all', 'week')
  .option('--format <fmt>', 'Output: text | json', 'text')
  .action(async (opts: { period: string; format: string }) => {
    let projectRoot: string;
    try {
      projectRoot = findProjectRoot(process.cwd());
    } catch {
      projectRoot = process.cwd();
    }

    ensureGlobalDirs();
    const analyticsStore = new AnalyticsStore();
    const dbPath = resolveDbPath(projectRoot);
    const db = initializeDatabase(dbPath);
    const store = new Store(db);
    try {
      syncAnalytics(analyticsStore);
      const toolCalls = analyticsStore.getToolCallsForOptimization({
        projectPath: projectRoot,
        period: opts.period as any,
      });
      const result = analyzeRealSavings(store, toolCalls, opts.period);

      if (opts.format === 'json') {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`\n💰 Real Savings Analysis (${result.period})\n`);
      console.log(`Sessions analyzed: ${result.sessionsAnalyzed}`);
      console.log(
        `File reads: ${result.fileReadsAnalyzed} (${result.filesInIndex} in index, ${result.filesNotIndexed} not indexed)`,
      );
      console.log(`\nTotal read tokens: ${result.summary.totalReadTokens.toLocaleString()}`);
      console.log(
        `Achievable with trace-mcp: ${result.summary.achievableWithTraceMcp.toLocaleString()}`,
      );
      console.log(
        `Potential savings: ${result.summary.potentialSavingsTokens.toLocaleString()} tokens (${result.summary.potentialSavingsPct}%)`,
      );

      const costs = Object.entries(result.summary.potentialCostSavings);
      if (costs.length > 0) {
        console.log(`Cost savings: ${costs.map(([m, v]) => `${v} (${m})`).join(', ')}`);
      }

      if (result.byFile.length > 0) {
        console.log(`\nTop files by savings:`);
        for (const f of result.byFile.slice(0, 10)) {
          const saved = f.totalReadTokens - f.alternativeTokens;
          console.log(
            `  ${f.file}: ${f.reads} reads, ${saved.toLocaleString()} tokens saveable (${f.savingsPct}%)`,
          );
        }
      }

      if (result.abComparison) {
        const ab = result.abComparison;
        console.log(`\nA/B Comparison:`);
        console.log(
          `  With trace-mcp (${ab.sessionsWithTraceMcp.count} sessions): ${ab.sessionsWithTraceMcp.avgTokensPerSession.toLocaleString()} avg tokens, ${ab.sessionsWithTraceMcp.avgToolCalls} avg calls`,
        );
        console.log(
          `  Without (${ab.sessionsWithoutTraceMcp.count} sessions): ${ab.sessionsWithoutTraceMcp.avgTokensPerSession.toLocaleString()} avg tokens, ${ab.sessionsWithoutTraceMcp.avgToolCalls} avg calls`,
        );
        console.log(
          `  Difference: ${ab.difference.tokensSavedPct}% fewer tokens, ${ab.difference.fewerToolCallsPct}% fewer calls`,
        );
      }
    } finally {
      db.close();
      analyticsStore.close();
    }
  });

// --- trends ---
analyticsCommand
  .command('trends')
  .description('Show daily usage trends: tokens, cost, sessions over time')
  .option('--days <n>', 'Number of days', '30')
  .option('--format <fmt>', 'Output: text | json', 'text')
  .action(async (opts: { days: string; format: string }) => {
    ensureGlobalDirs();
    const analyticsStore = new AnalyticsStore();
    try {
      syncAnalytics(analyticsStore);
      const days = parseInt(opts.days, 10);
      const trends = analyticsStore.getUsageTrends(days);

      if (opts.format === 'json') {
        console.log(JSON.stringify(trends, null, 2));
        return;
      }

      console.log(`\n📈 Usage Trends (last ${days} days)\n`);
      console.log('Date         Sessions  Tokens       Cost     Tool Calls');
      console.log('─'.repeat(60));
      for (const d of trends) {
        const date = d.date.padEnd(12);
        const sessions = String(d.sessions).padStart(4);
        const tokens = (d.tokens ?? 0).toLocaleString().padStart(12);
        const cost = `$${(d.cost_usd ?? 0).toFixed(2)}`.padStart(8);
        const calls = String(d.tool_calls ?? 0).padStart(10);
        console.log(`${date} ${sessions}  ${tokens}  ${cost}  ${calls}`);
      }

      const total = trends.reduce(
        (s, d) => ({
          sessions: s.sessions + d.sessions,
          tokens: s.tokens + (d.tokens ?? 0),
          cost: s.cost + (d.cost_usd ?? 0),
          calls: s.calls + (d.tool_calls ?? 0),
        }),
        { sessions: 0, tokens: 0, cost: 0, calls: 0 },
      );
      console.log('─'.repeat(60));
      console.log(
        `Total        ${String(total.sessions).padStart(4)}  ${total.tokens.toLocaleString().padStart(12)}  $${total.cost.toFixed(2).padStart(7)}  ${String(total.calls).padStart(10)}`,
      );
    } finally {
      analyticsStore.close();
    }
  });
