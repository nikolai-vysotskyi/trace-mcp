import type Database from 'better-sqlite3';
import type { FileRow } from '../types.js';

export class FileRepository {
  private readonly _stmts: {
    insertFile: Database.Statement;
    getFile: Database.Statement;
    getFileById: Database.Statement;
    updateFileHash: Database.Statement;
    updateFileStatus: Database.Statement;
    updateFileGitignored: Database.Statement;
    deleteFileById: Database.Statement;
    deleteNodeByTypeAndRef: Database.Statement;
  };

  constructor(private readonly db: Database.Database) {
    this._stmts = {
      insertFile: db.prepare(
        `INSERT INTO files (path, language, content_hash, byte_length, indexed_at, workspace, mtime_ms)
         VALUES (?, ?, ?, ?, datetime('now'), ?, ?)`,
      ),
      getFile: db.prepare('SELECT * FROM files WHERE path = ?'),
      getFileById: db.prepare('SELECT * FROM files WHERE id = ?'),
      updateFileHash: db.prepare(
        "UPDATE files SET content_hash = ?, byte_length = ?, mtime_ms = ?, indexed_at = datetime('now') WHERE id = ?",
      ),
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
    const result = this._stmts.insertFile.run(path, language, contentHash, byteLength, workspace, mtimeMs);
    const fileId = Number(result.lastInsertRowid);
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
      this.db.prepare(
        `DELETE FROM nodes WHERE node_type = ? AND ref_id IN (SELECT id FROM ${table} WHERE file_id = ?)`,
      ).run(nodeType, fileId);
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
      const rows = this.db.prepare(
        `SELECT * FROM files WHERE id IN (${placeholders})`,
      ).all(...chunk) as FileRow[];
      for (const row of rows) map.set(row.id, row);
    }
    return map;
  }
}
