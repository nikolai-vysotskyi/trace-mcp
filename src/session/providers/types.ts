/**
 * Session Provider interface — canonical shape for ingesting AI coding-assistant
 * conversation logs into trace-mcp's session pipeline (`index_sessions`,
 * `mine_sessions`, `discover_*_sessions`, `get_session_analytics`).
 *
 * The shapes here are the committed contract — provider implementations
 * MUST NOT add required fields on SessionHandle / RawMessage without
 * first updating every consumer that iterates over the registry.
 */
import type { TokenUsage, ParsedSession } from '../../analytics/log-parser.js';

export interface DiscoverOpts {
  /** Absolute path of the project being analyzed. Providers that store per-project
   * data use this to scope discovery; global-session providers (e.g. Hermes) MAY
   * ignore it and return handles with `projectPath = undefined`. */
  projectRoot?: string;
  /** Home directory override — injectable for tests. Defaults to os.homedir(). */
  homeDir?: string;
  /** Per-provider overrides passed through from config. */
  configOverrides?: Record<string, unknown>;
}

export interface SessionHandle {
  /** Stable provider id (matches `SessionProvider.id`). */
  providerId: string;
  /** Provider-unique session id (used as DB key for mining / indexing). */
  sessionId: string;
  /** Where the session lives on disk.
   * Plain filesystem providers: absolute file path.
   * SQLite-backed providers: `sqlite://<abs-db-path>?row=<pk>` (§4.5). */
  sourcePath: string;
  /** Best-effort project root; `undefined` if the provider does not track it
   * (e.g. Hermes stores conversations globally, not per-project). */
  projectPath?: string;
  lastModifiedMs: number;
  sizeBytes?: number;
}

export interface RawMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  timestampMs?: number;
  referencedFiles?: string[];
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  tokenUsage?: Partial<TokenUsage>;
}

export interface SessionProvider {
  /** Stable provider id used in DB, config, logs (e.g. "claude-code", "hermes"). */
  readonly id: string;
  /** Human-readable label for UI / analytics. */
  readonly displayName: string;

  /** Locate sessions on disk. Parsing is deferred to `parse` / `streamMessages`
   * so discovery stays cheap. */
  discover(opts: DiscoverOpts): Promise<SessionHandle[]>;

  /** Parse one handle into the canonical `ParsedSession` shape.
   * MUST NOT throw on malformed inputs — log + return null. */
  parse(handle: SessionHandle): Promise<ParsedSession | null>;

  /** Iterator over raw conversation chunks for indexing / mining. Kept separate
   * from `parse` because downstream consumers don't need ToolCall aggregation. */
  streamMessages(handle: SessionHandle): AsyncIterable<RawMessage>;
}
