import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from './db/store.js';
import type { PluginRegistry } from './plugin-api/registry.js';
import type { TraceMcpConfig } from './config.js';
import type { SessionTracker } from './session-tracker.js';
import type { SessionJournal } from './session-journal.js';
import type { AIProvider, RerankerService, EmbeddingService, BlobVectorStore } from './ai/index.js';

export type ToolResponse = { content: [{ type: 'text'; text: string }]; isError?: boolean };
export type ErrorResponse = { content: [{ type: 'text'; text: string }]; isError: true };

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
}

/** Extended context for meta tools that bypass preset gate */
export interface MetaContext extends ServerContext {
  _originalTool: McpServer['tool'];
  registeredToolNames: string[];
  toolHandlers: Map<string, (params: Record<string, unknown>) => Promise<ToolResponse>>;
  presetName: string;
}
