import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import type { TraceMcpConfig } from '../../config.js';
import { Store } from '../../db/store.js';
import { DECISIONS_DB_PATH, TOPOLOGY_DB_PATH } from '../../global.js';
import { logger } from '../../logger.js';
import { getToolAnnotations } from '../../server/tool-annotations.js';
import { DecisionStore } from '../../memory/decision-store.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { ProgressState } from '../../progress.js';
import { createServer, type ServerHandle } from '../../server/server.js';
import type { ProjectRelay } from '../../server/types.js';
import { ActivityStore } from '../../session/activity-store.js';
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
 *
 * Two guards keep the readonly handle from ever serving writes (TRA-1988):
 * an empty shared DB refuses start() (a fresh registration's 0-file file is
 * not a snapshot worth serving — the session falls through to a writable
 * LocalBackend instead), and index-mutating tools answered here get a
 * retryable `snapshot_readonly` busy instead of SQLITE_READONLY.
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
  /**
   * Durable activity journal (TRA-1868). The snapshot answers a session's
   * first tool calls before the real backend settles — without its own
   * writer those calls never reach activity.db. Same shared file as the
   * daemon/local writers; null when the constructor throws.
   */
  private activityStore: ActivityStore | null = null;
  private readonly snapshotSessionId = randomUUID();

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
    // TRA-1988: an empty shared DB is not a snapshot worth serving. Project
    // registration creates the file before anything is indexed, so on a
    // fresh project this backend would otherwise answer the session's first
    // mutating calls (an immediate `reindex`) from a readonly handle and
    // fail them with SQLITE_READONLY. Refuse here — StdioSession's bootstrap
    // already falls back to the full (writable LocalBackend) path when
    // start() throws — instead of serving an empty index that can only fail
    // writes. Mirrors seedSessionDbFromShared's empty guard (TRA-931).
    if (countIndexedFiles(this.db) === 0) {
      try {
        this.db.close();
      } catch {
        /* best-effort */
      }
      this.db = null;
      throw new Error(
        'SnapshotBackend: shared DB holds no indexed files — skipping snapshot fast path',
      );
    }
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

    try {
      this.activityStore = new ActivityStore();
    } catch (e) {
      logger.warn(`activity store unavailable: ${(e as Error)?.message ?? e}`);
    }
    const activityStore = this.activityStore;
    const snapshotSessionId = this.snapshotSessionId;
    const snapshotProject = projectRoot;
    this.handle = createServer(store, registry, config, projectRoot, progress, {
      topoStore: this.topoStore,
      decisionStore: this.decisionStore,
      projectRelay: this.projectRelay,
      // The real backend (proxy or local) reports this session's usage a
      // moment later — counting this transient snapshot too would double
      // every session that has one (TRA-951 precedent).
      skipUsagePing: true,
      // ...but tool CALLS are not usage pings: each call is served exactly
      // once (here, before the swap), so journaling them here double-counts
      // nothing and closes the snapshot hole in activity.db (TRA-1868).
      sessionId: snapshotSessionId,
      onJournalEntry: (data) => {
        activityStore?.record({
          ...data,
          project: snapshotProject,
          session_id: snapshotSessionId,
        });
      },
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
    // Flush buffered journal entries — the snapshot's calls happened, they
    // just haven't hit the 2 s flush timer yet.
    try {
      this.activityStore?.close();
    } catch {
      /* best-effort */
    }
    this.activityStore = null;
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
    // TRA-1988: this backend holds a readonly handle onto a file it doesn't
    // own — running an index-mutating tool here can only end in
    // "attempt to write a readonly database". Answer those calls with the
    // same retryable busy shape the writable backends use for their own
    // transient states (reindex_in_progress, project_stopping) instead of
    // letting the write hit SQLite. The real backend (proxy or local) takes
    // over via swap() moments later and serves the retry for real. Reads
    // pass through untouched — they are the reason this backend exists.
    const mutatingTool = mutatingToolName(msg);
    if (mutatingTool !== null) {
      const id = (msg as unknown as { id: string | number }).id;
      this.onmessage?.({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'busy',
                error: 'snapshot_readonly',
                tool: mutatingTool,
                message:
                  'Session is still starting on a read-only index snapshot; retry this call in a moment',
              }),
            },
          ],
          isError: true,
        },
      } as unknown as JSONRPCMessage);
      return;
    }
    if (!this.clientTransport) throw new Error('SnapshotBackend not started');
    await this.clientTransport.send(msg);
  }
}

/**
 * Name of the called tool when `msg` is a `tools/call` request for an
 * index-mutating tool (TRA-1988), null otherwise. Tool mutability comes from
 * the same central annotations the surface uses, so a tool that gains a
 * write later is covered without touching this file.
 */
function mutatingToolName(msg: JSONRPCMessage): string | null {
  const m = msg as unknown as { method?: unknown; params?: unknown; id?: unknown };
  if (m.method !== 'tools/call') return null;
  if (m.id === undefined || m.id === null) return null;
  const name = (m.params as { name?: unknown } | undefined)?.name;
  if (typeof name !== 'string' || name.length === 0) return null;
  return getToolAnnotations(name).readOnlyHint === false ? name : null;
}

/** Rows in `files`, or 0 when the table is missing/unreadable (fresh DB). */
function countIndexedFiles(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n?: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}
