/**
 * LspBridge — orchestrator for the LSP enrichment subsystem.
 * Coordinates server lifecycle and enrichment passes.
 */

import type { TraceMcpConfig } from '../config.js';
import type { Store } from '../db/store.js';
import { logger } from '../logger.js';
import { fileLanguageToLspLanguage, resolveServers } from './config.js';
import { type EnrichmentResult, LspEnrichmentPass } from './enrichment.js';
import { LspServerManager } from './lifecycle.js';

export class LspBridge {
  private serverManager: LspServerManager | null = null;

  constructor(
    private readonly store: Store,
    private readonly config: TraceMcpConfig,
    private readonly rootPath: string,
  ) {}

  /**
   * Run the LSP enrichment pass: detect servers, start them, enrich edges.
   */
  async enrich(): Promise<EnrichmentResult> {
    // Determine which languages are in the index
    const indexedLanguages = this.detectIndexedLanguages();
    if (indexedLanguages.size === 0) {
      logger.debug('No LSP-supported languages in index, skipping enrichment');
      return emptyResult();
    }

    // Resolve server specs
    const specs = resolveServers(this.config, this.rootPath, indexedLanguages);
    if (specs.length === 0) {
      logger.info('No LSP servers available, skipping enrichment');
      return emptyResult();
    }

    logger.info(
      { servers: specs.map((s) => s.language), languages: Array.from(indexedLanguages) },
      'Starting LSP enrichment',
    );

    // Create server manager
    this.serverManager = new LspServerManager(
      specs,
      this.rootPath,
      this.config.lsp?.max_concurrent_servers ?? 2,
    );

    // Run enrichment
    const enrichment = new LspEnrichmentPass(
      this.store,
      this.serverManager,
      this.rootPath,
      this.config.lsp?.batch_size ?? 100,
      this.config.lsp?.enrichment_timeout_ms ?? 120_000,
    );

    const result = await enrichment.enrichEdges();

    logger.info(
      {
        upgraded: result.edgesUpgraded,
        added: result.edgesAdded,
        failed: result.edgesFailed,
        queried: result.symbolsQueried,
        durationMs: result.durationMs,
        servers: result.serverStatuses,
      },
      'LSP enrichment completed',
    );

    return result;
  }

  /**
   * Shut down all LSP servers.
   */
  async shutdown(): Promise<void> {
    if (this.serverManager) {
      await this.serverManager.shutdownAll();
      this.serverManager = null;
    }
  }

  /**
   * Detect which LSP-supported languages are present in the index.
   */
  private detectIndexedLanguages(): Set<string> {
    const languages = new Set<string>();
    const files = this.store.getAllFiles();
    for (const file of files) {
      const lspLang = fileLanguageToLspLanguage(file.language);
      if (lspLang) languages.add(lspLang);
    }
    return languages;
  }
}

function emptyResult(): EnrichmentResult {
  return {
    edgesUpgraded: 0,
    edgesAdded: 0,
    edgesFailed: 0,
    symbolsQueried: 0,
    durationMs: 0,
    serverStatuses: {},
  };
}
