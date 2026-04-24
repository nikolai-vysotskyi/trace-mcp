/**
 * SQLite source helper for session providers that back their storage with
 * a SQLite database (Hermes now; Cursor, Warp later — see plan §4.5).
 *
 * Scope:
 *   - Open a foreign DB read-only (`readonly: true, fileMustExist: true`)
 *     so WAL-mode databases owned by another process stay safe.
 *   - Expose a typed `queryRows` helper.
 *   - Encode/decode the `sqlite://<abs-db>?row=<pk>` SessionHandle.sourcePath
 *     convention so upstream tools can round-trip handles without knowing
 *     about SQLite internals.
 *
 * Lazy-loaded: `better-sqlite3` is a direct dep of trace-mcp, but loading it
 * here via `createRequire` keeps the import off the hot path for users who
 * only run JSONL providers.
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';

// Minimal structural types so this file doesn't depend on @types/better-sqlite3
// being resolvable from every consumer. Matches the subset of the API we use.
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
  readonly open: boolean;
}

export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

type BetterSqliteCtor = new (
  filename: string,
  opts: { readonly: boolean; fileMustExist: boolean },
) => SqliteDatabase;

let cachedCtor: BetterSqliteCtor | null = null;

function loadBetterSqlite3(): BetterSqliteCtor {
  if (cachedCtor) return cachedCtor;
  // Use createRequire so better-sqlite3 is resolved relative to this module,
  // not to the process cwd — important when trace-mcp runs via `npx` or inside
  // another project's node_modules.
  const require = createRequire(import.meta.url);
  cachedCtor = require('better-sqlite3') as BetterSqliteCtor;
  return cachedCtor;
}

export interface SqliteSourceOpts {
  /** Path-segment label surfaced in handle.sourcePath (e.g. "hermes"). */
  label: string;
}

/**
 * Read-only connection to an external SQLite DB.
 *
 * Intentionally thin: providers that need richer SQL compose their queries at
 * the call site. Centralising here would mean leaking provider schema details
 * into a shared layer that has no business knowing them.
 */
export class SqliteSource {
  private db: SqliteDatabase | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly opts: SqliteSourceOpts,
  ) {}

  open(): void {
    if (this.db?.open) return;
    const Ctor = loadBetterSqlite3();
    this.db = new Ctor(this.dbPath, { readonly: true, fileMustExist: true });
  }

  close(): void {
    if (this.db?.open) this.db.close();
    this.db = null;
  }

  get isOpen(): boolean {
    return this.db?.open === true;
  }

  queryRows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    if (!this.db?.open) throw new Error('SqliteSource not open — call open() first.');
    return this.db.prepare(sql).all(...params) as T[];
  }

  queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    if (!this.db?.open) throw new Error('SqliteSource not open — call open() first.');
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  /** Absolute path to the DB file (as passed in). */
  get path(): string {
    return this.dbPath;
  }

  /** Build the canonical `sqlite://<abs-db-path>?row=<pk>` handle sourcePath.
   * Plan §4.5. */
  buildSourcePath(rowId: string | number): string {
    const abs = path.resolve(this.dbPath);
    return `sqlite://${abs}?row=${encodeURIComponent(String(rowId))}&via=${encodeURIComponent(this.opts.label)}`;
  }
}

/** Parse a `sqlite://...?row=<pk>&via=<label>` sourcePath back to its parts. */
export function parseSqliteSourcePath(
  sourcePath: string,
): { dbPath: string; row: string; label?: string } | null {
  if (!sourcePath.startsWith('sqlite://')) return null;
  const rest = sourcePath.slice('sqlite://'.length);
  const qIdx = rest.indexOf('?');
  if (qIdx < 0) return null;
  const dbPath = rest.slice(0, qIdx);
  const params = new URLSearchParams(rest.slice(qIdx + 1));
  const row = params.get('row');
  if (!row) return null;
  const label = params.get('via') ?? undefined;
  return { dbPath, row, label };
}
