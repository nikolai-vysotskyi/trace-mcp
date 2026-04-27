import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { logger } from '../../logger.js';
import { resolveRegisteredAncestor } from '../../registry.js';
import type { Backend } from './types.js';

export interface ProxyBackendOptions {
  daemonUrl: string; // e.g. "http://127.0.0.1:3741"
  projectRoot: string; // absolute path used to scope /mcp
  clientId: string; // stable uuid for this stdio session (for /api/clients)
  clientTransportKind?: string; // "stdio-proxy" by default
}

/**
 * Forwards MCP messages between the MessageRouter and a running daemon's /mcp endpoint.
 *
 * Does NOT own health-checking — that's the DaemonWatcher's job at the Session level.
 */
export class ProxyBackend implements Backend {
  readonly kind = 'proxy' as const;

  onmessage?: (msg: JSONRPCMessage) => void;
  onerror?: (err: Error) => void;

  private readonly opts: ProxyBackendOptions;
  private httpTransport: StreamableHTTPClientTransport | null = null;
  private started = false;
  private stopping = false;

  constructor(opts: ProxyBackendOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const { daemonUrl, clientId } = this.opts;
    // If our cwd is a subdirectory of an already-registered project (e.g. a
    // nested package in a monorepo), route to that parent's index instead of
    // asking the daemon to spin up a duplicate one for this subdir.
    const ancestor = resolveRegisteredAncestor(this.opts.projectRoot);
    const projectRoot = ancestor?.root ?? this.opts.projectRoot;
    if (ancestor && ancestor.root !== this.opts.projectRoot) {
      logger.info(
        { requested: this.opts.projectRoot, parent: ancestor.root },
        'ProxyBackend: routing subdirectory to registered parent project',
      );
    }
    const mcpUrl = `${daemonUrl}/mcp?project=${encodeURIComponent(projectRoot)}`;

    // Best-effort project registration (daemon returns 409 if already registered).
    await fetch(`${daemonUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: projectRoot }),
    }).catch(() => {
      /* daemon may already know */
    });

    // Best-effort client registration for the menu bar UI.
    fetch(`${daemonUrl}/api/clients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: clientId,
        project: projectRoot,
        transport: this.opts.clientTransportKind ?? 'stdio-proxy',
      }),
    }).catch(() => {
      /* non-fatal */
    });

    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    transport.onmessage = (msg) => {
      this.onmessage?.(msg);
    };
    transport.onerror = (err) => {
      logger.warn({ err: String(err) }, 'ProxyBackend: HTTP transport error');
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
    };
    await transport.start();
    this.httpTransport = transport;
    this.started = true;
    logger.info({ mcpUrl }, 'ProxyBackend started');
  }

  async stop(): Promise<void> {
    if (this.stopping || !this.started) return;
    this.stopping = true;
    const { daemonUrl, clientId } = this.opts;
    // Best-effort client unregister (don't block on this).
    fetch(`${daemonUrl}/api/clients?id=${clientId}`, { method: 'DELETE' }).catch(() => {});
    try {
      await this.httpTransport?.close();
    } catch (err) {
      logger.debug({ err: String(err) }, 'ProxyBackend: close error (ignored)');
    }
    this.httpTransport = null;
    this.started = false;
    logger.info('ProxyBackend stopped');
  }

  async send(msg: JSONRPCMessage): Promise<void> {
    if (!this.httpTransport) throw new Error('ProxyBackend not started');
    await this.httpTransport.send(msg);
  }
}
