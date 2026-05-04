/**
 * generate_insights_report — single-call narrative health snapshot.
 *
 * Aggregates already-computed metrics (PageRank, hotspots, edge bottlenecks,
 * self-audit, edge resolution tiers) into ~2K tokens of Markdown plus a
 * structured payload. Replaces the manual chain
 *   get_pagerank → get_risk_hotspots → get_edge_bottlenecks → self_audit
 * that agents otherwise run at the start of each session.
 *
 * The report is a thin renderer — it never recomputes anything the existing
 * tools already do, so its output stays in lockstep with them.
 */
import type { Store } from '../../db/store.js';
import { ok, type TraceMcpResult } from '../../errors.js';
import { getHotspots } from '../git/git-analysis.js';
import { getEdgeBottlenecks, type EdgeBottleneck } from './bottlenecks.js';
import { getPageRank, type PageRankResult } from './graph-analysis.js';
import { selfAudit } from './introspect.js';

export interface InsightsReport {
  generated_at: string;
  totals: {
    files: number;
    symbols: number;
    edges: number;
  };
  resolution_tiers: {
    lsp_resolved: number;
    ast_resolved: number;
    ast_inferred: number;
    text_matched: number;
    /** % of edges that are text_matched — high values mean noisy analysis */
    text_matched_pct: number;
  };
  god_files: { file: string; score: number; in_degree: number; out_degree: number }[];
  bridges: {
    source: string;
    target: string;
    bottleneck_score: number;
    is_bridge: boolean;
    co_change_weight: number;
  }[];
  hotspots: { file: string; score: number; max_cyclomatic: number; commits: number }[];
  gaps: {
    dead_exports: number;
    untested_exports: number;
    dependency_cycles: number;
    unstable_modules: number;
    dead_exports_examples: { name: string; file: string }[];
    untested_examples: { name: string; file: string }[];
  };
  /** Markdown rendering of the same data — ~1.5–2K tokens, designed for direct agent consumption */
  markdown: string;
}

interface GenerateOptions {
  cwd?: string;
  topN?: number;
}

function countResolutionTiers(store: Store): InsightsReport['resolution_tiers'] {
  const rows = store.db
    .prepare(
      `SELECT resolution_tier, COUNT(*) AS cnt
       FROM edges
       GROUP BY resolution_tier`,
    )
    .all() as Array<{ resolution_tier: string; cnt: number }>;

  const tiers = { lsp_resolved: 0, ast_resolved: 0, ast_inferred: 0, text_matched: 0 };
  let total = 0;
  for (const row of rows) {
    if (row.resolution_tier in tiers) {
      tiers[row.resolution_tier as keyof typeof tiers] = row.cnt;
    }
    total += row.cnt;
  }
  const textPct = total > 0 ? Math.round((tiers.text_matched / total) * 1000) / 10 : 0;
  return { ...tiers, text_matched_pct: textPct };
}

function renderMarkdown(report: Omit<InsightsReport, 'markdown'>): string {
  const lines: string[] = [];
  lines.push(`# Project insights — ${report.generated_at}`);
  lines.push('');
  lines.push(
    `**Totals:** ${report.totals.files} files · ${report.totals.symbols} symbols · ${report.totals.edges} edges`,
  );
  lines.push('');

  lines.push('## Edge resolution');
  const t = report.resolution_tiers;
  lines.push(
    `- lsp_resolved: ${t.lsp_resolved} · ast_resolved: ${t.ast_resolved} · ast_inferred: ${t.ast_inferred} · text_matched: ${t.text_matched}`,
  );
  if (t.text_matched_pct >= 5) {
    lines.push(
      `- ⚠ ${t.text_matched_pct}% of edges are text_matched (fuzzy). Treat raw counts in find_usages / get_change_impact with care; prefer high-tier results.`,
    );
  } else {
    lines.push(
      `- ✓ text_matched share is low (${t.text_matched_pct}%) — graph is mostly resolved.`,
    );
  }
  lines.push('');

  lines.push('## God files (PageRank)');
  if (report.god_files.length === 0) {
    lines.push('- (no files ranked)');
  } else {
    for (const g of report.god_files) {
      lines.push(
        `- \`${g.file}\` — score ${g.score.toFixed(4)} (in:${g.in_degree} out:${g.out_degree})`,
      );
    }
  }
  lines.push('');

  lines.push('## Architectural bridges');
  if (report.bridges.length === 0) {
    lines.push('- (no bottleneck edges found)');
  } else {
    for (const b of report.bridges) {
      const badge = b.is_bridge ? ' **[bridge]**' : '';
      lines.push(
        `- \`${b.source}\` → \`${b.target}\`${badge} — score ${b.bottleneck_score.toFixed(3)}, co-change ${b.co_change_weight.toFixed(2)}`,
      );
    }
  }
  lines.push('');

  lines.push('## Risk hotspots (complexity × churn)');
  if (report.hotspots.length === 0) {
    lines.push('- (no hotspots — git unavailable or no high-complexity files)');
  } else {
    for (const h of report.hotspots) {
      lines.push(
        `- \`${h.file}\` — score ${h.score.toFixed(2)} (cyclomatic ${h.max_cyclomatic}, ${h.commits} commits)`,
      );
    }
  }
  lines.push('');

  lines.push('## Gaps');
  const g = report.gaps;
  lines.push(
    `- dead exports: ${g.dead_exports} · untested exports: ${g.untested_exports} · cycles: ${g.dependency_cycles} · unstable modules: ${g.unstable_modules}`,
  );
  if (g.dead_exports_examples.length > 0) {
    lines.push(
      `- dead examples: ${g.dead_exports_examples.map((e) => `\`${e.name}\` (${e.file})`).join(', ')}`,
    );
  }
  if (g.untested_examples.length > 0) {
    lines.push(
      `- untested examples: ${g.untested_examples.map((e) => `\`${e.name}\` (${e.file})`).join(', ')}`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

export function generateInsightsReport(
  store: Store,
  opts: GenerateOptions = {},
): TraceMcpResult<InsightsReport> {
  const topN = opts.topN ?? 5;
  const cwd = opts.cwd ?? process.cwd();

  const stats = store.getStats();
  const resolution = countResolutionTiers(store);

  const pageRank: PageRankResult[] = getPageRank(store).slice(0, topN);
  const godFiles = pageRank.map((p) => ({
    file: p.file,
    score: p.score,
    in_degree: p.in_degree,
    out_degree: p.out_degree,
  }));

  const bottlenecksResult = getEdgeBottlenecks(store, { topN, sampling: 'auto' });
  const bridges: InsightsReport['bridges'] = bottlenecksResult.isOk()
    ? bottlenecksResult.value.edges.slice(0, topN).map((e: EdgeBottleneck) => ({
        source: e.sourceFile,
        target: e.targetFile,
        bottleneck_score: e.bottleneckScore,
        is_bridge: e.isBridge,
        co_change_weight: e.coChangeWeight,
      }))
    : [];

  const hotspotEntries = getHotspots(store, cwd, { limit: topN }).slice(0, topN);
  const hotspots = hotspotEntries.map((h) => ({
    file: h.file,
    score: h.score,
    max_cyclomatic: h.max_cyclomatic,
    commits: h.commits,
  }));

  const audit = selfAudit(store);
  const gaps: InsightsReport['gaps'] = {
    dead_exports: audit.summary.dead_exports,
    untested_exports: audit.summary.untested_exports,
    dependency_cycles: audit.summary.dependency_cycles,
    unstable_modules: audit.summary.unstable_modules,
    dead_exports_examples: audit.dead_exports_top10.slice(0, topN).map((d) => ({
      name: d.name,
      file: d.file,
    })),
    untested_examples: audit.untested_top10.slice(0, topN).map((u) => ({
      name: u.name,
      file: u.file,
    })),
  };

  const base: Omit<InsightsReport, 'markdown'> = {
    generated_at: new Date().toISOString(),
    totals: {
      files: stats.totalFiles,
      symbols: stats.totalSymbols,
      edges: stats.totalEdges,
    },
    resolution_tiers: resolution,
    god_files: godFiles,
    bridges,
    hotspots,
    gaps,
  };

  return ok({ ...base, markdown: renderMarkdown(base) });
}
