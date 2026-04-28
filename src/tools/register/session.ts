import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AnalyticsStore } from '../../analytics/analytics-store.js';
import { formatBenchmarkMarkdown, runBenchmark } from '../../analytics/benchmark.js';
import { analyzeRealSavings } from '../../analytics/real-savings.js';
import { getOptimizationReport, getSessionAnalytics } from '../../analytics/session-analytics.js';
import { syncAnalytics } from '../../analytics/sync.js';
import { detectCoverage } from '../../analytics/tech-detector.js';
import { listBundles, loadAllBundles, searchBundles } from '../../bundles.js';
import { buildProjectContext } from '../../indexer/project-context.js';
import { decisionsForResume, decisionsForTask } from '../../memory/enrichment.js';
import { registerPrompts } from '../../prompts/index.js';
import type { MetaContext } from '../../server/types.js';
import { getSessionResume } from '../../session/resume.js';
import { registerAITools } from '../ai/ai-tools.js';
import { planTurn } from '../navigation/plan-turn.js';
import { listPresets } from '../project/presets.js';
import { getIndexHealth, getProjectMap } from '../project/project.js';

export function registerSessionTools(server: McpServer, ctx: MetaContext): void {
  const {
    store,
    registry,
    config,
    projectRoot,
    savings,
    journal,
    aiProvider,
    vectorStore,
    embeddingService,
    reranker,
    has,
    j,
    jh,
    _originalTool,
    registeredToolNames,
    toolHandlers,
    presetName,
  } = ctx;

  // --- Resources ---

  server.resource(
    'project-map',
    'project://map',
    { mimeType: 'application/json', description: 'Project map (frameworks, stats, structure)' },
    async () => {
      const pCtx = buildProjectContext(projectRoot);
      const result = getProjectMap(store, registry, false, pCtx);
      return {
        contents: [{ uri: 'project://map', mimeType: 'application/json', text: j(result) }],
      };
    },
  );

  server.resource(
    'project-health',
    'project://health',
    { mimeType: 'application/json', description: 'Index health status' },
    async () => {
      const result = getIndexHealth(store, config);
      return {
        contents: [{ uri: 'project://health', mimeType: 'application/json', text: j(result) }],
      };
    },
  );

  // --- AI-powered tools (registered only when AI is enabled) ---
  if (config.ai?.enabled) {
    registerAITools(server, {
      store,
      smartInference: aiProvider.inference(),
      fastInference: aiProvider.fastInference(),
      embeddingService,
      vectorStore,
      reranker,
      projectRoot,
    });
  }

  // --- Pre-Indexed Bundles ---

  server.tool(
    'search_bundles',
    'Search pre-indexed bundles for symbols from popular libraries (React, Express, etc.). Returns symbol definitions from dependency bundles — useful for go-to-definition into node_modules/vendor. Install bundles via CLI: `trace-mcp bundles export`. For project source code search use search instead. Read-only. Returns JSON: { results: [{ name, kind, signature, bundle }], bundles_searched }.',
    {
      query: z.string().min(1).max(256).describe('Symbol name or FQN to search'),
      kind: z
        .string()
        .max(64)
        .optional()
        .describe('Filter by symbol kind (function, class, interface, etc.)'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default: 20)'),
    },
    async ({ query, kind, limit }) => {
      const bundles = loadAllBundles();
      if (bundles.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: j({
                message:
                  'No bundles installed. Use `trace-mcp bundles export` to create bundles from indexed dependencies.',
              }),
            },
          ],
        };
      }
      const results = searchBundles(bundles, query, { kind, limit });
      for (const b of bundles) b.db.close();
      return {
        content: [{ type: 'text', text: j({ results, bundles_searched: bundles.length }) }],
      };
    },
  );

  server.tool(
    'list_bundles',
    'List installed pre-indexed bundles for dependency libraries. Shows package name, version, symbol/edge counts, and size. Read-only. Returns JSON: { bundles: [{ name, version, symbols, edges, size }], total }.',
    {},
    async () => {
      const bundles = listBundles();
      return { content: [{ type: 'text', text: j({ bundles, total: bundles.length }) }] };
    },
  );

  // --- Always-registered meta tools (bypass preset gate) ---

  _originalTool(
    'get_preset_info',
    'Show active tool preset, available presets, and which tools are registered in this session. Read-only. Returns JSON: { active_preset, registered_tools, tool_names, available_presets }.',
    {},
    async () => {
      const presets = listPresets();
      return {
        content: [
          {
            type: 'text',
            text: j({
              active_preset: presetName,
              registered_tools: registeredToolNames.length,
              tool_names: registeredToolNames,
              available_presets: presets,
            }),
          },
        ],
      };
    },
  );

  // --- Analytics: Session Analytics ---
  _originalTool(
    'get_session_analytics',
    'Analyze AI agent session logs: token usage, cost breakdown by tool/server, top files, models used. Parses Claude Code JSONL logs automatically. Read-only. For waste detection use get_optimization_report; for cost trends use get_usage_trends. Returns JSON: { sessions, tokens, cost_usd, tools, models, topFiles }.',
    {
      period: z
        .enum(['today', 'week', 'month', 'all'])
        .optional()
        .describe('Time period (default: week)'),
      session_id: z.string().max(128).optional().describe('Specific session ID to analyze'),
    },
    async ({ period, session_id }) => {
      try {
        const analyticsStore = new AnalyticsStore();
        try {
          const result = getSessionAnalytics(analyticsStore, {
            period,
            sessionId: session_id,
            projectPath: projectRoot,
          });
          return { content: [{ type: 'text', text: j(result) }] };
        } finally {
          analyticsStore.close();
        }
      } catch (e) {
        return {
          content: [
            { type: 'text', text: j({ error: e instanceof Error ? e.message : String(e) }) },
          ],
          isError: true,
        };
      }
    },
  );

  // --- Analytics: Optimization Report ---
  _originalTool(
    'get_optimization_report',
    'Detect token waste patterns in AI agent sessions: repeated file reads, Bash grep instead of search, large file reads, unused trace-mcp tools. Provides savings estimates. Read-only. For usage/cost overview use get_session_analytics; for A/B savings comparison use get_real_savings. Returns JSON: { patterns: [{ type, description, savings_estimate }], total_waste }.',
    {
      period: z
        .enum(['today', 'week', 'month', 'all'])
        .optional()
        .describe('Time period (default: week)'),
    },
    async ({ period }) => {
      try {
        const analyticsStore = new AnalyticsStore();
        try {
          const result = getOptimizationReport(analyticsStore, {
            period,
            projectPath: projectRoot,
          });
          return { content: [{ type: 'text', text: j(result) }] };
        } finally {
          analyticsStore.close();
        }
      } catch (e) {
        return {
          content: [
            { type: 'text', text: j({ error: e instanceof Error ? e.message : String(e) }) },
          ],
          isError: true,
        };
      }
    },
  );

  // --- Analytics: Benchmark (preset-gated, not always registered) ---
  server.tool(
    'benchmark_project',
    'Synthetic token efficiency benchmark: compare raw file reads vs trace-mcp compact responses across symbol lookup, file exploration, search, and impact analysis scenarios. Read-only, no side effects. Use to quantify token savings. Returns JSON: { scenarios: [{ name, raw_tokens, compact_tokens, savings_pct }], summary }.',
    {
      queries: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Queries per scenario (default 10)'),
      seed: z.number().int().optional().describe('Random seed for reproducibility (default 42)'),
      format: z.enum(['json', 'markdown']).optional().describe('Output format (default: json)'),
    },
    async ({ queries, seed, format: fmt }) => {
      const result = runBenchmark(store, { queries, seed, projectName: projectRoot });
      if (fmt === 'markdown') {
        return { content: [{ type: 'text', text: formatBenchmarkMarkdown(result) }] };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  // --- Analytics: Coverage Report ---
  _originalTool(
    'get_coverage_report',
    'Technology profile of the project: detected frameworks/ORMs/UI libs from manifests (package.json, composer.json, etc.), which are covered by trace-mcp plugins, and coverage gaps. Read-only. Returns JSON: { detected, covered, gaps }.',
    {},
    async () => {
      try {
        const result = detectCoverage(projectRoot);
        return { content: [{ type: 'text', text: j(result) }] };
      } catch (e) {
        return {
          content: [
            { type: 'text', text: j({ error: e instanceof Error ? e.message : String(e) }) },
          ],
          isError: true,
        };
      }
    },
  );

  // --- Analytics: Real Savings ---
  _originalTool(
    'get_real_savings',
    'A/B comparison: how many tokens could be saved by using trace-mcp instead of raw Read/Bash file reads. Per-file breakdown. Read-only. For pattern-based waste detection use get_optimization_report instead. Returns JSON: { files: [{ file, raw_tokens, compact_tokens, savings }], total_savings }.',
    {
      period: z
        .enum(['today', 'week', 'month', 'all'])
        .optional()
        .describe('Time period (default: week)'),
    },
    async ({ period }) => {
      try {
        const analyticsStore = new AnalyticsStore();
        try {
          syncAnalytics(analyticsStore);
          const toolCalls = analyticsStore.getToolCallsForOptimization({
            projectPath: projectRoot,
            period: period ?? 'week',
          });
          const result = analyzeRealSavings(store, toolCalls, period ?? 'week');
          return { content: [{ type: 'text', text: j(result) }] };
        } finally {
          analyticsStore.close();
        }
      } catch (e) {
        return {
          content: [
            { type: 'text', text: j({ error: e instanceof Error ? e.message : String(e) }) },
          ],
          isError: true,
        };
      }
    },
  );

  // --- Analytics: Usage Trends ---
  _originalTool(
    'get_usage_trends',
    'Daily token usage time-series: sessions, tokens, estimated cost, tool calls per day. For spotting cost spikes. Read-only. For detailed session breakdown use get_session_analytics instead. Returns JSON: { days, daily: [{ date, sessions, tokens, cost_usd, tool_calls }], totals }.',
    {
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe('Number of days to show (default: 30)'),
    },
    async ({ days }) => {
      try {
        const analyticsStore = new AnalyticsStore();
        try {
          syncAnalytics(analyticsStore);
          const trends = analyticsStore.getUsageTrends(days ?? 30);
          const total = trends.reduce(
            (s, d) => ({
              sessions: s.sessions + d.sessions,
              tokens: s.tokens + d.tokens,
              cost_usd: s.cost_usd + d.cost_usd,
              tool_calls: s.tool_calls + d.tool_calls,
            }),
            { sessions: 0, tokens: 0, cost_usd: 0, tool_calls: 0 },
          );
          return {
            content: [
              { type: 'text', text: j({ days: days ?? 30, daily: trends, totals: total }) },
            ],
          };
        } finally {
          analyticsStore.close();
        }
      } catch (e) {
        return {
          content: [
            { type: 'text', text: j({ error: e instanceof Error ? e.message : String(e) }) },
          ],
          isError: true,
        };
      }
    },
  );

  // --- Session Stats ---
  _originalTool(
    'get_session_stats',
    'Token savings stats for this session: per-tool call counts, estimated token savings, reduction percentage, dedup savings. Read-only. Returns JSON: { total_calls, total_raw_tokens, total_compact_tokens, savings_pct, dedup_saved_tokens, per_tool }.',
    {},
    async () => {
      const stats = savings.getFullStats();
      const dedupTokens = journal.getDedupSavedTokens();
      return {
        content: [
          {
            type: 'text',
            text: j({
              ...stats,
              dedup_saved_tokens: dedupTokens,
            }),
          },
        ],
      };
    },
  );

  // --- Session Journal ---
  server.tool(
    'get_session_journal',
    'Session history: all tool calls made, files read, zero-result searches, and duplicate queries. Use to avoid repeating work. For a compact snapshot use get_session_snapshot instead. Read-only. Returns JSON: { calls, filesRead, zeroResults, duplicates }.',
    {},
    async () => {
      const summary = journal.getSummary();
      return {
        content: [
          {
            type: 'text',
            text: j({ ...summary, dedup_saved_tokens: journal.getDedupSavedTokens() }),
          },
        ],
      };
    },
  );

  server.tool(
    'get_session_snapshot',
    'Compact session snapshot (~200 tokens) for context recovery after compaction. Returns focus files (by read count), edited files, key searches, and dead ends. Also used by the PreCompact hook to preserve session orientation automatically. Read-only. For full journal use get_session_journal; for cross-session context use get_session_resume. Returns JSON: { focusFiles, editedFiles, keySearches, deadEnds }.',
    {
      max_files: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Max focus files to include (default: 10)'),
      max_searches: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Max key searches to include (default: 5)'),
      max_edits: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Max edited files to include (default: 10)'),
      include_negative_evidence: z
        .boolean()
        .optional()
        .describe('Include dead-end searches (default: true)'),
    },
    async ({ max_files, max_searches, max_edits, include_negative_evidence }) => {
      const snapshot = journal.getSnapshot({
        maxFiles: max_files,
        maxSearches: max_searches,
        maxEdits: max_edits,
        includeNegativeEvidence: include_negative_evidence,
      });
      return { content: [{ type: 'text', text: j(snapshot) }] };
    },
  );

  server.tool(
    'get_session_resume',
    'Cross-session context carryover: shows what was explored in recent past sessions (files touched, tools used, dead-end searches). Call at session start to orient yourself without re-reading files. Much cheaper than re-exploring the codebase. Read-only. For decision-aware wake-up use get_wake_up instead. Returns JSON: { sessions: [{ files, tools, deadEnds }], active_decisions }.',
    {
      max_sessions: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Number of past sessions to include (default: 5)'),
    },
    async ({ max_sessions }) => {
      const resume = getSessionResume(projectRoot, max_sessions ?? 5);
      // Enrich with top active decisions (code-aware memory)
      const payload: Record<string, unknown> = { ...resume };
      const ds = ctx.decisionStore;
      if (ds) {
        const topDecisions = decisionsForResume(ds, projectRoot, 5);
        if (topDecisions.length > 0) {
          payload.active_decisions = topDecisions;
        }
      }
      return { content: [{ type: 'text', text: jh('get_session_resume', payload) }] };
    },
  );

  // --- Opening-move router (plan_turn) ---
  _originalTool(
    'plan_turn',
    'Opening-move router for new tasks. Combines BM25/PageRank search + session journal (negative evidence + focus signals) + framework-aware insertion-point suggestions + change-risk + turn-budget advisor into ONE call. Returns verdict (exists/partial/missing/ambiguous), confidence, ranked targets with provenance, scaffold hints when missing, and recommended next tool calls. Call this FIRST on a new task to break the empty-result hallucination chain. Read-only. For broader task context with source code use get_task_context instead. Returns JSON: { verdict, confidence, targets, scaffoldHints, nextSteps }.',
    {
      task: z
        .string()
        .min(1)
        .max(512)
        .describe(
          'Natural-language task description (e.g. "add a webhook endpoint for stripe payments")',
        ),
      intent: z
        .enum(['bugfix', 'new_feature', 'refactor', 'understand'])
        .optional()
        .describe('Optional intent hint; auto-classified from task if omitted'),
      max_targets: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Cap on returned targets (default 5)'),
      skip_risk: z
        .boolean()
        .optional()
        .describe('Skip change-risk assessment for the top target (default false)'),
    },
    async ({ task, intent, max_targets, skip_risk }) => {
      const result = await planTurn(
        {
          store,
          projectRoot,
          journal,
          savings,
          registry,
          has,
          ai: config.ai?.enabled ? { vectorStore, embeddingService, reranker } : undefined,
        },
        { task, intent, maxTargets: max_targets, skipRisk: skip_risk },
      );
      // Enrich with relevant past decisions (code-aware memory)
      const payload: Record<string, unknown> = { ...result };
      const ds = ctx.decisionStore;
      if (ds) {
        const targetFiles = result.targets?.map((t) => t.file).filter(Boolean);
        const linked = decisionsForTask(ds, projectRoot, task, targetFiles);
        if (linked.length > 0) {
          payload.related_decisions = linked;
        }
      }
      return { content: [{ type: 'text', text: jh('plan_turn', payload) }] };
    },
  );

  // --- Batch API: multiple tool calls in one MCP request ---
  _originalTool(
    'batch',
    'Execute multiple trace-mcp tools in a single MCP request. Returns results for all calls. Use to reduce round-trips when you need several independent queries (e.g., get_outline for 3 files, or search + get_symbol together). Read-only (delegates to other tools). Returns JSON: { batch_results: [{ tool, result }], total }.',
    {
      calls: z
        .array(
          z.object({
            tool: z.string().describe('Tool name (e.g., "get_outline", "get_symbol", "search")'),
            args: z.record(z.unknown()).describe('Tool arguments'),
          }),
        )
        .min(1)
        .max(10)
        .describe('Array of tool calls to execute (max 10)'),
    },
    async ({ calls }) => {
      const results: { tool: string; result?: unknown; error?: string }[] = [];
      for (const call of calls) {
        const handler = toolHandlers.get(call.tool);
        if (!handler) {
          results.push({ tool: call.tool, error: `Unknown tool: ${call.tool}` });
          continue;
        }
        try {
          savings.recordCall(call.tool);
          const response = await handler(call.args);
          // Parse the JSON text from the response to embed inline
          const text = response.content?.[0]?.text;
          if (text) {
            try {
              const parsed = JSON.parse(text);
              // Strip per-call metadata that adds overhead in batch context:
              // _hints, _optimization_hint, _budget_warning, _budget_level are
              // per-call suggestions irrelevant when batched together
              if (parsed && typeof parsed === 'object') {
                parsed._hints = undefined;
                parsed._optimization_hint = undefined;
                parsed._budget_warning = undefined;
                parsed._budget_level = undefined;
              }
              results.push({ tool: call.tool, result: parsed });
            } catch {
              results.push({ tool: call.tool, result: text });
            }
          } else {
            results.push({ tool: call.tool, result: response });
          }
        } catch (e) {
          results.push({ tool: call.tool, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return {
        content: [{ type: 'text', text: j({ batch_results: results, total: results.length }) }],
      };
    },
  );

  // --- MCP Prompts (workflow templates) ---
  registerPrompts(server, { store, registry, config, projectRoot });
}
