/**
 * LSP server lifecycle manager.
 * Manages spawning, health checks, and shutdown of LSP server processes.
 */

import { pathToFileURL } from 'node:url';
import { logger } from '../logger.js';
import { LspClient } from './client.js';
import type { LspServerSpec } from './config.js';

export class LspServerManager {
  private clients = new Map<string, LspClient>();
  private failed = new Set<string>();

  constructor(
    private readonly specs: LspServerSpec[],
    private readonly rootPath: string,
    private readonly maxConcurrent: number,
  ) {}

  /**
   * Start LSP servers lazily — only starts a server for the requested language.
   * Returns the client if successful, null if the server is unavailable.
   */
  async getClient(language: string): Promise<LspClient | null> {
    // Already running
    const existing = this.clients.get(language);
    if (existing?.isAlive()) return existing;

    // Already failed — don't retry
    if (this.failed.has(language)) return null;

    // Respect concurrent limit
    const activeCount = Array.from(this.clients.values()).filter(c => c.isAlive()).length;
    if (activeCount >= this.maxConcurrent) {
      logger.debug({ language, active: activeCount, max: this.maxConcurrent }, 'LSP concurrent limit reached');
      return null;
    }

    // Find spec
    const spec = this.specs.find(s => s.language === language);
    if (!spec) return null;

    // Attempt to start
    try {
      const client = new LspClient(spec.command, spec.args, this.rootPath, spec.timeoutMs);
      const rootUri = pathToFileURL(this.rootPath).href;

      logger.info({ language, command: spec.command }, 'Starting LSP server');
      await client.initialize(rootUri, spec.initializationOptions);

      if (!client.supportsCallHierarchy) {
        logger.info({ language }, 'LSP server does not support call hierarchy, skipping');
        await client.shutdown();
        this.failed.add(language);
        return null;
      }

      this.clients.set(language, client);
      logger.info({ language }, 'LSP server ready');
      return client;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn({ language, command: spec.command, error: msg }, 'Failed to start LSP server');
      this.failed.add(language);
      return null;
    }
  }

  /** Get all currently active languages */
  activeLanguages(): string[] {
    return Array.from(this.clients.entries())
      .filter(([, c]) => c.isAlive())
      .map(([lang]) => lang);
  }

  /** Gracefully shut down all running servers */
  async shutdownAll(): Promise<void> {
    const tasks = Array.from(this.clients.entries()).map(async ([language, client]) => {
      try {
        await client.shutdown();
        logger.debug({ language }, 'LSP server shut down');
      } catch (e) {
        logger.debug({ language, error: (e as Error).message }, 'LSP server shutdown error');
      }
    });

    await Promise.allSettled(tasks);
    this.clients.clear();
    this.failed.clear();
  }
}
