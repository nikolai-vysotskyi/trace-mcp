/**
 * Day-bucketed JSONL audit log for decision-store mutations.
 *
 * Optional, opt-in (`memory.audit_log.enabled`). When enabled, every
 * successful add/update/invalidate is mirrored as a one-line JSON entry
 * to `<dir>/YYYY-MM-DD.jsonl`. The audit write is best-effort and
 * synchronous — wrapped in try/catch inside the store so a failed audit
 * write never affects the SQLite mutation it shadows.
 *
 * Day-rollover is checked on each call (`new Date().toISOString().slice(0,10)`),
 * which keeps the logger stateless apart from the cached file handle / date.
 * Cheap enough to do per-call without booking dedicated rotation logic.
 */

import fs from 'node:fs';
import path from 'node:path';

export type AuditOp = 'add' | 'update' | 'invalidate';

export interface AuditEntry {
  op: AuditOp;
  decision_id: number;
  title?: string;
  type?: string;
  /** ISO timestamp; defaults to `new Date().toISOString()` when omitted. */
  ts?: string;
}

export interface AuditLogger {
  /** Append one entry to today's JSONL file. Throws only on programmer error. */
  log(entry: AuditEntry): void;
  /** No-op for the file-based logger; reserved for future flushable backends. */
  close(): void;
}

export interface CreateAuditLoggerOptions {
  /** Directory the day-bucketed JSONL files are written into. */
  dir: string;
  /**
   * Retention window in days. 0 (default) keeps files forever; any
   * positive N triggers a best-effort prune of files whose YYYY-MM-DD
   * filename is older than N days. Pruning runs once at construction and
   * again on each detected day rollover.
   */
  retentionDays?: number;
}

function todayBucket(now: Date = new Date()): string {
  // toISOString() returns UTC. Day bucketing in UTC keeps log boundaries
  // predictable across timezones and avoids DST jitter.
  return now.toISOString().slice(0, 10);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Best-effort prune of day-bucketed JSONL files older than `days`. Returns
 * the deleted file count. Exported for testing and for callers that want
 * to trigger retention on demand. Never throws — a misconfigured dir or
 * unreadable filename is silently skipped.
 *
 *  - `days <= 0` is a no-op (retention disabled).
 *  - `days` is compared against UTC midnight derived from the
 *    `YYYY-MM-DD.jsonl` filename; sub-day fractions are not honoured.
 *  - Non-matching filenames (anything not `^YYYY-MM-DD\.jsonl$`) are
 *    ignored — we never delete files we didn't write.
 */
export function pruneOlderThan(
  dir: string,
  days: number,
  now: Date = new Date(),
): { deleted: number } {
  if (days <= 0) return { deleted: 0 };
  if (!fs.existsSync(dir)) return { deleted: 0 };
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { deleted: 0 };
  }
  const cutoffMs = now.getTime() - days * DAY_MS;
  let deleted = 0;
  for (const name of entries) {
    const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(name);
    if (!m) continue;
    // UTC midnight of the bucket day. Treat the bucket as expired only
    // when its OWN midnight (start of day) is strictly older than the
    // cutoff — keeps the file alive for the full N-day window.
    const bucketMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (bucketMs >= cutoffMs) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      deleted++;
    } catch {
      // Best-effort — file may have been removed concurrently.
    }
  }
  return { deleted };
}

/**
 * Create a JSONL audit logger rooted at `opts.dir`. The directory is
 * created on first write so a misconfigured path surfaces lazily rather
 * than blowing up the constructor.
 */
export function createAuditLogger(opts: CreateAuditLoggerOptions): AuditLogger {
  const baseDir = opts.dir;
  const retentionDays = Math.max(0, Math.floor(opts.retentionDays ?? 0));
  // Cache only what is cheap to keep — the path string. Re-opening the
  // file per write keeps the code simple and avoids file-handle leaks
  // when the process is killed without close().
  let lastEnsuredDir = '';
  // Track the bucket of the last write so we can detect day rollover and
  // run retention exactly once per day boundary (cheap — string compare).
  let lastBucket = '';

  function ensureDir(): void {
    if (lastEnsuredDir === baseDir) return;
    fs.mkdirSync(baseDir, { recursive: true });
    lastEnsuredDir = baseDir;
  }

  function targetPath(bucket: string): string {
    return path.join(baseDir, `${bucket}.jsonl`);
  }

  function maybePrune(bucket: string): void {
    if (retentionDays <= 0) return;
    if (bucket === lastBucket) return;
    lastBucket = bucket;
    try {
      pruneOlderThan(baseDir, retentionDays);
    } catch {
      // Best-effort — retention must never break the audit write path.
    }
  }

  // Run retention once at construction so a long-idle process that boots
  // up still cleans accumulated files even before the first write.
  if (retentionDays > 0) {
    try {
      pruneOlderThan(baseDir, retentionDays);
    } catch {
      /* best-effort */
    }
  }

  return {
    log(entry: AuditEntry): void {
      const enriched: AuditEntry = {
        ...entry,
        ts: entry.ts ?? new Date().toISOString(),
      };
      ensureDir();
      const bucket = todayBucket();
      maybePrune(bucket);
      // appendFileSync with implicit 'a' flag — atomic short writes on
      // POSIX, and we keep each entry on a single line so a partial
      // failure leaves at most one truncated record.
      fs.appendFileSync(targetPath(bucket), `${JSON.stringify(enriched)}\n`, {
        encoding: 'utf8',
      });
    },
    close(): void {
      // File-based logger has no persistent handle to release.
    },
  };
}
