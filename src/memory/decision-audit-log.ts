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
}

function todayBucket(now: Date = new Date()): string {
  // toISOString() returns UTC. Day bucketing in UTC keeps log boundaries
  // predictable across timezones and avoids DST jitter.
  return now.toISOString().slice(0, 10);
}

/**
 * Create a JSONL audit logger rooted at `opts.dir`. The directory is
 * created on first write so a misconfigured path surfaces lazily rather
 * than blowing up the constructor.
 */
export function createAuditLogger(opts: CreateAuditLoggerOptions): AuditLogger {
  const baseDir = opts.dir;
  // Cache only what is cheap to keep — the path string. Re-opening the
  // file per write keeps the code simple and avoids file-handle leaks
  // when the process is killed without close().
  let lastEnsuredDir = '';

  function ensureDir(): void {
    if (lastEnsuredDir === baseDir) return;
    fs.mkdirSync(baseDir, { recursive: true });
    lastEnsuredDir = baseDir;
  }

  function targetPath(): string {
    return path.join(baseDir, `${todayBucket()}.jsonl`);
  }

  return {
    log(entry: AuditEntry): void {
      const enriched: AuditEntry = {
        ...entry,
        ts: entry.ts ?? new Date().toISOString(),
      };
      ensureDir();
      // appendFileSync with implicit 'a' flag — atomic short writes on
      // POSIX, and we keep each entry on a single line so a partial
      // failure leaves at most one truncated record.
      fs.appendFileSync(targetPath(), `${JSON.stringify(enriched)}\n`, {
        encoding: 'utf8',
      });
    },
    close(): void {
      // File-based logger has no persistent handle to release.
    },
  };
}
