import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * A backend is what processes MCP messages behind the MessageRouter.
 * Two implementations:
 *   - ProxyBackend: forwards to a running daemon via HTTP/SSE
 *   - LocalBackend: runs a full in-process McpServer + indexer
 *
 * Router owns a single StdioServerTransport and swaps backends beneath it
 * so the MCP client never sees a disconnect.
 */
export interface Backend {
  readonly kind: BackendKind;
  /** Start the backend (open connections, spin up resources). */
  start(): Promise<void>;
  /** Stop serving MCP messages. Returns when the backend is no longer accepting
   *  requests; heavy cleanup (e.g. finishing a long indexAll) may continue via
   *  `backgroundDispose` which the Session is expected to track. */
  stop(): Promise<void>;
  /** Send a message from the client (stdin) into this backend. */
  send(msg: JSONRPCMessage): Promise<void>;
  /** Router installs this to receive backend→client messages (for stdout). */
  onmessage?: (msg: JSONRPCMessage) => void;
  /** Optional error channel (non-fatal by default). */
  onerror?: (err: Error) => void;
  /** Set by the backend during stop() if background cleanup is ongoing.
   *  Session collects these so they finish before process exit. */
  backgroundDispose?: Promise<void>;
}

export type BackendKind = 'proxy' | 'local';

export type Mode = 'proxy' | 'local' | 'idle' | 'transitioning';

export interface DaemonWatcher {
  /** Returns the most recent known state (polled async). */
  getCurrentState(): boolean;
  /** Subscribe to *stable* state changes (fires only after N seconds of consistency). */
  onStableChange(cb: (daemonActive: boolean) => void): void;
  start(): Promise<void>;
  stop(): void;
}
