/**
 * Intent Layer tools — query code by business domain.
 * - query_by_intent: NL query → relevant symbols
 * - get_domain_map: hierarchical domain tree
 * - get_domain_context: all code in a domain
 * - get_cross_domain_dependencies: which domains depend on which
 */

import type { Store } from '../db/store.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { validationError, notFound } from '../errors.js';
import { DomainStore, type DomainTreeNode, type CrossDomainDep } from '../intent/domain-store.js';
import { DomainBuilder, type IntentConfig } from '../intent/domain-builder.js';
import { searchFts, type FtsResult } from '../db/fts.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface QueryByIntentResult {
  query: string;
  symbols: Array<{
    symbol_id: string;
    name: string;
    kind: string;
    file: string;
    domain: string;
    relevance: number;
  }>;
  domains_touched: string[];
}

export interface DomainMapResult {
  domains: DomainTreeNode[];
  stats: { totalDomains: number; mappedSymbols: number; unmappedSymbols: number };
}

export interface DomainContextResult {
  domain: { name: string; description: string | null };
  symbols: Array<{
    symbol_id: string;
    name: string;
    kind: string;
    file: string;
    relevance: number;
  }>;
  files: string[];
  related_domains: string[];
}

export interface CrossDomainResult {
  dependencies: CrossDomainDep[];
}

// ════════════════════════════════════════════════════════════════════════
// 1. QUERY BY INTENT
// ════════════════════════════════════════════════════════════════════════

export function queryByIntent(
  store: Store,
  query: string,
  options: { limit?: number } = {},
): TraceMcpResult<QueryByIntentResult> {
  const limit = options.limit ?? 15;
  const domainStore = new DomainStore(store.db);

  // Step 1: FTS search for matching symbols
  const ftsResults = searchFts(store.db, query, limit * 2);

  // Step 2: Enrich with domain info
  const symbols: QueryByIntentResult['symbols'] = [];
  const domainsSet = new Set<string>();

  for (const fts of ftsResults) {
    // Get file path
    const file = store.getFileById(fts.fileId);
    if (!file) continue;

    // Get domain for this symbol
    const sym = store.getSymbolById(fts.symbolId as unknown as number);
    if (!sym) continue;

    const domains = domainStore.getDomainsForSymbol(sym.id);
    const primaryDomain = domains[0]?.name ?? 'uncategorized';
    domainsSet.add(primaryDomain);

    symbols.push({
      symbol_id: fts.symbolIdStr,
      name: fts.name,
      kind: fts.kind,
      file: file.path,
      domain: primaryDomain,
      relevance: domains[0]?.relevance ?? 0,
    });

    if (symbols.length >= limit) break;
  }

  // Also search domain names/descriptions
  const allDomains = domainStore.getAllDomains();
  const queryLower = query.toLowerCase();
  for (const d of allDomains) {
    const nameMatch = d.name.toLowerCase().includes(queryLower);
    const descMatch = d.description?.toLowerCase().includes(queryLower);
    if (nameMatch || descMatch) {
      domainsSet.add(d.name);
      // Fetch top symbols from matching domain
      const domainSymbols = domainStore.getSymbolsForDomain(d.id, true);
      for (const ds of domainSymbols.slice(0, 5)) {
        if (symbols.length >= limit) break;
        if (symbols.some((s) => s.symbol_id === ds.symbol_id_str)) continue;
        symbols.push({
          symbol_id: ds.symbol_id_str,
          name: ds.name,
          kind: ds.kind,
          file: ds.file_path,
          domain: d.name,
          relevance: ds.relevance,
        });
      }
    }
  }

  return ok({
    query,
    symbols: symbols.slice(0, limit),
    domains_touched: [...domainsSet],
  });
}

// ════════════════════════════════════════════════════════════════════════
// 2. GET DOMAIN MAP
// ════════════════════════════════════════════════════════════════════════

export async function getDomainMap(
  store: Store,
  options: { depth?: number; includeSymbols?: boolean; symbolsPerDomain?: number } = {},
): Promise<TraceMcpResult<DomainMapResult>> {
  const { depth = 3, includeSymbols = true, symbolsPerDomain = 5 } = options;
  const domainStore = new DomainStore(store.db);

  let tree = domainStore.getDomainTree();

  // Trim depth
  function trimDepth(nodes: DomainTreeNode[], currentDepth: number): DomainTreeNode[] {
    if (currentDepth >= depth) return nodes.map((n) => ({ ...n, children: [] }));
    return nodes.map((n) => ({ ...n, children: trimDepth(n.children, currentDepth + 1) }));
  }
  tree = trimDepth(tree, 1);

  // Auto-build if empty
  if (tree.length === 0) {
    const builder = new DomainBuilder(store);
    await builder.buildAll();
    tree = domainStore.getDomainTree();
    tree = trimDepth(tree, 1);
  }

  const stats = domainStore.getDomainStats();

  return ok({ domains: tree, stats });
}

// ════════════════════════════════════════════════════════════════════════
// 3. GET DOMAIN CONTEXT
// ════════════════════════════════════════════════════════════════════════

export async function getDomainContext(
  store: Store,
  domainName: string,
  options: { includeRelated?: boolean; tokenBudget?: number } = {},
): Promise<TraceMcpResult<DomainContextResult>> {
  const { includeRelated = false, tokenBudget = 4000 } = options;
  const domainStore = new DomainStore(store.db);

  // Find domain (supports "parent/child" path notation)
  const parts = domainName.split('/');
  let domain = domainStore.getDomainByName(parts[0]);
  for (let i = 1; i < parts.length && domain; i++) {
    domain = domainStore.getDomainByName(parts[i], domain.id);
  }

  if (!domain) {
    // Try to auto-build domains first
    const builder = new DomainBuilder(store);
    await builder.buildAll();
    domain = domainStore.getDomainByName(parts[0]);
    if (!domain) {
      return err(notFound(domainName, domainStore.getAllDomains().map((d) => d.name)));
    }
  }

  const symbols = domainStore.getSymbolsForDomain(domain.id, true);
  const files = [...new Set(symbols.map((s) => s.file_path))];

  // Get related domains
  const relatedDomains: string[] = [];
  if (includeRelated) {
    const deps = domainStore.getCrossDomainDependencies(domain.id);
    for (const dep of deps) {
      if (dep.source_domain !== domain.name && !relatedDomains.includes(dep.source_domain)) {
        relatedDomains.push(dep.source_domain);
      }
      if (dep.target_domain !== domain.name && !relatedDomains.includes(dep.target_domain)) {
        relatedDomains.push(dep.target_domain);
      }
    }
  }

  return ok({
    domain: { name: domain.name, description: domain.description },
    symbols: symbols.slice(0, 100).map((s) => ({
      symbol_id: s.symbol_id_str,
      name: s.name,
      kind: s.kind,
      file: s.file_path,
      relevance: s.relevance,
    })),
    files,
    related_domains: relatedDomains,
  });
}

// ════════════════════════════════════════════════════════════════════════
// 4. CROSS-DOMAIN DEPENDENCIES
// ════════════════════════════════════════════════════════════════════════

export async function getCrossDomainDependencies(
  store: Store,
  options: { domain?: string } = {},
): Promise<TraceMcpResult<CrossDomainResult>> {
  const domainStore = new DomainStore(store.db);

  let focusDomainId: number | undefined;
  if (options.domain) {
    const d = domainStore.getDomainByName(options.domain);
    if (!d) {
      return err(notFound(options.domain, domainStore.getAllDomains().map((dd) => dd.name)));
    }
    focusDomainId = d.id;
  }

  // Auto-build if no domains exist
  if (domainStore.getAllDomains().length === 0) {
    const builder = new DomainBuilder(store);
    await builder.buildAll();
  }

  const deps = domainStore.getCrossDomainDependencies(focusDomainId);

  return ok({ dependencies: deps });
}
