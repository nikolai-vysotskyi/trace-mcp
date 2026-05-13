import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

declare const PKG_VERSION_INJECTED: string;
const PKG_VERSION =
  typeof PKG_VERSION_INJECTED !== 'undefined' ? PKG_VERSION_INJECTED : '0.0.0-dev';

import {
  type AIProvider,
  BlobVectorStore,
  createAIProvider,
  type RerankerService,
} from '../ai/index.js';
import { LLMReranker } from '../ai/reranker.js';
import type { TraceMcpConfig } from '../config.js';
import type { Store } from '../db/store.js';
import { formatToolError } from '../errors.js';
import {
  DECISIONS_DB_PATH,
  ensureGlobalDirs,
  getSnapshotPath,
  TOPOLOGY_DB_PATH,
} from '../global.js';
import { buildProjectContext } from '../indexer/project-context.js';
import { logger } from '../logger.js';
import { DecisionStore } from '../memory/decision-store.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type { ProgressState } from '../progress.js';
import { computePageRank } from '../scoring/pagerank.js';
import { RankingLedger } from '../runtime/ranking-ledger.js';
import { TelemetrySink } from '../runtime/telemetry-sink.js';
import { SessionJournal, type StructuralLandmark } from '../session/journal.js';
import { CodexSessionProvider } from '../session/providers/codex.js';
import { HermesSessionProvider } from '../session/providers/hermes.js';
import { getSessionProviderRegistry } from '../session/providers/registry.js';
import { flushSessionSummary } from '../session/resume.js';
import { SessionTracker } from '../session/tracker.js';
import { resolvePreset } from '../tools/project/presets.js';
import { registerAdvancedTools } from '../tools/register/advanced.js';
import { registerAnalysisTools } from '../tools/register/analysis.js';
import { registerCoreTools } from '../tools/register/core.js';
import { registerFrameworkTools } from '../tools/register/framework.js';
import { registerGitTools } from '../tools/register/git.js';
import { registerKnowledgeTools } from '../tools/register/knowledge.js';
import { registerMemoryTools } from '../tools/register/memory.js';
import { registerNavigationTools } from '../tools/register/navigation.js';
import { registerQualityTools } from '../tools/register/quality.js';
import { registerRefactoringTools } from '../tools/register/refactoring.js';
import { registerSessionTools } from '../tools/register/session.js';
import { withHints } from '../tools/shared/hints.js';
import { TopologyStore } from '../topology/topology-db.js';
import { sanitizeValue } from '../utils/mcp-sanitize.js';
import { validatePath } from '../utils/security.js';
import { createExploredTracker } from './explored-tracker.js';
import { startHeartbeat } from './heartbeat.js';
import { buildInstructions } from './instructions.js';
import { installToolGate } from './tool-gate.js';
import type { MetaContext, ServerContext } from './types.js';

/** Compact JSON — no pretty-printing, strip nulls; saves 25–35% tokens on every response.
 * Every string in the payload is run through {@link sanitizeValue} first to defuse
 * prompt-injection delivered through indexed source code (synthetic framing tags,
 * U+2028/U+2029, raw C0 controls). */
function j(value: unknown): string {
  return JSON.stringify(sanitizeValue(value), (_key, val) =>
    val === null || val === undefined ? undefined : val,
  );
}

/** Extract result count from an MCP tool response for journal tracking */
function extractResultCount(response: {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}): number {
  if (response?.isError) return 0;
  try {
    const text = response?.content?.[0]?.text;
    if (!text) return 0;
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return 1;
    if (typeof parsed.total === 'number') return parsed.total;
    if (Array.isArray(parsed.items)) return parsed.items.length;
    if (Array.isArray(parsed.symbols)) return parsed.symbols.length;
    if (Array.isArray(parsed.references)) return parsed.references.length;
    if (Array.isArray(parsed.data)) return parsed.data.length;
    return 1;
  } catch {
    return 1;
  }
}

/**
 * Extract a compact snapshot of a tool result for session-aware dedup.
 */
function extractCompactResult(
  toolName: string,
  response: { content: Array<{ type: string; text: string }>; isError?: boolean },
): Record<string, unknown> | undefined {
  const DEDUP_TOOLS = new Set([
    'get_symbol',
    'get_outline',
    'get_context_bundle',
    'get_call_graph',
    'get_type_hierarchy',
    'get_import_graph',
    'get_dependency_diagram',
    'get_component_tree',
    'get_dataflow',
    'get_control_flow',
    'get_middleware_chain',
    'get_di_tree',
    'get_model_context',
    'get_schema',
  ]);
  if (!DEDUP_TOOLS.has(toolName)) return undefined;
  if (response?.isError) return undefined;

  try {
    const text = response?.content?.[0]?.text;
    if (!text) return undefined;
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return undefined;

    switch (toolName) {
      case 'get_symbol':
        return {
          symbol_id: parsed.symbol_id,
          name: parsed.name,
          kind: parsed.kind,
          fqn: parsed.fqn,
          signature: parsed.signature,
          file: parsed.file,
          line_start: parsed.line_start,
          line_end: parsed.line_end,
          _result_count: 1,
        };
      case 'get_outline':
        return {
          path: parsed.path,
          language: parsed.language,
          symbols: Array.isArray(parsed.symbols)
            ? parsed.symbols.map((s: Record<string, unknown>) => ({
                symbolId: s.symbolId,
                name: s.name,
                kind: s.kind,
                signature: s.signature,
                lineStart: s.lineStart,
                lineEnd: s.lineEnd,
              }))
            : [],
          _result_count: Array.isArray(parsed.symbols) ? parsed.symbols.length : 1,
        };
      case 'get_context_bundle':
        return {
          primary: Array.isArray(parsed.primary)
            ? parsed.primary.map((s: Record<string, unknown>) => ({
                symbol_id: s.symbol_id,
                name: s.name,
                kind: s.kind,
                file: s.file,
                line: s.line,
              }))
            : [],
          totalTokens: parsed.totalTokens,
          _result_count: Array.isArray(parsed.primary) ? parsed.primary.length : 1,
        };
      case 'get_call_graph':
        return {
          root: parsed.root,
          direction: parsed.direction,
          node_count: parsed.nodes?.length ?? parsed.node_count ?? 0,
          nodes: Array.isArray(parsed.nodes)
            ? parsed.nodes.map((n: Record<string, unknown>) => ({
                symbol_id: n.symbol_id,
                name: n.name,
                kind: n.kind,
                file: n.file,
              }))
            : [],
          _result_count: parsed.nodes?.length ?? 1,
        };
      default:
        return { _result_count: 1, _tool: toolName, _note: 'Previously returned this session' };
    }
  } catch {
    return undefined;
  }
}

/**
 * Optional pre-created resources that can be shared across sessions.
 * When provided, createServer() will use them instead of creating its own.
 * The caller is responsible for their lifecycle (they won't be closed on dispose).
 */
/**
 * R09 v2 — pipeline-lifecycle event shapes emitted by MCP tools
 * (embed_repo, snapshot_graph) and relayed by the daemon to the
 * existing /api/events SSE bus. The `project` field is stamped in by
 * cli.ts before broadcasting; tools omit it. The `type` strings are a
 * subset of the daemon-side `DaemonEvent` union (see src/cli.ts).
 *
 * No new event-bus abstraction — these flow through the existing
 * broadcastEvent() function in cli.ts via the onPipelineEvent dep.
 */
export type PipelineLifecycleEvent =
  | { type: 'embed_started'; total?: number }
  | { type: 'embed_progress'; processed: number; total: number }
  | { type: 'embed_completed'; duration_ms: number; embedded: number }
  | { type: 'snapshot_created'; name: string; summary?: Record<string, unknown> };

export interface ServerDeps {
  topoStore?: TopologyStore | null;
  decisionStore?: DecisionStore | null;
  /**
   * Optional per-session callback fired for every MCP tool call. Used by the
   * Electron app to stream live activity over the /api/events SSE bus.
   * cli.ts wires it to broadcastEvent.
   */
  onJournalEntry?: (data: import('./journal-broadcast.js').JournalEntryCallbackData) => void;
  /** Session ID associated with `onJournalEntry`. Required when the callback is set. */
  sessionId?: string;
  /**
   * R09 v2 — optional callback for pipeline-lifecycle events emitted by
   * MCP tools (embed_repo, snapshot_graph). cli.ts wires it to
   * broadcastEvent, stamping the project root onto each event.
   */
  onPipelineEvent?: (event: PipelineLifecycleEvent) => void;
}

/**
 * Handle returned by createServer() for proper lifecycle management.
 */
export interface ServerHandle {
  server: McpServer;
  /**
   * SessionJournal of the MCP session this handle owns. Exposed so the daemon
   * HTTP layer can serve a snapshot of recent tool calls to the Electron app
   * (GET /api/projects/journal) without reaching into createServer internals.
   */
  journal: SessionJournal;
  /** Flush session data and close owned resources. Safe to call multiple times. */
  dispose: () => void;
}

export function createServer(
  store: Store,
  registry: PluginRegistry,
  config: TraceMcpConfig,
  rootPath?: string,
  progress?: ProgressState,
  deps?: ServerDeps,
): ServerHandle {
  const projectRoot = rootPath ?? process.cwd();

  // Framework detection — filter to actually-detected frameworks, not the full catalog
  const projectContext = buildProjectContext(projectRoot);
  const activeResult = registry.getActiveFrameworkPlugins(projectContext);
  const activePlugins = activeResult.isErr() ? [] : activeResult.value;
  const frameworkNames = new Set(activePlugins.map((p) => p.manifest.name));
  const has = (...names: string[]) => names.some((n) => frameworkNames.has(n));
  const detectedFrameworks = [...frameworkNames].join(', ') || 'none';

  // Create server with instructions
  const instructionsVerbosity = config.tools?.instructions_verbosity ?? 'full';
  const agentBehavior = config.tools?.agent_behavior ?? 'off';
  const server = new McpServer(
    { name: 'trace-mcp', version: PKG_VERSION },
    { instructions: buildInstructions(detectedFrameworks, instructionsVerbosity, agentBehavior) },
  );

  // Session tracking
  const telemetrySink = config.telemetry?.enabled
    ? new TelemetrySink({ maxRows: config.telemetry?.max_rows })
    : null;
  const rankingLedger = config.telemetry?.enabled ? new RankingLedger() : null;
  const savings = new SessionTracker(projectRoot, telemetrySink);
  const journal = new SessionJournal();
  const sessionStartedAt = new Date().toISOString();
  const snapshotPath = getSnapshotPath(projectRoot);
  journal.enablePeriodicSnapshot(snapshotPath);

  // Structural landmarks provider: PageRank top-20 symbols + recently edited symbols
  journal.setLandmarkProvider(() => {
    const landmarks: StructuralLandmark[] = [];
    const pagerankMap = computePageRank(store.db);
    if (pagerankMap.size === 0) return landmarks;

    // Top-20 by PageRank
    const sorted = [...pagerankMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    const nodeIds = sorted.map(([nid]) => nid);
    const refs = store.getNodeRefsBatch(nodeIds);

    const symbolRefIds: number[] = [];
    const nodeScores = new Map<number, number>();
    for (const [nid, score] of sorted) {
      const ref = refs.get(nid);
      if (ref?.nodeType === 'symbol') {
        symbolRefIds.push(ref.refId);
        nodeScores.set(ref.refId, score);
      }
    }

    if (symbolRefIds.length > 0) {
      const symbolMap = store.getSymbolsByIds(symbolRefIds);
      const fileIds = [...new Set([...symbolMap.values()].map((s) => s.file_id))];
      const fileMap = store.getFilesByIds(fileIds);

      for (const symId of symbolRefIds) {
        const sym = symbolMap.get(symId);
        if (!sym) continue;
        const file = fileMap.get(sym.file_id);
        if (!file) continue;
        landmarks.push({
          symbol_id: sym.symbol_id,
          name: sym.name,
          kind: sym.kind,
          file: file.path,
          line: sym.line_start,
          reason: 'pagerank',
          score: nodeScores.get(symId),
        });
      }
    }

    // Recently edited symbols (from register_edit calls in the journal)
    const editedFiles = new Set<string>();
    for (const entry of journal.getEntries()) {
      if (entry.tool === 'register_edit') {
        const fp = entry.params_summary.replace(/^register_edit\s+/, '');
        if (fp) editedFiles.add(fp);
      }
    }

    for (const fp of editedFiles) {
      const file = store.getFile(fp);
      if (!file) continue;
      const syms = store.getSymbolsByFile(file.id);
      for (const sym of syms.slice(0, 3)) {
        // top 3 symbols per edited file
        if (landmarks.some((l) => l.symbol_id === sym.symbol_id)) continue;
        landmarks.push({
          symbol_id: sym.symbol_id,
          name: sym.name,
          kind: sym.kind,
          file: fp,
          line: sym.line_start,
          reason: 'recently_edited',
        });
      }
    }

    return landmarks;
  });

  let sessionFlushed = false;
  const flushAll = () => {
    savings.flush();
    if (telemetrySink) {
      try {
        telemetrySink.close();
      } catch {
        /* best-effort */
      }
    }
    if (rankingLedger) {
      try {
        rankingLedger.close();
      } catch {
        /* best-effort */
      }
    }
    // Write final snapshot for PreCompact hook
    try {
      journal.flushSnapshotFile(snapshotPath);
    } catch {
      /* best-effort */
    }
    if (!sessionFlushed) {
      sessionFlushed = true;
      const stats = savings.getSessionStats();
      const summary = journal.getSummary();
      flushSessionSummary({
        projectRoot,
        startedAt: sessionStartedAt,
        totalCalls: stats.total_calls,
        filesTouched: summary.files_read,
        topTools: Object.fromEntries(
          Object.entries(stats.per_tool).map(([k, v]) => [k, (v as { calls: number }).calls]),
        ),
        deadEnds: summary.searches_with_zero_results,
        dedupSavedTokens: journal.getDedupSavedTokens(),
        prefetchBoosts: journal.getPrefetchBoosts(),
      });
    }
  };

  // dispose() flushes session data, closes owned resources, and frees memory.
  // Safe to call multiple times. Does NOT add process listeners — caller manages lifecycle.
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    flushAll();
    try {
      heartbeat.stop();
    } catch {
      /* best-effort */
    }
    // Close only resources we own (not shared via deps)
    if (ownsDecisionStore) {
      try {
        decisionStore.close();
      } catch {
        /* best-effort */
      }
    }
    if (ownsTopoStore && topoStore) {
      try {
        topoStore.close();
      } catch {
        /* best-effort */
      }
    }
    // Free session memory
    journal.dispose();
  };

  // Meta-field filtering
  const metaFieldsConfig = config.tools?.meta_fields ?? true;
  const META_KEYS = [
    '_hints',
    '_budget_warning',
    '_budget_level',
    '_duplicate_warning',
    '_dedup',
    '_optimization_hint',
    '_meta',
    '_duplication_warnings',
    '_methodology',
  ] as const;

  function stripMetaFields(obj: Record<string, unknown>): void {
    if (metaFieldsConfig === true) return;
    if (metaFieldsConfig === false) {
      for (const key of META_KEYS) delete obj[key];
      return;
    }
    const allowed = new Set(metaFieldsConfig);
    for (const key of META_KEYS) {
      if (!allowed.has(key)) delete obj[key];
    }
  }

  // Install tool gate (preset filtering, description overrides, savings/journal wrapping)
  const presetName = process.env.TRACE_MCP_PRESET ?? config.tools?.preset ?? 'full';
  const presetResult = resolvePreset(presetName);
  const activePreset = presetResult ?? 'all';

  // Status sentinel — guard hook uses this to detect a live, healthy trace-mcp.
  // Records tool-call counters + last successful call timestamp so the v0.8+
  // hook can distinguish "process up but MCP channel stalled" from a healthy
  // server, and the desktop app can render the project status badge.
  const heartbeat = startHeartbeat(projectRoot);

  const { _originalTool, registeredToolNames, toolHandlers } = installToolGate(
    server,
    config,
    activePreset,
    savings,
    journal,
    j,
    extractResultCount,
    extractCompactResult,
    stripMetaFields,
    projectRoot,
    (success) => heartbeat.recordToolCall(success),
    deps?.onJournalEntry,
    deps?.sessionId,
  );

  if (presetName !== 'full') {
    logger.info(
      { preset: presetName, tools: activePreset === 'all' ? 'all' : activePreset.size },
      'Tool preset active',
    );
  }

  // Budget-aware JSON serializer with hints
  let lastBudgetLevel: 'none' | 'info' | 'warning' | 'critical' = 'none';
  function jh(toolName: string, value: unknown): string {
    const hinted = withHints(toolName, value);
    const stats = savings.getSessionStats();
    const calls = stats.total_calls;
    const tokens = stats.total_raw_tokens;

    let level: 'none' | 'info' | 'warning' | 'critical' = 'none';
    if (calls >= 50 || tokens >= 200_000) level = 'critical';
    else if (calls >= 30 || tokens >= 100_000) level = 'warning';
    else if (calls >= 15 || tokens >= 50_000) level = 'info';

    if (level !== 'none' && level !== lastBudgetLevel) {
      lastBudgetLevel = level;
      const obj =
        hinted !== null && typeof hinted === 'object' && !Array.isArray(hinted)
          ? (hinted as Record<string, unknown>)
          : { data: hinted };
      const messages: Record<string, string> = {
        info: `${calls} tool calls this session (~${tokens} raw tokens). Consider using get_task_context or get_feature_context for consolidated context instead of many small queries.`,
        warning: `High token usage: ${calls} calls, ~${tokens} raw tokens. Switch to batch calls and get_task_context to reduce overhead.`,
        critical: `Critical token usage: ${calls} calls, ~${tokens} raw tokens. Use only targeted queries (get_symbol, batch) from here. Avoid broad exploration.`,
      };
      obj._budget_warning = messages[level];
      obj._budget_level = level;
      stripMetaFields(obj);
      return j(obj);
    }

    if (hinted !== null && typeof hinted === 'object' && !Array.isArray(hinted)) {
      stripMetaFields(hinted as Record<string, unknown>);
    }
    return j(hinted);
  }

  // AI layer (optional)
  const aiProvider: AIProvider = createAIProvider(config);
  const vectorStore = config.ai?.enabled ? new BlobVectorStore(store.db) : null;
  const embeddingService = config.ai?.enabled ? aiProvider.embedding() : null;
  const reranker: RerankerService | null = config.ai?.enabled
    ? new LLMReranker(aiProvider.fastInference())
    : null;

  function guardPath(
    filePath: string,
  ): { content: [{ type: 'text'; text: string }]; isError: true } | null {
    const check = validatePath(filePath, projectRoot);
    if (check.isErr()) {
      return { content: [{ type: 'text', text: j(formatToolError(check.error)) }], isError: true };
    }
    return null;
  }

  // Explored-file tracker (guard hook reads markers to allow Read on explored files)
  const explored = createExploredTracker(projectRoot);

  // Build topology store (shared across navigation + advanced tools)
  // If deps provide a shared store, use it (caller manages lifecycle).
  // Otherwise create our own (closed in dispose).
  const ownsTopoStore = deps?.topoStore === undefined;
  let topoStore: TopologyStore | null = deps?.topoStore ?? null;
  if (ownsTopoStore && config.topology?.enabled) {
    ensureGlobalDirs();
    topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
  }

  // Build decision memory store (cross-session knowledge graph)
  const ownsDecisionStore = deps?.decisionStore === undefined;
  let decisionStore: DecisionStore;
  if (deps?.decisionStore) {
    decisionStore = deps.decisionStore;
  } else {
    ensureGlobalDirs();
    decisionStore = new DecisionStore(DECISIONS_DB_PATH);
  }

  // Build shared context and register all tools
  const ctx: ServerContext = {
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
    guardPath,
    j,
    jh,
    markExplored: explored.markExplored,
    progress: progress ?? null,
    topoStore,
    decisionStore,
    telemetrySink,
    rankingLedger,
    // R09 v2: default to a no-op so non-daemon contexts (CLI fallback,
    // unit tests) can register tools without crashing. cli.ts overrides
    // this with the broadcastEvent-bound callback.
    onPipelineEvent: deps?.onPipelineEvent ?? (() => {}),
  };

  const metaCtx: MetaContext = {
    ...ctx,
    _originalTool,
    registeredToolNames,
    toolHandlers,
    presetName,
  };

  // Session providers — register enabled providers into the shared singleton
  // so downstream consumers (mineSessions, discover_hermes_sessions) find them.
  if (config.hermes?.enabled !== false) {
    const registry = getSessionProviderRegistry();
    if (!registry.get('hermes')) {
      registry.register(new HermesSessionProvider());
    }
  }
  // Codex CLI (~/.codex/sessions/*.jsonl). Auto-enabled — discovery returns
  // [] cheaply when the directory is absent, so there's no need for a config
  // flag until users hit a reason to disable it.
  {
    const registry = getSessionProviderRegistry();
    if (!registry.get('codex')) {
      registry.register(new CodexSessionProvider());
    }
  }

  registerCoreTools(server, ctx);
  registerNavigationTools(server, ctx);
  registerFrameworkTools(server, ctx);
  registerAnalysisTools(server, ctx);
  registerGitTools(server, ctx);
  registerRefactoringTools(server, ctx);
  registerAdvancedTools(server, ctx);
  registerQualityTools(server, ctx);
  registerMemoryTools(server, ctx);
  registerKnowledgeTools(server, ctx);
  registerSessionTools(server, metaCtx);

  return { server, journal, dispose };
}
