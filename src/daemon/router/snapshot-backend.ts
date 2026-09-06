import fs from 'node:fs';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import type { TraceMcpConfig } from '../../config.js';
import { Store } from '../../db/store.js';
import { DECISIONS_DB_PATH, TOPOLOGY_DB_PATH } from '../../global.js';
import { logger } from '../../logger.js';
import { DecisionStore } from '../../memory/decision-store.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { ProgressState } from '../../progress.js';
import { createServer, type ServerHandle } from '../../server/server.js';
import type { ProjectRelay } from '../../server/types.js';
import { TopologyStore } from '../../topology/topology-db.js';
import { createLightweightProjectRelay } from '../project-relay.js';
import type { Backend } from './types.js';

export interface SnapshotBackendOptions {
  projectRoot: string;
  config: TraceMcpConfig;
  /** The daemon's canonical index DB — opened directly, readonly, never copied. */
  sharedDbPath: string;
}

/**
 * Instant, read-only view of the daemon's on-disk index (TRA-948). StdioSession
 * uses this to answer a client's first requests — `initialize`, `get_project_map`,
 * `get_outline`, `search` — without waiting on the daemon's /health check, HTTP
 * session registration, and SSE handshake (measured 2.7-3.6s cold, TRA-931).
 * That negotiation runs in parallel and the session swaps onto its result via
 * MessageRouter.swap() the moment it's ready.
 *
 * Opens `sharedDbPath` directly with no seed copy and no schema/migration pass
 * (unlike LocalBackend's owned session DB) — this file belongs to the daemon,
 * so start() is dominated by SQLite's open cost, not a page-by-page backup.
 */
export class SnapshotBackend implements Backend {
  readonly kind = 'snapshot' as const;

  onmessage?: (msg: JSONRPCMessage) => void;
  onerror?: (err: Error) => void;

  private readonly opts: SnapshotBackendOptions;
  private db: Database.Database | null = null;
  private handle: ServerHandle | null = null;
  private clientTransport: InMemoryTransport | null = null;
  private topoStore: TopologyStore | null = null;
  private decisionStore: DecisionStore | null = null;
  private readonly projectRelay: ProjectRelay = createLightweightProjectRelay();

  constructor(opts: SnapshotBackendOptions) {
    this.opts = opts;
  }

  /** Cheap pre-check so a caller can skip building this backend entirely. */
  static canOpen(sharedDbPath: string): boolean {
    return fs.existsSync(sharedDbPath);
  }

  async start(): Promise<void> {
    const { sharedDbPath, projectRoot, config } = this.opts;
    // Readonly, no DDL/migrations — the daemon owns this file's schema.
    this.db = new Database(sharedDbPath, { readonly: true, fileMustExist: true });
    const store = new Store(this.db);
    const registry = PluginRegistry.createWithDefaults();
    const progress = new ProgressState(this.db);

    // Readonly shared stores — mirrors LocalBackend's read-only fallback wiring.
    try {
      if (config.topology?.enabled && fs.existsSync(TOPOLOGY_DB_PATH)) {
        this.topoStore = new TopologyStore(TOPOLOGY_DB_PATH, { readonly: true });
      }
    } catch {
      /* noop */
    }
    try {
      if (fs.existsSync(DECISIONS_DB_PATH)) {
        this.decisionStore = new DecisionStore(DECISIONS_DB_PATH, { readonly: true });
      }
    } catch {
      /* noop */
    }

    this.handle = createServer(store, registry, config, projectRoot, progress, {
      topoStore: this.topoStore,
      decisionStore: this.decisionStore,
      projectRelay: this.projectRelay,
      // The real backend (proxy or local) reports this session's usage a
      // moment later — counting this transient snapshot too would double
      // every session that has one (TRA-951 precedent).
      skipUsagePing: true,
    });

    const [client, server] = InMemoryTransport.createLinkedPair();
    this.clientTransport = client;
    client.onmessage = (msg) => {
      this.onmessage?.(msg);
    };
    client.onerror = (err) => {
      logger.warn({ err: String(err) }, 'SnapshotBackend: in-memory client error');
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
    };

    await this.handle.server.connect(server);
    await client.start();

    logger.info({ sharedDbPath, projectRoot }, 'SnapshotBackend started');
  }

  async stop(): Promise<void> {
    if (this.clientTransport) this.clientTransport.onmessage = undefined;
    try {
      await this.clientTransport?.close();
    } catch {
      /* best-effort */
    }
    this.clientTransport = null;
    try {
      this.projectRelay.dispose();
    } catch {
      /* best-effort */
    }
    try {
      this.handle?.dispose();
    } catch {
      /* best-effort */
    }
    this.handle = null;
    try {
      this.topoStore?.close();
    } catch {
      /* best-effort */
    }
    this.topoStore = null;
    try {
      this.decisionStore?.close();
    } catch {
      /* best-effort */
    }
    this.decisionStore = null;
    // Readonly connection onto a file we don't own — closing it never
    // touches the file on disk, unlike LocalBackend's owned session DB.
    try {
      this.db?.close();
    } catch {
      /* best-effort */
    }
    this.db = null;
  }

  async send(msg: JSONRPCMessage): Promise<void> {
    if (!this.clientTransport) throw new Error('SnapshotBackend not started');
    await this.clientTransport.send(msg);
  }
}
