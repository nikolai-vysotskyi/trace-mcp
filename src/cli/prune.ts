/**
 * `trace-mcp prune` command.
 *
 * Scans `~/.trace-mcp/index/` and classifies every `.db` file as one of:
 *   - live                  → project root still registered AND directory exists
 *   - orphan_missing_root   → project root no longer on disk
 *   - orphan_unregistered   → DB exists but root isn't in registry (non-session)
 *   - session_active        → session DB younger than --session-ttl-days
 *   - session_expired       → session DB older than the TTL
 *   - stray_small           → tiny (<5 indexed files) + cold (>30d) project DB
 *
 * `trace-mcp prune` is dry-run by default. Pass `--apply` to delete; pass
 * `--aggressive` to additionally drop `stray_small` candidates.
 *
 * Also exposed programmatically as {@link pruneIndexDir} so the daemon can
 * run a quiet `session_expired`-only sweep at startup.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import Database from 'better-sqlite3';
import { Command } from 'commander';
import { ensureGlobalDirs, projectHash, projectName } from '../global.js';
import { logger } from '../logger.js';
import { listProjects } from '../registry.js';
import { INDEX_DIR } from '../shared/paths.js';

/** Categories assigned to each DB candidate. */
export type PruneCategory =
  | 'live'
  | 'orphan_missing_root'
  | 'orphan_unregistered'
  | 'session_active'
  | 'session_expired'
  | 'stray_small';

export interface DbCandidate {
  /** Absolute path of the base `.db` file (no -wal/-shm suffix). */
  path: string;
  /** Base filename, e.g. `myproj-abc123def456.db`. */
  basename: string;
  /** Total bytes for the DB + its SQLite sidecars (-wal/-shm/-journal). */
  bytes: number;
  /** mtime of the base file in epoch ms. */
  mtimeMs: number;
  /** Category assigned to this DB. */
  category: PruneCategory;
  /** Hash chunk extracted from the filename, when one was found. */
  hash: string | null;
  /** Project root the registry claims this hash maps to (if any). */
  registeredRoot: string | null;
}

export interface PruneOptions {
  /** Maximum age (in days) before a session DB is considered expired. */
  sessionTtlDays?: number;
  /** When false (default), don't unlink anything — only classify. */
  apply?: boolean;
  /** When true (+ apply), also drop stray_small candidates. */
  aggressive?: boolean;
  /** Categories to act on when apply=true.
   *  When set, restricts deletion to this set. */
  onlyCategories?: PruneCategory[];
}

export interface PruneSummary {
  candidates: DbCandidate[];
  /** Per-category totals — counts AND bytes. */
  totals: Record<PruneCategory, { count: number; bytes: number }>;
  /** Files actually deleted (empty when apply=false). */
  deleted: string[];
  /** Total bytes freed by this run. */
  freedBytes: number;
}

const DEFAULT_SESSION_TTL_DAYS = 7;
const STRAY_SMALL_MIN_FILES = 5;
const STRAY_SMALL_MIN_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const SQLITE_SIDECARS = ['', '-wal', '-shm', '-journal'] as const;

function emptyTotals(): Record<PruneCategory, { count: number; bytes: number }> {
  return {
    live: { count: 0, bytes: 0 },
    orphan_missing_root: { count: 0, bytes: 0 },
    orphan_unregistered: { count: 0, bytes: 0 },
    session_active: { count: 0, bytes: 0 },
    session_expired: { count: 0, bytes: 0 },
    stray_small: { count: 0, bytes: 0 },
  };
}

function totalBytesWithSidecars(basePath: string): { bytes: number; mtimeMs: number } {
  let bytes = 0;
  let mtimeMs = 0;
  for (const suffix of SQLITE_SIDECARS) {
    try {
      const stat = fs.statSync(basePath + suffix);
      bytes += stat.size;
      if (suffix === '') mtimeMs = stat.mtimeMs;
    } catch {
      /* missing sidecar — fine */
    }
  }
  return { bytes, mtimeMs };
}

/** Pull the trailing 12-char hex hash out of `<name>-<hash>.db` (or session form). */
function extractHash(basename: string): string | null {
  // Session form: `<name>-<hash>-session-<sessionId>.db`
  const sessionMatch = basename.match(/^(.+)-([0-9a-f]{12})-session-[0-9a-f-]+\.db$/i);
  if (sessionMatch) return sessionMatch[2].toLowerCase();
  // Task-cache form: `daemon-task-cache-<sessionId>-<hash>.db`
  const taskMatch = basename.match(/^daemon-task-cache-[0-9a-f-]+-([0-9a-f]{12})\.db$/i);
  if (taskMatch) return taskMatch[1].toLowerCase();
  // Plain project form: `<name>-<hash>.db`
  const plainMatch = basename.match(/^(.+)-([0-9a-f]{12})\.db$/i);
  if (plainMatch) return plainMatch[2].toLowerCase();
  return null;
}

function isSessionFile(basename: string): boolean {
  return /-session-[0-9a-f-]+\.db$/i.test(basename) || basename.startsWith('daemon-task-cache-');
}

/** Count files+symbols in a project DB. Returns nulls if the DB can't be opened. */
function inspectProjectDb(dbPath: string): { files: number | null } {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      // Schema may not have a `files` table on older DBs — fall back to 0.
      try {
        const row = db.prepare('SELECT COUNT(*) AS n FROM files').get() as
          | { n: number }
          | undefined;
        return { files: row?.n ?? 0 };
      } catch {
        return { files: 0 };
      }
    } finally {
      db.close();
    }
  } catch {
    return { files: null };
  }
}

interface RegistryHashIndex {
  /** Map from projectHash → { root, exists }. */
  byHash: Map<string, { root: string; exists: boolean }>;
}

function buildRegistryIndex(): RegistryHashIndex {
  const byHash = new Map<string, { root: string; exists: boolean }>();
  for (const entry of listProjects()) {
    const absRoot = path.resolve(entry.root);
    byHash.set(projectHash(absRoot), {
      root: absRoot,
      exists: fs.existsSync(absRoot),
    });
    // Multi-root: children also count as live anchors.
    if (entry.children) {
      for (const child of entry.children) {
        const abs = path.resolve(child);
        byHash.set(projectHash(abs), { root: abs, exists: fs.existsSync(abs) });
      }
    }
    // Don't forget the entry-level `dbPath` hash — names in registry can drift,
    // but the DB the registry points at is canonical. We index by the basename
    // pattern instead of `name-hash`.
  }
  return { byHash };
}

/** Classify every DB file under INDEX_DIR. */
export function scanIndexDir(options: PruneOptions = {}): DbCandidate[] {
  const ttlDays = options.sessionTtlDays ?? DEFAULT_SESSION_TTL_DAYS;
  const now = Date.now();
  const ttlCutoff = now - ttlDays * DAY_MS;
  const strayCutoff = now - STRAY_SMALL_MIN_AGE_DAYS * DAY_MS;

  let files: string[];
  try {
    files = fs.readdirSync(INDEX_DIR);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn({ err }, 'prune: failed to list INDEX_DIR');
    }
    return [];
  }

  const registry = buildRegistryIndex();
  const candidates: DbCandidate[] = [];

  for (const file of files) {
    // Skip sidecars — we walk each base DB once and aggregate companions.
    if (/(-wal|-shm|-journal)$/.test(file)) continue;
    if (!file.endsWith('.db')) continue;

    const full = path.join(INDEX_DIR, file);
    const { bytes, mtimeMs } = totalBytesWithSidecars(full);
    const hash = extractHash(file);
    const session = isSessionFile(file);

    let category: PruneCategory;
    let registeredRoot: string | null = null;
    const registered = hash ? registry.byHash.get(hash) : undefined;
    if (registered) registeredRoot = registered.root;

    if (session) {
      category = mtimeMs < ttlCutoff ? 'session_expired' : 'session_active';
    } else if (!registered) {
      category = 'orphan_unregistered';
    } else if (!registered.exists) {
      category = 'orphan_missing_root';
    } else {
      // Live project — check stray_small heuristic for very small + old DBs.
      // We only flag stray when the user actually opts into aggressive mode;
      // classification still happens so dry-run output shows them.
      const ageOk = mtimeMs > 0 && mtimeMs < strayCutoff;
      let strayCandidate = false;
      if (ageOk) {
        const insp = inspectProjectDb(full);
        if (insp.files !== null && insp.files < STRAY_SMALL_MIN_FILES) {
          strayCandidate = true;
        }
      }
      category = strayCandidate ? 'stray_small' : 'live';
    }

    candidates.push({
      path: full,
      basename: file,
      bytes,
      mtimeMs,
      category,
      hash,
      registeredRoot,
    });
  }

  return candidates;
}

/** Delete a base DB + its sidecars, swallowing ENOENT. */
function unlinkDb(basePath: string): { deleted: string[]; bytes: number } {
  const deleted: string[] = [];
  let bytes = 0;
  for (const suffix of SQLITE_SIDECARS) {
    const full = basePath + suffix;
    try {
      const stat = fs.statSync(full);
      fs.unlinkSync(full);
      deleted.push(full);
      bytes += stat.size;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn({ err, file: full }, 'prune: unlink failed');
      }
    }
  }
  return { deleted, bytes };
}

/** Run the full prune algorithm. Idempotent. */
export function pruneIndexDir(options: PruneOptions = {}): PruneSummary {
  ensureGlobalDirs();

  const candidates = scanIndexDir(options);
  const totals = emptyTotals();
  for (const c of candidates) {
    totals[c.category].count += 1;
    totals[c.category].bytes += c.bytes;
  }

  const summary: PruneSummary = {
    candidates,
    totals,
    deleted: [],
    freedBytes: 0,
  };

  if (!options.apply) return summary;

  const defaultDeletable: PruneCategory[] = [
    'orphan_missing_root',
    'orphan_unregistered',
    'session_expired',
  ];
  const allowed = new Set<PruneCategory>(options.onlyCategories ?? defaultDeletable);
  if (options.aggressive && !options.onlyCategories) {
    allowed.add('stray_small');
  }

  for (const c of candidates) {
    if (!allowed.has(c.category)) continue;
    const { deleted, bytes } = unlinkDb(c.path);
    summary.deleted.push(...deleted);
    summary.freedBytes += bytes;
  }

  return summary;
}

/** Self-check: walking projectHash + projectName here matches what indexer uses. */
function shortPath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const CATEGORY_ORDER: PruneCategory[] = [
  'live',
  'session_active',
  'session_expired',
  'orphan_missing_root',
  'orphan_unregistered',
  'stray_small',
];

const CATEGORY_DESCRIPTIONS: Record<PruneCategory, string> = {
  live: 'live (project still registered and directory exists)',
  session_active: 'session_active (younger than TTL)',
  session_expired: 'session_expired (older than TTL — would delete)',
  orphan_missing_root: 'orphan_missing_root (project root deleted — would delete)',
  orphan_unregistered: 'orphan_unregistered (DB exists, not in registry — would delete)',
  stray_small: 'stray_small (tiny + cold — would delete with --aggressive)',
};

function printSummary(
  summary: PruneSummary,
  opts: { apply: boolean; aggressive: boolean; sessionTtlDays: number },
): void {
  const lines: string[] = [];
  lines.push(`Index dir: ${shortPath(INDEX_DIR)}`);
  lines.push(`Total candidates: ${summary.candidates.length}`);
  lines.push(`Session TTL: ${opts.sessionTtlDays} day(s)`);
  lines.push('');
  for (const cat of CATEGORY_ORDER) {
    const t = summary.totals[cat];
    if (t.count === 0) continue;
    lines.push(
      `  ${cat.padEnd(22)} ${String(t.count).padStart(4)}  ${fmtBytes(t.bytes)}  ${CATEGORY_DESCRIPTIONS[cat]}`,
    );
  }
  if (opts.apply) {
    lines.push('');
    lines.push(`Deleted ${summary.deleted.length} file(s), freed ${fmtBytes(summary.freedBytes)}`);
  }
  p.note(lines.join('\n'), opts.apply ? 'prune (applied)' : 'prune (dry-run)');
}

/** Format the summary as JSON for `--json`. */
function toJson(
  summary: PruneSummary,
  opts: { apply: boolean; aggressive: boolean; sessionTtlDays: number },
): unknown {
  const totals: Record<string, { count: number; bytes: number }> = {};
  for (const cat of CATEGORY_ORDER) {
    totals[cat] = summary.totals[cat];
  }
  return {
    indexDir: INDEX_DIR,
    apply: opts.apply,
    aggressive: opts.aggressive,
    sessionTtlDays: opts.sessionTtlDays,
    candidates: summary.candidates.map((c) => ({
      path: c.path,
      basename: c.basename,
      bytes: c.bytes,
      mtimeMs: c.mtimeMs,
      category: c.category,
      hash: c.hash,
      registeredRoot: c.registeredRoot,
    })),
    totals,
    deleted: summary.deleted,
    freedBytes: summary.freedBytes,
  };
}

export const pruneCommand = new Command('prune')
  .description(
    'Audit ~/.trace-mcp/index for orphan/expired DBs (dry-run by default; use --apply to delete)',
  )
  .option('--apply', 'Actually delete orphan + expired session DBs')
  .option('--aggressive', 'Also delete stray small (<5 files) DBs older than 30 days')
  .option('--session-ttl-days <n>', 'Session DB TTL in days (default 7)', '7')
  .option('--json', 'Emit JSON instead of a human report')
  .action(
    async (opts: {
      apply?: boolean;
      aggressive?: boolean;
      sessionTtlDays?: string;
      json?: boolean;
    }) => {
      const sessionTtlDays = Math.max(0, parseInt(opts.sessionTtlDays ?? '7', 10) || 7);
      const apply = !!opts.apply;
      const aggressive = !!opts.aggressive;

      if (!opts.json) p.intro('trace-mcp prune');

      const summary = pruneIndexDir({ apply, aggressive, sessionTtlDays });

      if (opts.json) {
        console.log(
          JSON.stringify(toJson(summary, { apply, aggressive, sessionTtlDays }), null, 2),
        );
        return;
      }

      printSummary(summary, { apply, aggressive, sessionTtlDays });
      if (!apply) {
        p.outro('Dry-run only — re-run with --apply to delete.');
      } else {
        p.outro('Prune complete.');
      }
    },
  );

// Re-export the indexer name helpers so daemon code can build canonical paths
// without circling through here. Keeps `INDEX_DIR + name + hash` agreement.
export { projectHash, projectName };
