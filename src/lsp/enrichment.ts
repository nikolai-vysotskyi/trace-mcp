/**
 * LSP enrichment pass — upgrades call graph edges with compiler-grade resolution.
 * Runs after tree-sitter indexing + edge resolution, enriching existing edges
 * and discovering new ones via LSP call hierarchy.
 */

import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from '../logger.js';
import type { Store } from '../db/store.js';
import type { SymbolRow, FileRow } from '../db/types.js';
import type { LspServerManager } from './lifecycle.js';
import {
  symbolToLspPosition,
  findSymbolAtPosition,
  getLanguageId,
} from './mappers.js';
import { fileLanguageToLspLanguage } from './config.js';
import type { CallHierarchyOutgoingCall } from './protocol.js';
import type { LspClient } from './client.js';

/** Edge types that represent call semantics — eligible for LSP enrichment */
const CALL_EDGE_TYPES = new Set([
  'calls', 'references', 'dispatches', 'routes_to',
  'validates_with', 'nest_injects', 'graphql_resolves',
  'esm_imports', 'imports', 'uses',
  'renders_component', 'uses_composable',
]);

export interface EnrichmentResult {
  edgesUpgraded: number;
  edgesAdded: number;
  edgesFailed: number;
  symbolsQueried: number;
  durationMs: number;
  serverStatuses: Record<string, 'ok' | 'failed' | 'unavailable'>;
}

interface SymbolWithFile {
  symbol: SymbolRow;
  file: FileRow;
  language: string;
}

export class LspEnrichmentPass {
  constructor(
    private readonly store: Store,
    private readonly serverManager: LspServerManager,
    private readonly rootPath: string,
    private readonly batchSize: number,
    private readonly enrichmentTimeoutMs: number,
  ) {}

  async enrichEdges(): Promise<EnrichmentResult> {
    const startTime = Date.now();
    const result: EnrichmentResult = {
      edgesUpgraded: 0,
      edgesAdded: 0,
      edgesFailed: 0,
      symbolsQueried: 0,
      durationMs: 0,
      serverStatuses: {},
    };

    // 1. Collect callable symbols grouped by language
    const symbolsByLanguage = this.collectCallableSymbols();
    if (symbolsByLanguage.size === 0) {
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // 2. Process each language
    for (const [language, symbols] of symbolsByLanguage) {
      const client = await this.serverManager.getClient(language);
      if (!client) {
        result.serverStatuses[language] = 'unavailable';
        continue;
      }

      try {
        await this.enrichLanguage(client, language, symbols, result);
        result.serverStatuses[language] = 'ok';
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn({ language, error: msg }, 'LSP enrichment failed for language');
        result.serverStatuses[language] = 'failed';
      }

      // Check overall timeout
      if (Date.now() - startTime > this.enrichmentTimeoutMs) {
        logger.info('LSP enrichment timeout reached, stopping');
        break;
      }
    }

    result.durationMs = Date.now() - startTime;
    return result;
  }

  /**
   * Collect symbols that are callable (functions, methods, constructors)
   * and group them by LSP language.
   */
  private collectCallableSymbols(): Map<string, SymbolWithFile[]> {
    const callableKinds = new Set([
      'function', 'method', 'constructor', 'arrow_function',
      'generator', 'async_function',
    ]);

    const byLanguage = new Map<string, SymbolWithFile[]>();
    const files = this.store.getAllFiles();

    for (const file of files) {
      const lspLang = fileLanguageToLspLanguage(file.language);
      if (!lspLang) continue;

      const symbols = this.store.getSymbolsByFile(file.id);
      for (const sym of symbols) {
        if (!callableKinds.has(sym.kind)) continue;

        let group = byLanguage.get(lspLang);
        if (!group) {
          group = [];
          byLanguage.set(lspLang, group);
        }
        group.push({ symbol: sym, file, language: lspLang });
      }
    }

    return byLanguage;
  }

  /**
   * Enrich edges for all symbols of a given language.
   */
  private async enrichLanguage(
    client: LspClient,
    language: string,
    symbols: SymbolWithFile[],
    result: EnrichmentResult,
  ): Promise<void> {
    // Build lookup: existing call edges by source node ID
    const existingEdges = this.loadExistingCallEdges();

    // Process symbols in batches
    const openedFiles = new Set<string>();

    for (let i = 0; i < symbols.length; i += this.batchSize) {
      const batch = symbols.slice(i, i + this.batchSize);

      for (const { symbol, file } of batch) {
        try {
          // Ensure file is open in LSP
          const absPath = resolve(this.rootPath, file.path);
          const uri = pathToFileURL(absPath).href;

          if (!openedFiles.has(uri)) {
            try {
              const content = readFileSync(absPath, 'utf-8');
              const langId = getLanguageId(file.path) ?? language;
              await client.openDocument(uri, langId, content);
              openedFiles.add(uri);
            } catch {
              // File may have been deleted since indexing
              continue;
            }
          }

          // Get LSP position for this symbol
          const pos = symbolToLspPosition(symbol, file, this.rootPath);

          // Prepare call hierarchy at this position
          const items = await client.prepareCallHierarchy(pos.uri, pos.line, pos.character);
          if (items.length === 0) {
            result.edgesFailed++;
            continue;
          }

          // Get outgoing calls
          const outgoing = await client.outgoingCalls(items[0]);
          result.symbolsQueried++;

          // Process each outgoing call
          for (const call of outgoing) {
            this.processOutgoingCall(symbol, call, existingEdges, result);
          }
        } catch (e) {
          result.edgesFailed++;
          logger.debug(
            { symbol: symbol.symbol_id, error: (e as Error).message },
            'LSP enrichment failed for symbol',
          );
        }
      }
    }

    // Close opened files
    for (const uri of openedFiles) {
      await client.closeDocument(uri).catch(() => {});
    }
  }

  /**
   * Load existing call-type edges into a lookup map.
   * Key: `${sourceNodeId}:${targetNodeId}` -> edge ID
   */
  private loadExistingCallEdges(): Map<string, number> {
    const map = new Map<string, number>();

    // Query all edges of call types
    for (const edgeType of CALL_EDGE_TYPES) {
      const edges = this.store.getEdgesByType(edgeType);
      for (const edge of edges) {
        const key = `${edge.source_node_id}:${edge.target_node_id}`;
        map.set(key, edge.id);
      }
    }

    return map;
  }

  /**
   * Process a single outgoing call from LSP and either upgrade or add an edge.
   */
  private processOutgoingCall(
    sourceSymbol: SymbolRow,
    call: CallHierarchyOutgoingCall,
    existingEdges: Map<string, number>,
    result: EnrichmentResult,
  ): void {
    // Map the LSP call target back to a trace-mcp symbol
    const target = findSymbolAtPosition(
      this.store,
      this.rootPath,
      call.to.uri,
      call.to.selectionRange.start.line,
    );
    if (!target) return;

    // Get node IDs for source and target
    const sourceNodeId = this.store.getNodeId('symbol', sourceSymbol.id);
    const targetNodeId = this.store.getNodeId('symbol', target.symbol.id);
    if (sourceNodeId == null || targetNodeId == null) return;

    const edgeKey = `${sourceNodeId}:${targetNodeId}`;
    const existingEdgeId = existingEdges.get(edgeKey);

    if (existingEdgeId != null) {
      // Upgrade existing edge to lsp_resolved
      this.upgradeEdge(existingEdgeId);
      result.edgesUpgraded++;
    } else {
      // New edge discovered by LSP
      const edgeResult = this.store.insertEdge(
        sourceNodeId, targetNodeId, 'calls', true, undefined, false, 'lsp_resolved',
      );
      if (edgeResult.isOk()) {
        result.edgesAdded++;
      }
    }
  }

  /**
   * Upgrade an existing edge's resolution_tier to 'lsp_resolved'.
   */
  private upgradeEdge(edgeId: number): void {
    this.store.db.prepare(
      `UPDATE edges SET resolution_tier = 'lsp_resolved' WHERE id = ? AND resolution_tier != 'lsp_resolved'`,
    ).run(edgeId);
  }
}
