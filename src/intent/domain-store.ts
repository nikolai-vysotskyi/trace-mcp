/**
 * Domain Store — CRUD operations for business domain tables.
 * Uses the same Database instance as the main Store (tables added via migration v9).
 */

import type Database from 'better-sqlite3';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

interface DomainRow {
  id: number;
  name: string;
  parent_id: number | null;
  description: string | null;
  path_hints: string | null;
  confidence: number;
  is_manual: number;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

interface SymbolDomainRow {
  id: number;
  symbol_id: number;
  domain_id: number;
  relevance: number;
  is_manual: number;
  inferred_by: string;
  metadata: string | null;
}

interface FileDomainRow {
  id: number;
  file_id: number;
  domain_id: number;
  relevance: number;
  is_manual: number;
  inferred_by: string;
}

interface DomainTreeNode {
  id: number;
  name: string;
  description: string | null;
  confidence: number;
  children: DomainTreeNode[];
  symbol_count?: number;
}

interface DomainInput {
  name: string;
  parentId?: number | null;
  description?: string;
  pathHints?: string[];
  confidence?: number;
  isManual?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CrossDomainDep {
  source_domain: string;
  target_domain: string;
  edge_count: number;
  edge_types: string[];
}

// ════════════════════════════════════════════════════════════════════════
// DOMAIN STORE
// ════════════════════════════════════════════════════════════════════════

export class DomainStore {
  constructor(public readonly db: Database.Database) {}

  // ── Domains ──────────────────────────────────────────────────────────

  upsertDomain(input: DomainInput): number {
    const existing = this.db
      .prepare('SELECT id FROM domains WHERE name = ? AND parent_id IS ?')
      .get(input.name, input.parentId ?? null) as { id: number } | undefined;

    if (existing) {
      this.db
        .prepare(`
        UPDATE domains SET description = COALESCE(?, description),
          path_hints = COALESCE(?, path_hints),
          confidence = COALESCE(?, confidence),
          is_manual = COALESCE(?, is_manual),
          metadata = COALESCE(?, metadata),
          updated_at = datetime('now')
        WHERE id = ?
      `)
        .run(
          input.description ?? null,
          input.pathHints ? JSON.stringify(input.pathHints) : null,
          input.confidence ?? null,
          input.isManual ? 1 : null,
          input.metadata ? JSON.stringify(input.metadata) : null,
          existing.id,
        );
      return existing.id;
    }

    return this.db
      .prepare(`
      INSERT INTO domains (name, parent_id, description, path_hints, confidence, is_manual, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        input.name,
        input.parentId ?? null,
        input.description ?? null,
        input.pathHints ? JSON.stringify(input.pathHints) : null,
        input.confidence ?? 1.0,
        input.isManual ? 1 : 0,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ).lastInsertRowid as number;
  }

  getDomain(id: number): DomainRow | undefined {
    return this.db.prepare('SELECT * FROM domains WHERE id = ?').get(id) as DomainRow | undefined;
  }

  getDomainByName(name: string, parentId?: number | null): DomainRow | undefined {
    return this.db
      .prepare('SELECT * FROM domains WHERE name = ? AND parent_id IS ?')
      .get(name, parentId ?? null) as DomainRow | undefined;
  }

  getRootDomains(): DomainRow[] {
    return this.db
      .prepare('SELECT * FROM domains WHERE parent_id IS NULL ORDER BY name')
      .all() as DomainRow[];
  }

  getChildDomains(parentId: number): DomainRow[] {
    return this.db
      .prepare('SELECT * FROM domains WHERE parent_id = ? ORDER BY name')
      .all(parentId) as DomainRow[];
  }

  getAllDomains(): DomainRow[] {
    return this.db.prepare('SELECT * FROM domains ORDER BY name').all() as DomainRow[];
  }

  getDomainTree(): DomainTreeNode[] {
    const all = this.getAllDomains();
    const counts = this.getSymbolCountPerDomain();
    const childrenMap = new Map<number | null, DomainRow[]>();

    for (const d of all) {
      const key = d.parent_id;
      if (!childrenMap.has(key)) childrenMap.set(key, []);
      childrenMap.get(key)!.push(d);
    }

    function buildTree(parentId: number | null): DomainTreeNode[] {
      const children = childrenMap.get(parentId) ?? [];
      return children.map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        confidence: d.confidence,
        symbol_count: counts.get(d.id) ?? 0,
        children: buildTree(d.id),
      }));
    }

    return buildTree(null);
  }

  deleteDomain(id: number): void {
    this.db.prepare('DELETE FROM domains WHERE id = ?').run(id);
  }

  // ── Symbol-Domain Mappings ────────────────────────────────────────────

  mapSymbolToDomain(
    symbolId: number,
    domainId: number,
    relevance: number,
    inferredBy: string,
    isManual = false,
  ): void {
    this.db
      .prepare(`
      INSERT OR REPLACE INTO symbol_domains (symbol_id, domain_id, relevance, inferred_by, is_manual)
      VALUES (?, ?, ?, ?, ?)
    `)
      .run(symbolId, domainId, relevance, inferredBy, isManual ? 1 : 0);
  }

  mapSymbolsToDomainBatch(
    mappings: Array<{ symbolId: number; domainId: number; relevance: number; inferredBy: string }>,
  ): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO symbol_domains (symbol_id, domain_id, relevance, inferred_by, is_manual)
      VALUES (?, ?, ?, ?, 0)
    `);
    this.db.transaction(() => {
      for (const m of mappings) {
        stmt.run(m.symbolId, m.domainId, m.relevance, m.inferredBy);
      }
    })();
  }

  getDomainsForSymbol(symbolId: number): Array<DomainRow & { relevance: number }> {
    return this.db
      .prepare(`
      SELECT d.*, sd.relevance FROM symbol_domains sd
      JOIN domains d ON sd.domain_id = d.id
      WHERE sd.symbol_id = ?
      ORDER BY sd.relevance DESC
    `)
      .all(symbolId) as Array<DomainRow & { relevance: number }>;
  }

  getSymbolsForDomain(
    domainId: number,
    includeChildren = false,
  ): Array<{
    symbol_id: number;
    symbol_id_str: string;
    name: string;
    kind: string;
    file_path: string;
    relevance: number;
  }> {
    if (!includeChildren) {
      return this.db
        .prepare(`
        SELECT s.id as symbol_id, s.symbol_id as symbol_id_str, s.name, s.kind, f.path as file_path, sd.relevance
        FROM symbol_domains sd
        JOIN symbols s ON sd.symbol_id = s.id
        JOIN files f ON s.file_id = f.id
        WHERE sd.domain_id = ?
        ORDER BY sd.relevance DESC
      `)
        .all(domainId) as any[];
    }

    // Include children: collect all domain IDs
    const domainIds = this.collectDescendantIds(domainId);
    domainIds.push(domainId);
    const placeholders = domainIds.map(() => '?').join(',');

    return this.db
      .prepare(`
      SELECT s.id as symbol_id, s.symbol_id as symbol_id_str, s.name, s.kind, f.path as file_path, sd.relevance
      FROM symbol_domains sd
      JOIN symbols s ON sd.symbol_id = s.id
      JOIN files f ON s.file_id = f.id
      WHERE sd.domain_id IN (${placeholders})
      ORDER BY sd.relevance DESC
    `)
      .all(...domainIds) as any[];
  }

  getUnclassifiedSymbolIds(
    limit: number,
  ): Array<{ id: number; name: string; kind: string; fqn: string | null; file_path: string }> {
    return this.db
      .prepare(`
      SELECT s.id, s.name, s.kind, s.fqn, f.path as file_path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.id NOT IN (SELECT symbol_id FROM symbol_domains)
        AND s.kind IN ('class', 'function', 'method', 'interface', 'trait', 'enum', 'type')
      LIMIT ?
    `)
      .all(limit) as any[];
  }

  clearInferredMappings(): void {
    this.db.prepare('DELETE FROM symbol_domains WHERE is_manual = 0').run();
  }

  // ── File-Domain Mappings ────────────────────────────────────────────

  mapFileToDomain(fileId: number, domainId: number, relevance: number, inferredBy: string): void {
    this.db
      .prepare(`
      INSERT OR REPLACE INTO file_domains (file_id, domain_id, relevance, inferred_by, is_manual)
      VALUES (?, ?, ?, ?, 0)
    `)
      .run(fileId, domainId, relevance, inferredBy);
  }

  getDomainsForFile(fileId: number): Array<DomainRow & { relevance: number }> {
    return this.db
      .prepare(`
      SELECT d.*, fd.relevance FROM file_domains fd
      JOIN domains d ON fd.domain_id = d.id
      WHERE fd.file_id = ?
    `)
      .all(fileId) as Array<DomainRow & { relevance: number }>;
  }

  // ── Cross-Domain Dependencies ──────────────────────────────────────

  getCrossDomainDependencies(focusDomainId?: number): CrossDomainDep[] {
    // Find edges between symbols in different domains
    const rows = this.db
      .prepare(`
      SELECT
        sd1.domain_id as source_domain_id,
        d1.name as source_domain,
        sd2.domain_id as target_domain_id,
        d2.name as target_domain,
        et.name as edge_type,
        COUNT(*) as cnt
      FROM edges e
      JOIN nodes n1 ON e.source_node_id = n1.id AND n1.node_type = 'symbol'
      JOIN nodes n2 ON e.target_node_id = n2.id AND n2.node_type = 'symbol'
      JOIN symbol_domains sd1 ON sd1.symbol_id = n1.ref_id
      JOIN symbol_domains sd2 ON sd2.symbol_id = n2.ref_id
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE sd1.domain_id != sd2.domain_id
      ${focusDomainId ? 'AND (sd1.domain_id = ? OR sd2.domain_id = ?)' : ''}
      GROUP BY sd1.domain_id, sd2.domain_id, et.name
      ORDER BY cnt DESC
    `)
      .all(...(focusDomainId ? [focusDomainId, focusDomainId] : [])) as Array<{
      source_domain: string;
      target_domain: string;
      edge_type: string;
      cnt: number;
    }>;

    // Aggregate edge types per domain pair
    const pairMap = new Map<string, CrossDomainDep>();
    for (const row of rows) {
      const key = `${row.source_domain}→${row.target_domain}`;
      if (!pairMap.has(key)) {
        pairMap.set(key, {
          source_domain: row.source_domain,
          target_domain: row.target_domain,
          edge_count: 0,
          edge_types: [],
        });
      }
      const entry = pairMap.get(key)!;
      entry.edge_count += row.cnt;
      if (!entry.edge_types.includes(row.edge_type)) {
        entry.edge_types.push(row.edge_type);
      }
    }

    return [...pairMap.values()].sort((a, b) => b.edge_count - a.edge_count);
  }

  // ── Stats ──────────────────────────────────────────────────────────

  getDomainStats(): { totalDomains: number; mappedSymbols: number; unmappedSymbols: number } {
    const totalDomains = (
      this.db.prepare('SELECT COUNT(*) as cnt FROM domains').get() as { cnt: number }
    ).cnt;
    const mappedSymbols = (
      this.db.prepare('SELECT COUNT(DISTINCT symbol_id) as cnt FROM symbol_domains').get() as {
        cnt: number;
      }
    ).cnt;
    const totalSymbols = (
      this.db
        .prepare(
          "SELECT COUNT(*) as cnt FROM symbols WHERE kind IN ('class','function','method','interface','trait','enum','type')",
        )
        .get() as { cnt: number }
    ).cnt;

    return { totalDomains, mappedSymbols, unmappedSymbols: totalSymbols - mappedSymbols };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private getSymbolCountPerDomain(): Map<number, number> {
    const rows = this.db
      .prepare(`
      SELECT domain_id, COUNT(*) as cnt FROM symbol_domains GROUP BY domain_id
    `)
      .all() as Array<{ domain_id: number; cnt: number }>;
    const map = new Map<number, number>();
    for (const r of rows) map.set(r.domain_id, r.cnt);
    return map;
  }

  private collectDescendantIds(parentId: number, visited = new Set<number>()): number[] {
    if (visited.has(parentId)) return []; // prevent circular hierarchy
    visited.add(parentId);
    const children = this.getChildDomains(parentId);
    const ids: number[] = [];
    for (const c of children) {
      ids.push(c.id);
      ids.push(...this.collectDescendantIds(c.id, visited));
    }
    return ids;
  }
}
