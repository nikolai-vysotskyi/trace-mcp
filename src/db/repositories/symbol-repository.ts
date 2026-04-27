import type Database from 'better-sqlite3';
import type { RawSymbol } from '../../plugin-api/types.js';
import type { SymbolRow, SymbolWithFilePath } from '../types.js';

export class SymbolRepository {
  private readonly _stmts: {
    insertSymbol: Database.Statement;
    deleteSymbolsByFileId: Database.Statement;
    deleteSymbolNodesByFileId: Database.Statement;
    getSymbolsByFileId: Database.Statement;
    getSymbolBySymbolId: Database.Statement;
    getSymbolByFqn: Database.Statement;
    getSymbolById: Database.Statement;
  };

  constructor(private readonly db: Database.Database) {
    this._stmts = {
      insertSymbol: db.prepare(
        `INSERT OR REPLACE INTO symbols (file_id, symbol_id, name, kind, fqn, parent_id, signature, byte_start, byte_end, line_start, line_end, metadata, cyclomatic, max_nesting, param_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      deleteSymbolsByFileId: db.prepare('DELETE FROM symbols WHERE file_id = ?'),
      deleteSymbolNodesByFileId: db.prepare(
        `DELETE FROM nodes WHERE node_type = 'symbol'
         AND ref_id IN (SELECT id FROM symbols WHERE file_id = ?)`,
      ),
      getSymbolsByFileId: db.prepare('SELECT * FROM symbols WHERE file_id = ? ORDER BY byte_start'),
      getSymbolBySymbolId: db.prepare('SELECT * FROM symbols WHERE symbol_id = ?'),
      getSymbolByFqn: db.prepare('SELECT * FROM symbols WHERE fqn = ?'),
      getSymbolById: db.prepare('SELECT * FROM symbols WHERE id = ?'),
    };
  }

  insertSymbol(
    fileId: number,
    sym: RawSymbol,
    parentIdOverride: number | null | undefined,
    createNode: (nodeType: string, refId: number) => number,
  ): number {
    const parentId =
      parentIdOverride !== undefined
        ? parentIdOverride
        : sym.parentSymbolId
          ? ((
              this.db
                .prepare('SELECT id FROM symbols WHERE symbol_id = ?')
                .get(sym.parentSymbolId) as { id: number } | undefined
            )?.id ?? null)
          : null;

    const cyclomatic =
      ((sym.metadata as Record<string, unknown> | undefined)?.['cyclomatic'] as
        | number
        | undefined) ?? null;
    const maxNesting =
      ((sym.metadata as Record<string, unknown> | undefined)?.['max_nesting'] as
        | number
        | undefined) ?? null;
    const paramCount =
      ((sym.metadata as Record<string, unknown> | undefined)?.['param_count'] as
        | number
        | undefined) ?? null;

    // Guard: auto-generate symbolId if missing (framework plugins may omit it)
    const symbolIdStr = sym.symbolId || `file:${fileId}::${sym.name}#${sym.kind}`;

    const result = this._stmts.insertSymbol.run(
      fileId,
      symbolIdStr,
      sym.name,
      sym.kind,
      sym.fqn ?? null,
      parentId,
      sym.signature ?? null,
      sym.byteStart ?? 0,
      sym.byteEnd ?? 0,
      sym.lineStart ?? null,
      sym.lineEnd ?? null,
      sym.metadata ? JSON.stringify(sym.metadata) : null,
      cyclomatic,
      maxNesting,
      paramCount,
    );

    const symbolId = Number(result.lastInsertRowid);
    createNode('symbol', symbolId);
    return symbolId;
  }

  insertSymbols(
    fileId: number,
    symbols: RawSymbol[],
    insertSymbolFn: (fileId: number, sym: RawSymbol, parentIdOverride?: number | null) => number,
  ): number[] {
    return this.db.transaction(() => {
      const parentSymbolIds = symbols
        .map((s) => s.parentSymbolId)
        .filter((id): id is string => id != null);

      const parentIdMap = new Map<string, number>();
      if (parentSymbolIds.length > 0) {
        const unique = [...new Set(parentSymbolIds)];
        const placeholders = unique.map(() => '?').join(',');
        const rows = this.db
          .prepare(`SELECT symbol_id, id FROM symbols WHERE symbol_id IN (${placeholders})`)
          .all(...unique) as { symbol_id: string; id: number }[];
        for (const row of rows) parentIdMap.set(row.symbol_id, row.id);
      }

      const ids: number[] = [];
      for (const sym of symbols) {
        let parentId: number | null = null;
        if (sym.parentSymbolId) {
          parentId = parentIdMap.get(sym.parentSymbolId) ?? null;
          if (parentId == null) {
            const idx = symbols.findIndex((s) => s.symbolId === sym.parentSymbolId);
            if (idx >= 0 && idx < ids.length) {
              parentId = ids[idx];
            }
          }
        }
        const id = insertSymbolFn(fileId, sym, parentId);
        ids.push(id);
        parentIdMap.set(sym.symbolId, id);
      }
      return ids;
    })();
  }

  deleteSymbolsByFile(fileId: number): void {
    this._stmts.deleteSymbolNodesByFileId.run(fileId);
    this._stmts.deleteSymbolsByFileId.run(fileId);
  }

  getSymbolsByFile(fileId: number): SymbolRow[] {
    return this._stmts.getSymbolsByFileId.all(fileId) as SymbolRow[];
  }

  getSymbolBySymbolId(symbolId: string): SymbolRow | undefined {
    return this._stmts.getSymbolBySymbolId.get(symbolId) as SymbolRow | undefined;
  }

  getSymbolByFqn(fqn: string): SymbolRow | undefined {
    return this._stmts.getSymbolByFqn.get(fqn) as SymbolRow | undefined;
  }

  getSymbolById(id: number): SymbolRow | undefined {
    return this._stmts.getSymbolById.get(id) as SymbolRow | undefined;
  }

  getSymbolChildren(parentId: number): SymbolRow[] {
    return this.db
      .prepare('SELECT * FROM symbols WHERE parent_id = ?')
      .all(parentId) as SymbolRow[];
  }

  getSymbolByName(name: string, kind?: string): SymbolRow | undefined {
    if (kind) {
      return this.db
        .prepare('SELECT * FROM symbols WHERE name = ? AND kind = ? LIMIT 1')
        .get(name, kind) as SymbolRow | undefined;
    }
    return this.db.prepare('SELECT * FROM symbols WHERE name = ? LIMIT 1').get(name) as
      | SymbolRow
      | undefined;
  }

  getExportedSymbols(filePattern?: string): SymbolWithFilePath[] {
    if (filePattern) {
      const likePattern = filePattern.replace(/\*/g, '%').replace(/\?/g, '_');
      return this.db
        .prepare(
          `SELECT s.*, f.path as file_path
         FROM symbols s
         JOIN files f ON s.file_id = f.id
         WHERE json_extract(s.metadata, '$.exported') = 1
         AND f.path LIKE ?`,
        )
        .all(likePattern) as SymbolWithFilePath[];
    }
    return this.db
      .prepare(
        `SELECT s.*, f.path as file_path
       FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE json_extract(s.metadata, '$.exported') = 1`,
      )
      .all() as SymbolWithFilePath[];
  }

  findImplementors(name: string): SymbolWithFilePath[] {
    return this.db
      .prepare(
        `SELECT s.*, f.path as file_path
       FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE s.metadata IS NOT NULL AND (
         json_extract(s.metadata, '$.implements') LIKE '%"' || ? || '"%'
         OR json_extract(s.metadata, '$.extends') LIKE '%"' || ? || '"%'
         OR json_extract(s.metadata, '$.extends') = ?
       )`,
      )
      .all(name, name, name) as SymbolWithFilePath[];
  }

  getSymbolsWithHeritage(fileIds?: number[]): (SymbolRow & { file_path: string })[] {
    const base = `SELECT s.*, f.path AS file_path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.metadata IS NOT NULL
        AND (json_extract(s.metadata, '$.extends') IS NOT NULL
          OR json_extract(s.metadata, '$.implements') IS NOT NULL)`;
    if (fileIds && fileIds.length > 0) {
      const ph = fileIds.map(() => '?').join(',');
      return this.db.prepare(`${base} AND s.file_id IN (${ph})`).all(...fileIds) as (SymbolRow & {
        file_path: string;
      })[];
    }
    return this.db.prepare(base).all() as (SymbolRow & { file_path: string })[];
  }

  getSymbolsByIds(ids: number[]): Map<number, SymbolRow> {
    const map = new Map<number, SymbolRow>();
    if (ids.length === 0) return map;
    const CHUNK = 900;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM symbols WHERE id IN (${placeholders})`)
        .all(...chunk) as SymbolRow[];
      for (const row of rows) map.set(row.id, row);
    }
    return map;
  }

  findSymbolByRole(name: string, frameworkRole?: string): SymbolRow | undefined {
    if (frameworkRole) {
      return this.db
        .prepare(
          `SELECT s.* FROM symbols s
         JOIN files f ON s.file_id = f.id
         WHERE f.framework_role = ?
           AND (s.name = ? OR s.fqn LIKE ?)
         LIMIT 1`,
        )
        .get(frameworkRole, name, `%\\${name}`) as SymbolRow | undefined;
    }
    return this.db
      .prepare('SELECT * FROM symbols WHERE name = ? AND kind = ? LIMIT 1')
      .get(name, 'class') as SymbolRow | undefined;
  }

  updateSymbolSummary(symbolId: number, summary: string): void {
    this.db.prepare('UPDATE symbols SET summary = ? WHERE id = ?').run(summary, symbolId);
  }

  countUnsummarizedSymbols(kinds: string[]): number {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => '?').join(',');
    const row = this.db
      .prepare(`
      SELECT COUNT(*) as cnt FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.summary IS NULL AND s.kind IN (${placeholders}) AND f.gitignored = 0
    `)
      .get(...kinds) as { cnt: number };
    return row.cnt;
  }

  countUnembeddedSymbols(): number {
    const row = this.db
      .prepare(`
      SELECT COUNT(*) as cnt FROM symbols s
      LEFT JOIN symbol_embeddings se ON se.symbol_id = s.id
      WHERE se.symbol_id IS NULL
    `)
      .get() as { cnt: number };
    return row.cnt;
  }

  getUnsummarizedSymbols(
    kinds: string[],
    limit: number,
  ): {
    id: number;
    name: string;
    fqn: string | null;
    kind: string;
    signature: string | null;
    file_path: string;
    byte_start: number;
    byte_end: number;
  }[] {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => '?').join(',');
    return this.db
      .prepare(`
      SELECT s.id, s.name, s.fqn, s.kind, s.signature, f.path as file_path, s.byte_start, s.byte_end
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.summary IS NULL AND s.kind IN (${placeholders}) AND f.gitignored = 0
      LIMIT ?
    `)
      .all(...kinds, limit) as {
      id: number;
      name: string;
      fqn: string | null;
      kind: string;
      signature: string | null;
      file_path: string;
      byte_start: number;
      byte_end: number;
    }[];
  }
}
