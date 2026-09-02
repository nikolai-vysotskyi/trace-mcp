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

  /**
   * Read-side lookup: exact path, else a *unique* suffix match.
   *
   * Agents run with cwd inside a subdirectory of the indexed root (a Laravel app
   * under a monorepo, a checkout under a workspace dir) and pass paths relative
   * to that cwd. Exact matching then misses a file the index actually holds, and
   * the agent burns a round-trip on NOT_FOUND plus another on the search() it
   * falls back to. Only an unambiguous match is accepted — two candidates mean
   * we cannot know which one was meant, so it stays a miss.
   *
   * Never use this on the indexer write path: inserts must stay exact.
   */
  resolveFile(path: string): FileRow | undefined {
    const exact = this._stmts.getFile.get(path) as FileRow | undefined;
    if (exact) return exact;
    const normalized = path.replace(/^\.?\//, '');
    if (!normalized) return undefined;
    const rows = this.db
      .prepare('SELECT * FROM files WHERE path = ? OR path LIKE ? ESCAPE ? LIMIT 2')
      .all(normalized, `%/${normalized.replace(/([%_\\])/g, '\\$1')}`, '\\') as FileRow[];
    return rows.length === 1 ? rows[0] : undefined;
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
    // Associations in OTHER files can point at this file's models via
    // target_model_id, which has no ON DELETE clause — deleting the models
    // below would hit a FOREIGN KEY violation and abort the whole indexing
    // run. Unresolve those pointers instead; target_model_name survives, so
    // the next resolve pass can re-link them.
    this.db
      .prepare(
        `UPDATE orm_associations SET target_model_id = NULL
         WHERE target_model_id IN (SELECT id FROM orm_models WHERE file_id = ?)`,
      )
      .run(fileId);

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
