/**
 * Domain Builder — orchestrates domain taxonomy creation and symbol classification.
 * Uses heuristic classifier (always) with optional AI refinement.
 */

import type { Store } from '../db/store.js';
import { DomainStore } from './domain-store.js';
import {
  classifyBatch,
  inferTaxonomyHeuristic,
  type ClassifiableSymbol,
} from './heuristic-classifier.js';
import { logger } from '../logger.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

interface DomainBuildResult {
  domains_created: number;
  symbols_classified: number;
  method: 'heuristic' | 'ai';
  duration_ms: number;
}

export interface IntentConfig {
  enabled?: boolean;
  domain_hints?: Record<string, string[]>;
  custom_domains?: Array<{
    name: string;
    parent?: string;
    description?: string;
    path_patterns: string[];
  }>;
  auto_classify_on_index?: boolean;
  classify_batch_size?: number;
}

// ════════════════════════════════════════════════════════════════════════
// DOMAIN BUILDER
// ════════════════════════════════════════════════════════════════════════

export class DomainBuilder {
  private domainStore: DomainStore;

  constructor(
    private store: Store,
    private config: IntentConfig = {},
  ) {
    this.domainStore = new DomainStore(store.db);
  }

  /**
   * Full build: infer taxonomy + classify all symbols.
   */
  async buildAll(): Promise<DomainBuildResult> {
    const start = Date.now();

    // Step 1: Register custom domains from config
    this.registerCustomDomains();

    // Step 2: Sample symbols for taxonomy inference
    const allSymbols = this.getAllClassifiableSymbols(500);

    // Step 3: Infer taxonomy from symbol distribution
    const discoveredDomains = inferTaxonomyHeuristic(allSymbols, this.config.domain_hints);

    let domainsCreated = 0;
    for (const domain of discoveredDomains) {
      const existing = this.domainStore.getDomainByName(domain.name);
      if (!existing) {
        this.domainStore.upsertDomain({
          name: domain.name,
          description: domain.description,
          confidence: 0.7,
        });
        domainsCreated++;
      }
    }

    // Step 4: Classify all symbols
    const symbolsClassified = this.classifyAllSymbols();

    const durationMs = Date.now() - start;
    logger.info({ domainsCreated, symbolsClassified, durationMs }, 'Domain build completed');

    return {
      domains_created: domainsCreated,
      symbols_classified: symbolsClassified,
      method: 'heuristic',
      duration_ms: durationMs,
    };
  }

  /**
   * Incremental: classify only unclassified symbols into existing domains.
   */
  async classifyIncremental(batchSize?: number): Promise<{ newMappings: number }> {
    const limit = batchSize ?? this.config.classify_batch_size ?? 100;
    const unclassified = this.domainStore.getUnclassifiedSymbolIds(limit);

    if (unclassified.length === 0) return { newMappings: 0 };

    const symbols: ClassifiableSymbol[] = unclassified.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      fqn: s.fqn,
      filePath: s.file_path,
    }));

    const classifications = classifyBatch(symbols, this.config.domain_hints);
    const existingDomains = new Map<string, number>();
    for (const d of this.domainStore.getAllDomains()) {
      existingDomains.set(d.name, d.id);
    }

    let newMappings = 0;
    const mappings: Array<{
      symbolId: number;
      domainId: number;
      relevance: number;
      inferredBy: string;
    }> = [];

    for (const [symbolId, suggestion] of classifications) {
      const domainName = suggestion.domainPath[0];
      let domainId = existingDomains.get(domainName);

      if (!domainId) {
        // Create domain on the fly
        domainId = this.domainStore.upsertDomain({
          name: domainName,
          description: `Business domain: ${domainName}`,
          confidence: suggestion.confidence,
        });
        existingDomains.set(domainName, domainId);
      }

      mappings.push({
        symbolId,
        domainId,
        relevance: suggestion.confidence,
        inferredBy: 'heuristic',
      });
      newMappings++;
    }

    if (mappings.length > 0) {
      this.domainStore.mapSymbolsToDomainBatch(mappings);
    }

    return { newMappings };
  }

  getDomainStore(): DomainStore {
    return this.domainStore;
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  private registerCustomDomains(): void {
    if (!this.config.custom_domains) return;

    for (const custom of this.config.custom_domains) {
      let parentId: number | null = null;
      if (custom.parent) {
        const parent = this.domainStore.getDomainByName(custom.parent);
        parentId = parent?.id ?? null;
      }

      this.domainStore.upsertDomain({
        name: custom.name,
        parentId,
        description: custom.description,
        pathHints: custom.path_patterns,
        isManual: true,
        confidence: 1.0,
      });
    }
  }

  private getAllClassifiableSymbols(limit: number): ClassifiableSymbol[] {
    const rows = this.store.db
      .prepare(`
      SELECT s.id, s.name, s.kind, s.fqn, f.path as file_path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.kind IN ('class', 'function', 'method', 'interface', 'trait', 'enum', 'type')
      LIMIT ?
    `)
      .all(limit) as Array<{
      id: number;
      name: string;
      kind: string;
      fqn: string | null;
      file_path: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      fqn: r.fqn,
      filePath: r.file_path,
    }));
  }

  private classifyAllSymbols(): number {
    const batchSize = this.config.classify_batch_size ?? 100;
    let totalClassified = 0;
    let offset = 0;

    const existingDomains = new Map<string, number>();
    for (const d of this.domainStore.getAllDomains()) {
      existingDomains.set(d.name, d.id);
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = this.store.db
        .prepare(`
        SELECT s.id, s.name, s.kind, s.fqn, f.path as file_path
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE s.kind IN ('class', 'function', 'method', 'interface', 'trait', 'enum', 'type')
        LIMIT ? OFFSET ?
      `)
        .all(batchSize, offset) as Array<{
        id: number;
        name: string;
        kind: string;
        fqn: string | null;
        file_path: string;
      }>;

      if (rows.length === 0) break;

      const symbols: ClassifiableSymbol[] = rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        fqn: r.fqn,
        filePath: r.file_path,
      }));

      const classifications = classifyBatch(symbols, this.config.domain_hints);
      const mappings: Array<{
        symbolId: number;
        domainId: number;
        relevance: number;
        inferredBy: string;
      }> = [];

      for (const [symbolId, suggestion] of classifications) {
        const domainName = suggestion.domainPath[0];
        let domainId = existingDomains.get(domainName);

        if (!domainId) {
          domainId = this.domainStore.upsertDomain({
            name: domainName,
            description: `Business domain: ${domainName}`,
            confidence: suggestion.confidence,
          });
          existingDomains.set(domainName, domainId);
        }

        mappings.push({
          symbolId,
          domainId,
          relevance: suggestion.confidence,
          inferredBy: 'heuristic',
        });
      }

      if (mappings.length > 0) {
        this.domainStore.mapSymbolsToDomainBatch(mappings);
        totalClassified += mappings.length;
      }

      offset += batchSize;
    }

    return totalClassified;
  }
}
