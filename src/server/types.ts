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
import type { SessionJournal } from '../session/journal.js';
import type { SessionTracker } from '../session/tracker.js';
import type { TopologyStore } from '../topology/topology-db.js';

export type ToolResponse = { content: [{ type: 'text'; text: string }]; isError?: boolean };
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
  guardPath: (filePath: string) => ErrorResponse | null;
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
}

/** Extended context for meta tools that bypass preset gate */
export interface MetaContext extends ServerContext {
  _originalTool: McpServer['tool'];
  registeredToolNames: string[];
  toolHandlers: Map<string, (params: Record<string, unknown>) => Promise<ToolResponse>>;
  presetName: string;
}
