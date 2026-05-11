import type Database from 'better-sqlite3';
import type { FileRow } from '../types.js';

export class FileRepository {
  private readonly _stmts: {
    insertFile: Database.Statement;
    getFile: Database.Statement;
    getFileById: Database.Statement;
    updateFileHash: Database.Statement;
    updateFileMtime: Database.Statement;
    updateFileStatus: Database.Statement;
    updateFileGitignored: Database.Statement;
    deleteFileById: Database.Statement;
    deleteNodeByTypeAndRef: Database.Statement;
  };

  constructor(private readonly db: Database.Database) {
    this._stmts = {
      insertFile: db.prepare(
        `INSERT INTO files (path, language, content_hash, byte_length, indexed_at, workspace, mtime_ms)
         VALUES (?, ?, ?, ?, datetime('now'), ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           language     = COALESCE(excluded.language, files.language),
           content_hash = COALESCE(excluded.content_hash, files.content_hash),
           byte_length  = COALESCE(excluded.byte_length, files.byte_length),
           indexed_at   = datetime('now'),
           workspace    = COALESCE(excluded.workspace, files.workspace),
           mtime_ms     = COALESCE(excluded.mtime_ms, files.mtime_ms)
         RETURNING id`,
      ),
      getFile: db.prepare('SELECT * FROM files WHERE path = ?'),
      getFileById: db.prepare('SELECT * FROM files WHERE id = ?'),
      updateFileHash: db.prepare(
        "UPDATE files SET content_hash = ?, byte_length = ?, mtime_ms = ?, indexed_at = datetime('now') WHERE id = ?",
      ),
      updateFileMtime: db.prepare('UPDATE files SET mtime_ms = ? WHERE id = ?'),
      updateFileStatus: db.prepare(
        'UPDATE files SET status = ?, framework_role = COALESCE(?, framework_role) WHERE id = ?',
      ),
      updateFileGitignored: db.prepare('UPDATE files SET gitignored = ? WHERE id = ?'),
      deleteFileById: db.prepare('DELETE FROM files WHERE id = ?'),
      deleteNodeByTypeAndRef: db.prepare('DELETE FROM nodes WHERE node_type = ? AND ref_id = ?'),
    };
  }

  insertFile(
    path: string,
    language: string | null,
    contentHash: string | null,
    byteLength: number | null,
    workspace: string | null,
    mtimeMs: number | null,
    createNode: (nodeType: string, refId: number) => number,
  ): number {
    const row = this._stmts.insertFile.get(
      path,
      language,
      contentHash,
      byteLength,
      workspace,
      mtimeMs,
    ) as { id: number };
    const fileId = row.id;
    createNode('file', fileId);
    return fileId;
  }

  getFile(path: string): FileRow | undefined {
    return this._stmts.getFile.get(path) as FileRow | undefined;
  }

  getFileById(id: number): FileRow | undefined {
    return this._stmts.getFileById.get(id) as FileRow | undefined;
  }

  getAllFiles(): FileRow[] {
    return this.db.prepare('SELECT * FROM files').all() as FileRow[];
  }

  updateFileWorkspace(fileId: number, workspace: string): void {
    this.db.prepare('UPDATE files SET workspace = ? WHERE id = ?').run(workspace, fileId);
  }

  getFilesByWorkspace(workspace: string): FileRow[] {
    return this.db.prepare('SELECT * FROM files WHERE workspace = ?').all(workspace) as FileRow[];
  }

  updateFileHash(fileId: number, hash: string, byteLength: number, mtimeMs: number | null): void {
    this._stmts.updateFileHash.run(hash, byteLength, mtimeMs, fileId);
  }

  updateFileMtime(fileId: number, mtimeMs: number | null): void {
    this._stmts.updateFileMtime.run(mtimeMs, fileId);
  }

  updateFileStatus(fileId: number, status: string, frameworkRole: string | null): void {
    this._stmts.updateFileStatus.run(status, frameworkRole, fileId);
  }

  updateFileGitignored(fileId: number, gitignored: boolean): void {
    this._stmts.updateFileGitignored.run(gitignored ? 1 : 0, fileId);
  }

  deleteFile(
    fileId: number,
    deleteEdgesForFileNodes: (fileId: number) => void,
    deleteEntitiesByFile: (fileId: number) => void,
  ): void {
    deleteEdgesForFileNodes(fileId);
    deleteEntitiesByFile(fileId);
    this._stmts.deleteNodeByTypeAndRef.run('file', fileId);
    this._stmts.deleteFileById.run(fileId);
  }

  deleteEntitiesByFile(fileId: number): void {
    for (const [table, nodeType] of [
      ['routes', 'route'],
      ['components', 'component'],
      ['migrations', 'migration'],
      ['orm_models', 'orm_model'],
      ['rn_screens', 'rn_screen'],
    ] as const) {
      this.db
        .prepare(
          `DELETE FROM nodes WHERE node_type = ? AND ref_id IN (SELECT id FROM ${table} WHERE file_id = ?)`,
        )
        .run(nodeType, fileId);
      this.db.prepare(`DELETE FROM ${table} WHERE file_id = ?`).run(fileId);
    }
  }

  getFilesByIds(ids: number[]): Map<number, FileRow> {
    const map = new Map<number, FileRow>();
    if (ids.length === 0) return map;
    const CHUNK = 900;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM files WHERE id IN (${placeholders})`)
        .all(...chunk) as FileRow[];
      for (const row of rows) map.set(row.id, row);
    }
    return map;
  }

  getFilesByPaths(paths: string[]): Map<string, FileRow> {
    const map = new Map<string, FileRow>();
    if (paths.length === 0) return map;
    const CHUNK = 900;
    for (let i = 0; i < paths.length; i += CHUNK) {
      const chunk = paths.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM files WHERE path IN (${placeholders})`)
        .all(...chunk) as FileRow[];
      for (const row of rows) map.set(row.path, row);
    }
    return map;
  }

  /**
   * Find every file row whose content_hash matches `hash`. Used by the
   * rename-detection pre-pass: when a "new" path on disk has the same content
   * hash as a known DB row whose old path no longer exists, that's a rename
   * and the existing symbols can be carried over instead of re-extracted.
   * graphify v0.7.0 made this work by removing path from the cache key — we
   * already key by content alone, this helper just exposes the lookup.
   */
  findFilesByContentHash(hash: string): FileRow[] {
    return this.db.prepare('SELECT * FROM files WHERE content_hash = ?').all(hash) as FileRow[];
  }

  /**
   * Atomically update a file row's path. Used for rename detection — we keep
   * the existing fileId so all foreign-key references (symbols, edges, nodes)
   * stay attached. ON CONFLICT(path) on the unique index is impossible by the
   * caller's contract: caller must verify the new path is free first.
   */
  updateFilePath(fileId: number, newPath: string): void {
    this.db
      .prepare("UPDATE files SET path = ?, indexed_at = datetime('now') WHERE id = ?")
      .run(newPath, fileId);
  }
}
