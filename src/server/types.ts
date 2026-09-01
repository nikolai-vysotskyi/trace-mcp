import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  AIProvider,
  BlobVectorStore,
  EmbeddingService,
  RerankerService,
} from '../ai/index.js';
import type { TraceMcpConfig } from '../config.js';
import type { Store } from '../db/store.js';
import type { DecisionStore } from '../memory/decision-store.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type { ProgressState } from '../progress.js';
import type { RankingLedger } from '../runtime/ranking-ledger.js';
import type { TelemetrySink } from '../runtime/telemetry-sink.js';
import type { SessionJournal } from '../session/journal.js';
import type { SessionTracker } from '../session/tracker.js';
import type { TopologyStore } from '../topology/topology-db.js';
import type { StateEngine } from '../state/state-engine.js';

export type ToolResponse = { content: [{ type: 'text'; text: string }]; isError?: boolean };

/** Name → gated handler map for in-process tool dispatch without a second MCP
 *  transport/session. Populated by `installToolGate` inside `createServer()`
 *  and exposed on `ServerHandle.toolHandlers` — the same map the `batch` tool
 *  (session.ts) already uses for same-project dispatch. */
export type ToolHandlerMap = Map<
  string,
  (params: Record<string, unknown>) => Promise<ToolResponse>
>;

/**
 * Cross-project relay for the `call_project_tool` MCP tool (projects.ts).
 * Two implementations exist (src/daemon/project-relay.ts):
 *  - the daemon/HTTP runtime reuses `ProjectManager` + `ProjectResourcePool`
 *    (a target project already warm in the daemon is served directly; a cold
 *    one is lazily opened via `ProjectManager.addProject(root, { watch: false,
 *    persist: false })`, the same read-mostly path used for subprojects).
 *  - the stdio runtime (no daemon assumed) opens the target project's
 *    already-indexed database directly — no indexAll(), no file watcher.
 * `undefined` when neither wiring applies (e.g. isolated unit tests) —
 * call_project_tool then reports the relay as unavailable instead of throwing.
 */
export interface ProjectRelay {
  /** Registered project roots this relay accepts as a `call_project_tool` target. */
  listRelayTargets(): string[];
  /** Resolve + open (or reuse a cached) target project's tool-handler map.
   *  Returns null when `targetRoot` isn't a registered project, or is
   *  registered but has never been indexed. */
  openProject(targetRoot: string): Promise<{ toolHandlers: ToolHandlerMap } | null>;
  /** Release everything this relay opened. Idempotent. */
  dispose(): void;
}

/**
 * R09 v2 — pipeline-lifecycle event shapes emitted by MCP tools
 * (embed_repo, snapshot_graph) and relayed by the daemon to the
 * existing /api/events SSE bus. The `project` field is stamped in by
 * cli.ts before broadcasting; tools omit it. The `type` strings are a
 * subset of the daemon-side `DaemonEvent` union (see src/cli.ts).
 *
 * Lives here (rather than in `./server.ts`) so `ServerContext` below can
 * reference it without forcing `tool-gate.ts` → `types.ts` → `server.ts`
 * → `tool-gate.ts` to close into an import cycle. `server.ts` re-exports
 * the name to preserve the public API.
 */
export type PipelineLifecycleEvent =
  | { type: 'embed_started'; total?: number }
  | { type: 'embed_progress'; processed: number; total: number }
  | { type: 'embed_completed'; duration_ms: number; embedded: number }
  | { type: 'snapshot_created'; name: string; summary?: Record<string, unknown> };

export interface ServerContext {
  store: Store;
  registry: PluginRegistry;
  config: TraceMcpConfig;
  projectRoot: string;
  savings: SessionTracker;
  journal: SessionJournal;
  aiProvider: AIProvider;
  vectorStore: BlobVectorStore | null;
  embeddingService: EmbeddingService | null;
  reranker: RerankerService | null;

  /** Check if any of the named frameworks are detected */
  has: (...names: string[]) => boolean;
  /** Validate path stays within project root; returns error response on failure */
  guardPath: (filePath: string) => ToolResponse | null;
  /** Compact JSON serializer (strips nulls) */
  j: (value: unknown) => string;
  /** JSON serializer with contextual hints + budget warnings */
  jh: (toolName: string, value: unknown) => string;
  /** Mark a file as explored via trace-mcp (so guard hook allows subsequent Read) */
  markExplored: (filePath: string) => void;
  /** Progress state for indexing pipelines (null if not wired) */
  progress: ProgressState | null;
  /** Topology store for subprojects (null if topology disabled) */
  topoStore: TopologyStore | null;
  /** Decision memory store (null if memory disabled) */
  decisionStore: DecisionStore | null;
  /** Optional persistent telemetry sink (null when telemetry.enabled = false) */
  telemetrySink: TelemetrySink | null;
  /** Optional persistent ranking ledger for self-tuning (null when disabled) */
  rankingLedger: RankingLedger | null;
  /** StateEngine instance for agent execution state (SKILL.state) */
  stateEngine?: StateEngine | null;
  /**
   * R09 v2 — emit a pipeline-lifecycle event onto the daemon's SSE bus.
   * No-op when running outside the daemon (CLI fallback, unit tests).
   * Wired by createServer() from ServerDeps.onPipelineEvent.
   */
  onPipelineEvent: (event: PipelineLifecycleEvent) => void;
  /**
   * Cross-project relay wired by cli.ts (daemon) / LocalBackend (stdio).
   * Null when not wired (e.g. unit tests) — `call_project_tool` reports the
   * relay as unavailable rather than throwing.
   */
  projectRelay: ProjectRelay | null;
}

/** Extended context for meta tools that bypass preset gate */
export interface MetaContext extends ServerContext {
  _originalTool: McpServer['tool'];
  registeredToolNames: string[];
  toolHandlers: Map<string, (params: Record<string, unknown>) => Promise<ToolResponse>>;
  presetName: string;
  /**
   * Tools outside the active preset, registered-but-disabled and reachable via
   * `load_tools` (TRA-402). Empty on a `full` session.
   */
  deferredTools: Map<
    string,
    {
      registered: { enabled: boolean; description?: string; inputSchema?: unknown };
      handler: (params: Record<string, unknown>) => Promise<ToolResponse>;
    }
  >;
}
