/**
 * Single-call orientation tool — `get_minimal_context`.
 *
 * Borrowed wholesale from CRG v2.2.1 (`get_minimal_context_tool`). The point
 * is to break the "I just opened a session, what does this repo look like?"
 * loop in ~150 tokens instead of the ~3K an agent would spend chaining
 * get_project_map + get_pagerank + get_risk_hotspots + get_communities.
 *
 * The tool aggregates signals we already compute and routes to the right
 * follow-up tool based on the agent's stated intent. It is intentionally
 * shallow — it never fans out to summarisation, embeddings, or git, so it
 * stays sub-millisecond on a warm SQLite cache.
 *
 * Output shape (Zod-typed below):
 *   project    — name, fileCount, symbolCount, top 3 frameworks
 *   health     — top 3 hotspots, top 3 PageRank-central files
 *   communities— top 3 communities by file count
 *   next_steps — 3-5 ranked tool suggestions, each with a one-line hint
 */
import type { Store } from '../../db/store.js';
import { getCommunities } from '../analysis/communities.js';
import { getPageRank } from '../analysis/graph-analysis.js';
import { getHotspots } from '../git/git-analysis.js';
import { getProjectMap } from './project.js';
import type { PluginRegistry } from '../../plugin-api/registry.js';
import type { TraceMcpConfig } from '../../config.js';
import type { ProjectContext } from '../../plugin-api/types.js';

export type MinimalContextTask =
  | 'understand'
  | 'review'
  | 'refactor'
  | 'debug'
  | 'add_feature'
  | undefined;

export interface MinimalContext {
  project: {
    name: string;
    fileCount: number;
    symbolCount: number;
    frameworks: string[];
  };
  health: {
    top_hotspots: Array<{ file: string; score: number }>;
    top_central: Array<{ file: string; pagerank: number }>;
  };
  communities: {
    total: number;
    top: Array<{ label: string; fileCount: number; cohesion: number }>;
  };
  next_steps: Array<{ tool: string; args?: Record<string, unknown>; hint: string }>;
  _meta: {
    task: MinimalContextTask;
    intent_inferred: boolean;
  };
}

const SUGGESTIONS_BY_TASK: Record<NonNullable<MinimalContextTask>, MinimalContext['next_steps']> = {
  understand: [
    {
      tool: 'get_task_context',
      args: { task: '<paste the user request verbatim>', focus: 'broad' },
      hint: 'One-call execution context for an unfamiliar task',
    },
    {
      tool: 'get_outline',
      hint: 'Read a file by path — signatures only, ~80% cheaper than Read',
    },
    {
      tool: 'search',
      args: { fusion: true, detail_level: 'minimal' },
      hint: 'Locate a symbol by name; minimal mode keeps the response under 100 tokens',
    },
  ],
  review: [
    {
      tool: 'compare_branches',
      hint: 'Symbol-level diff for the current branch vs main',
    },
    {
      tool: 'get_changed_symbols',
      hint: 'List of changed functions/classes/methods since the merge-base',
    },
    {
      tool: 'check_quality_gates',
      args: { scope: 'changed' },
      hint: 'CI-grade quality check on just the changed surface',
    },
    {
      tool: 'scan_security',
      args: { rules: ['all'] },
      hint: 'OWASP Top-10 sweep before requesting review',
    },
  ],
  refactor: [
    {
      tool: 'assess_change_risk',
      hint: 'Risk score + factors before touching the symbol',
    },
    {
      tool: 'get_change_impact',
      hint: 'Reverse dependency report — what breaks if you change X',
    },
    {
      tool: 'get_refactor_candidates',
      hint: 'High-complexity, multi-caller functions worth extracting',
    },
    {
      tool: 'plan_refactoring',
      hint: 'Preview rename/move/extract/signature changes before applying',
    },
  ],
  debug: [
    {
      tool: 'predict_bugs',
      hint: 'Multi-signal prediction of which files are likely to contain a bug',
    },
    {
      tool: 'get_risk_hotspots',
      hint: 'Files with both high cyclomatic complexity and high git churn',
    },
    {
      tool: 'taint_analysis',
      hint: 'Data-flow trace from untrusted sources to dangerous sinks',
    },
    {
      tool: 'get_call_graph',
      hint: 'Bidirectional view of what reaches the suspect symbol',
    },
  ],
  add_feature: [
    {
      tool: 'plan_turn',
      args: { task: '<one-line description of the feature>' },
      hint: 'Opening-move router — verdict, confidence, scaffolding hints',
    },
    {
      tool: 'check_duplication',
      hint: 'Before creating new functions, check no equivalent already exists',
    },
    {
      tool: 'get_feature_context',
      args: { description: '<feature description>' },
      hint: 'Ranked source snippets relevant to a natural-language description',
    },
  ],
};

const INTENT_KEYWORDS: Array<[NonNullable<MinimalContextTask>, RegExp]> = [
  ['review', /\b(review|pr|pull request|approve|merge)\b/i],
  ['refactor', /\b(refactor|rename|extract|move|cleanup|deduplicate)\b/i],
  ['debug', /\b(bug|fix|broken|error|crash|fail|regression|investigate)\b/i],
  ['add_feature', /\b(add|implement|create|new feature|wire up|introduce)\b/i],
];

export function inferTask(query: string | undefined): MinimalContextTask {
  if (!query) return undefined;
  for (const [task, re] of INTENT_KEYWORDS) {
    if (re.test(query)) return task;
  }
  return undefined;
}

export function getMinimalContext(
  store: Store,
  registry: PluginRegistry,
  config: TraceMcpConfig,
  projectRoot: string,
  ctx: ProjectContext,
  options: { task?: string; intent?: NonNullable<MinimalContextTask> } = {},
): MinimalContext {
  // 1. Project shape — frameworks + counts.
  const summary = getProjectMap(store, registry, true, ctx);
  const frameworks = (summary.frameworks ?? []).slice(0, 3);

  // 2. Health — hotspots + PageRank.
  let topHotspots: Array<{ file: string; score: number }> = [];
  try {
    const hotspotsResult = getHotspots(store, projectRoot, { limit: 3 });
    if (Array.isArray(hotspotsResult)) {
      topHotspots = hotspotsResult.map((h: { file: string; score: number }) => ({
        file: h.file,
        score: Math.round(h.score * 100) / 100,
      }));
    } else if (
      hotspotsResult &&
      typeof hotspotsResult === 'object' &&
      'hotspots' in hotspotsResult
    ) {
      const arr = (hotspotsResult as { hotspots: Array<{ file: string; score: number }> }).hotspots;
      topHotspots = arr.slice(0, 3).map((h) => ({
        file: h.file,
        score: Math.round(h.score * 100) / 100,
      }));
    }
  } catch {
    /* git unavailable — leave empty */
  }

  let topCentral: Array<{ file: string; pagerank: number }> = [];
  try {
    const pageRankResult = getPageRank(store, 3);
    const ranked = Array.isArray(pageRankResult) ? pageRankResult : [];
    topCentral = ranked.slice(0, 3).map((r: { file: string; score: number }) => ({
      file: r.file,
      pagerank: Math.round(r.score * 10000) / 10000,
    }));
  } catch {
    /* PageRank not yet computed */
  }

  // 3. Communities — already detected; ignore if not yet run.
  let communitiesSummary: MinimalContext['communities'] = { total: 0, top: [] };
  try {
    const c = getCommunities(store);
    if (c.isOk()) {
      const data = c.value;
      communitiesSummary = {
        total: data.communities.length,
        top: data.communities.slice(0, 3).map((cc) => ({
          label: cc.label,
          fileCount: cc.fileCount,
          cohesion: cc.cohesion,
        })),
      };
    }
  } catch {
    /* not detected yet */
  }

  // 4. Task-routed next steps. Explicit `intent` wins; otherwise infer from
  //    the natural-language `task` field; otherwise default to `understand`.
  const inferred = options.intent ?? inferTask(options.task);
  const taskKey: NonNullable<MinimalContextTask> = inferred ?? 'understand';
  const next_steps = SUGGESTIONS_BY_TASK[taskKey];

  return {
    project: {
      name: summary.name ?? '<unknown>',
      fileCount: summary.fileCount ?? 0,
      symbolCount: summary.symbolCount ?? 0,
      frameworks,
    },
    health: {
      top_hotspots: topHotspots,
      top_central: topCentral,
    },
    communities: communitiesSummary,
    next_steps,
    _meta: {
      task: inferred,
      intent_inferred: !options.intent && !!inferred,
    },
  };
}
