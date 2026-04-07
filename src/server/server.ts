import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
declare const PKG_VERSION_INJECTED: string;
const PKG_VERSION = typeof PKG_VERSION_INJECTED !== 'undefined' ? PKG_VERSION_INJECTED : '0.0.0-dev';
import type { Store } from '../db/store.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type { TraceMcpConfig } from '../config.js';
import { IndexingPipeline } from '../indexer/pipeline.js';
import { formatToolError } from '../errors.js';
import { validatePath } from '../utils/security.js';
import { logger } from '../logger.js';
import { createAIProvider, BlobVectorStore, type AIProvider, type RerankerService } from '../ai/index.js';
import { LLMReranker } from '../ai/reranker.js';
import { resolvePreset } from '../tools/project/presets.js';
import { withHints } from '../tools/shared/hints.js';
import { SessionTracker } from '../session/tracker.js';
import { SessionJournal } from '../session/journal.js';
import { flushSessionSummary } from '../session/resume.js';
import { getSnapshotPath, TOPOLOGY_DB_PATH, ensureGlobalDirs } from '../global.js';
import { FileWatcher } from './file-watcher.js';
import { createExploredTracker } from './explored-tracker.js';
import type { ServerContext, MetaContext } from './types.js';
import type { ProgressState } from '../progress.js';
import { buildInstructions } from './instructions.js';
import { installToolGate } from './tool-gate.js';

import { registerCoreTools } from '../tools/register/core.js';
import { registerNavigationTools } from '../tools/register/navigation.js';
import { registerFrameworkTools } from '../tools/register/framework.js';
import { registerAnalysisTools } from '../tools/register/analysis.js';
import { registerGitTools } from '../tools/register/git.js';
import { registerRefactoringTools } from '../tools/register/refactoring.js';
import { registerAdvancedTools } from '../tools/register/advanced.js';
import { registerQualityTools } from '../tools/register/quality.js';
import { registerSessionTools } from '../tools/register/session.js';
import { TopologyStore } from '../topology/topology-db.js';

/** Compact JSON — no pretty-printing, strip nulls; saves 25–35% tokens on every response */
function j(value: unknown): string {
  return JSON.stringify(value, (_key, val) => (val === null || val === undefined) ? undefined : val);
}

/** Extract result count from an MCP tool response for journal tracking */
function extractResultCount(response: { content: Array<{ type: string; text: string }>; isError?: boolean }): number {
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
    'get_symbol', 'get_outline', 'get_context_bundle', 'get_call_graph',
    'get_type_hierarchy', 'get_import_graph', 'get_dependency_diagram',
    'get_component_tree', 'get_dataflow', 'get_control_flow',
    'get_middleware_chain', 'get_di_tree', 'get_model_context',
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
          symbol_id: parsed.symbol_id, name: parsed.name, kind: parsed.kind,
          fqn: parsed.fqn, signature: parsed.signature, file: parsed.file,
          line_start: parsed.line_start, line_end: parsed.line_end, _result_count: 1,
        };
      case 'get_outline':
        return {
          path: parsed.path, language: parsed.language,
          symbols: Array.isArray(parsed.symbols)
            ? parsed.symbols.map((s: Record<string, unknown>) => ({
              symbolId: s.symbolId, name: s.name, kind: s.kind,
              signature: s.signature, lineStart: s.lineStart, lineEnd: s.lineEnd,
            })) : [],
          _result_count: Array.isArray(parsed.symbols) ? parsed.symbols.length : 1,
        };
      case 'get_context_bundle':
        return {
          primary: Array.isArray(parsed.primary)
            ? parsed.primary.map((s: Record<string, unknown>) => ({
              symbol_id: s.symbol_id, name: s.name, kind: s.kind, file: s.file, line: s.line,
            })) : [],
          totalTokens: parsed.totalTokens,
          _result_count: Array.isArray(parsed.primary) ? parsed.primary.length : 1,
        };
      case 'get_call_graph':
        return {
          root: parsed.root, direction: parsed.direction,
          node_count: parsed.nodes?.length ?? parsed.node_count ?? 0,
          nodes: Array.isArray(parsed.nodes)
            ? parsed.nodes.map((n: Record<string, unknown>) => ({
              symbol_id: n.symbol_id, name: n.name, kind: n.kind, file: n.file,
            })) : [],
          _result_count: parsed.nodes?.length ?? 1,
        };
      default:
        return { _result_count: 1, _tool: toolName, _note: 'Previously returned this session' };
    }
  } catch {
    return undefined;
  }
}

export function createServer(
  store: Store,
  registry: PluginRegistry,
  config: TraceMcpConfig,
  rootPath?: string,
  progress?: ProgressState,
): McpServer {
  const projectRoot = rootPath ?? process.cwd();

  // Framework detection
  const frameworkNames = new Set(
    registry.getAllFrameworkPlugins().map((p) => p.manifest.name),
  );
  const has = (...names: string[]) => names.some((n) => frameworkNames.has(n));
  const detectedFrameworks = [...frameworkNames].join(', ') || 'none';

  // Create server with instructions
  const instructionsVerbosity = config.tools?.instructions_verbosity ?? 'full';
  const server = new McpServer(
    { name: 'trace-mcp', version: PKG_VERSION },
    { instructions: buildInstructions(detectedFrameworks, instructionsVerbosity) },
  );

  // Session tracking
  const savings = new SessionTracker(projectRoot);
  const journal = new SessionJournal();
  const sessionStartedAt = new Date().toISOString();
  const snapshotPath = getSnapshotPath(projectRoot);
  journal.enablePeriodicSnapshot(snapshotPath);

  let sessionFlushed = false;
  const flushAll = () => {
    savings.flush();
    // Write final snapshot for PreCompact hook
    try { journal.flushSnapshotFile(snapshotPath); } catch { /* best-effort */ }
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
  process.on('SIGINT', flushAll);
  process.on('SIGTERM', flushAll);
  process.on('exit', flushAll);

  // Meta-field filtering
  const metaFieldsConfig = config.tools?.meta_fields ?? true;
  const META_KEYS = ['_hints', '_budget_warning', '_budget_level', '_duplicate_warning', '_dedup', '_optimization_hint', '_meta', '_duplication_warnings'] as const;

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

  const { _originalTool, registeredToolNames, toolHandlers } = installToolGate(
    server, config, activePreset, savings, journal,
    j, extractResultCount, extractCompactResult, stripMetaFields,
    projectRoot,
  );

  if (presetName !== 'full') {
    logger.info({ preset: presetName, tools: activePreset === 'all' ? 'all' : activePreset.size }, 'Tool preset active');
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
      const obj = (hinted !== null && typeof hinted === 'object' && !Array.isArray(hinted))
        ? hinted as Record<string, unknown>
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

  // Auto-reindex file watcher
  if (config.watch?.enabled !== false) {
    const knownExtensions = new Set(registry.getLanguagePlugins().flatMap(p => p.supportedExtensions));
    const fileWatcher = new FileWatcher(
      projectRoot,
      async (files) => {
        const pipeline = new IndexingPipeline(store, registry, config, projectRoot);
        await pipeline.indexFiles(files);
      },
      { debounceMs: config.watch?.debounceMs ?? 2000, extensions: knownExtensions, ignoreConfig: config.ignore },
    );
    fileWatcher.start();
    const stopWatcher = () => fileWatcher.stop();
    process.on('SIGINT', stopWatcher);
    process.on('SIGTERM', stopWatcher);
    process.on('exit', stopWatcher);
  }

  function guardPath(filePath: string): { content: [{ type: 'text'; text: string }]; isError: true } | null {
    const check = validatePath(filePath, projectRoot);
    if (check.isErr()) {
      return { content: [{ type: 'text', text: j(formatToolError(check.error)) }], isError: true };
    }
    return null;
  }

  // Explored-file tracker (guard hook reads markers to allow Read on explored files)
  const explored = createExploredTracker(projectRoot);

  // Build topology store (shared across navigation + advanced tools)
  let topoStore: TopologyStore | null = null;
  if (config.topology?.enabled) {
    ensureGlobalDirs();
    topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
  }

  // Build shared context and register all tools
  const ctx: ServerContext = {
    store, registry, config, projectRoot,
    savings, journal,
    aiProvider, vectorStore, embeddingService, reranker,
    has, guardPath, j, jh,
    markExplored: explored.markExplored,
    progress: progress ?? null,
    topoStore,
  };

  const metaCtx: MetaContext = {
    ...ctx, _originalTool, registeredToolNames, toolHandlers, presetName,
  };

  registerCoreTools(server, ctx);
  registerNavigationTools(server, ctx);
  registerFrameworkTools(server, ctx);
  registerAnalysisTools(server, ctx);
  registerGitTools(server, ctx);
  registerRefactoringTools(server, ctx);
  registerAdvancedTools(server, ctx);
  registerQualityTools(server, ctx);
  registerSessionTools(server, metaCtx);

  return server;
}
