/**
 * Indexing progress tracking.
 * Shared mutable state object — pipelines write, MCP tools + CLI read.
 * Progress is also persisted to SQLite for cross-process access (CLI `status` command).
 */
import type Database from 'better-sqlite3';
import { logger } from './logger.js';

export type PipelinePhase = 'idle' | 'running' | 'completed' | 'skipped' | 'error';
export type PipelineName = 'indexing' | 'summarization' | 'embedding';

export interface PipelineProgress {
  phase: PipelinePhase;
  processed: number;
  total: number;
  startedAt: number; // epoch ms, 0 if idle
  completedAt: number; // epoch ms, 0 if not done
  error?: string;
  /**
   * What the run covered: 'full' = the whole project tree was walked,
   * 'incremental' = only the files a watcher/hook/register_edit call handed
   * in. Without this, `phase: 'completed'` after a 3-file watcher batch reads
   * as "the project is fully indexed" (TRA-184 / TRA-231). Not persisted —
   * it describes the live run, and is absent after a daemon restart.
   */
  scope?: 'full' | 'incremental';
}

export interface PipelineProgressSnapshot extends PipelineProgress {
  percentage: number | null;
  elapsedMs: number;
}

export interface ProgressSnapshot {
  indexing: PipelineProgressSnapshot;
  summarization: PipelineProgressSnapshot;
  embedding: PipelineProgressSnapshot;
}

function idleProgress(): PipelineProgress {
  return { phase: 'idle', processed: 0, total: 0, startedAt: 0, completedAt: 0 };
}

function snapOne(p: PipelineProgress): PipelineProgressSnapshot {
  const now = Date.now();
  const endTime = p.completedAt > 0 ? p.completedAt : now;
  // Normalize legacy "completed with 0 of N" rows that older producers wrote
  // when the embedding/summarization pipeline was disabled mid-flight (e.g.
  // provider removed). Mathematically a 0% completion isn't a completion —
  // surface it as "skipped" so consumers don't show a misleading green tick.
  const effectivePhase: PipelinePhase =
    p.phase === 'completed' && p.total > 0 && p.processed === 0 ? 'skipped' : p.phase;
  return {
    ...p,
    phase: effectivePhase,
    percentage: p.total > 0 ? Math.round((p.processed / p.total) * 100) : null,
    elapsedMs: p.startedAt > 0 ? endTime - p.startedAt : 0,
  };
}

export type ProgressListener = (name: PipelineName, progress: PipelineProgress) => void;

export class ProgressState {
  indexing: PipelineProgress = idleProgress();
  summarization: PipelineProgress = idleProgress();
  embedding: PipelineProgress = idleProgress();

  private db: Database.Database | null;
  private listeners: ProgressListener[] = [];

  constructor(db?: Database.Database) {
    this.db = db ?? null;
    if (this.db) {
      this.loadFromDb();
    }
  }

  /** Register a callback for progress updates. Returns unsubscribe function. */
  onUpdate(listener: ProgressListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  update(name: PipelineName, partial: Partial<PipelineProgress>): void {
    const current = this[name];
    Object.assign(current, partial);
    this.persist(name);

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(name, { ...current });
      } catch {
        /* ignore */
      }
    }

    // Log progress on phase changes and periodically during running
    if (partial.phase === 'running' && partial.total !== undefined) {
      logger.info(
        { pipeline: name, total: current.total },
        '%s started: %d items to process',
        name,
        current.total,
      );
    } else if (partial.phase === 'completed') {
      const elapsed =
        current.completedAt > 0 && current.startedAt > 0
          ? Math.round((current.completedAt - current.startedAt) / 1000)
          : 0;
      // "completed: 0 items" for a non-empty queue is byte-for-byte the shape of
      // "there was nothing to do" — which is how a two-day embedding outage read
      // as 44 successful runs at info level (TRA-812). snapshot() already
      // downgrades this to 'skipped'; the log line has to say it too.
      if (current.total > 0 && current.processed === 0) {
        logger.warn(
          { pipeline: name, total: current.total, elapsed },
          '%s finished without processing any of %d queued items',
          name,
          current.total,
        );
      } else {
        logger.info(
          { pipeline: name, processed: current.processed, elapsed },
          '%s completed: %d items in %ds',
          name,
          current.processed,
          elapsed,
        );
      }
    } else if (partial.phase === 'error') {
      logger.error({ pipeline: name, error: current.error }, '%s failed: %s', name, current.error);
    } else if (partial.processed !== undefined && current.total > 0) {
      const pct = Math.round((current.processed / current.total) * 100);
      // Debug, not info: these ticks were 42% of the 39 MB of daemon.log
      // measured in TRA-543, which is what made the interesting lines
      // unfindable. The live view reads `snapshot()` / the SSE progress feed,
      // not the log; start and completion stay at info.
      logger.debug(
        { pipeline: name, processed: current.processed, total: current.total, pct },
        '%s progress: %d/%d (%d%%)',
        name,
        current.processed,
        current.total,
        pct,
      );
    }
  }

  snapshot(): ProgressSnapshot {
    return {
      indexing: snapOne(this.indexing),
      summarization: snapOne(this.summarization),
      embedding: snapOne(this.embedding),
    };
  }

  private persist(name: PipelineName): void {
    if (!this.db) return;
    const p = this[name];
    try {
      this.db
        .prepare(`
        INSERT OR REPLACE INTO indexing_progress
          (pipeline, phase, processed, total, started_at, completed_at, error, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          name,
          p.phase,
          p.processed,
          p.total,
          p.startedAt,
          p.completedAt,
          p.error ?? null,
          Date.now(),
        );
    } catch (e) {
      logger.debug({ error: e }, 'Failed to persist progress');
    }
  }

  private loadFromDb(): void {
    if (!this.db) return;
    try {
      const rows = this.db.prepare('SELECT * FROM indexing_progress').all() as {
        pipeline: PipelineName;
        phase: PipelinePhase;
        processed: number;
        total: number;
        started_at: number;
        completed_at: number;
        error: string | null;
      }[];
      for (const row of rows) {
        if (row.pipeline in this) {
          this[row.pipeline] = {
            phase: row.phase,
            processed: row.processed,
            total: row.total,
            startedAt: row.started_at,
            completedAt: row.completed_at,
            error: row.error ?? undefined,
          };
        }
      }
    } catch {
      // Table may not exist yet (pre-migration) — ignore
    }
  }
}

/**
 * Read progress from DB without an in-memory ProgressState.
 * Used by CLI `status` command which opens DB read-only.
 */
export function readProgressFromDb(db: Database.Database): ProgressSnapshot | null {
  try {
    const rows = db.prepare('SELECT * FROM indexing_progress').all() as {
      pipeline: PipelineName;
      phase: PipelinePhase;
      processed: number;
      total: number;
      started_at: number;
      completed_at: number;
      error: string | null;
      updated_at: number;
    }[];

    if (rows.length === 0) return null;

    const map = new Map(rows.map((r) => [r.pipeline, r]));
    const toProgress = (name: PipelineName): PipelineProgress => {
      const r = map.get(name);
      if (!r) return idleProgress();
      return {
        phase: r.phase,
        processed: r.processed,
        total: r.total,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        error: r.error ?? undefined,
      };
    };

    return {
      indexing: snapOne(toProgress('indexing')),
      summarization: snapOne(toProgress('summarization')),
      embedding: snapOne(toProgress('embedding')),
    };
  } catch {
    return null;
  }
}

// ── Server state (PID tracking) ──────────────────────────────────

export function writeServerPid(db: Database.Database): void {
  try {
    db.prepare(`INSERT OR REPLACE INTO server_state (key, value) VALUES ('pid', ?)`).run(
      String(process.pid),
    );
    db.prepare(`INSERT OR REPLACE INTO server_state (key, value) VALUES ('started_at', ?)`).run(
      new Date().toISOString(),
    );
  } catch {
    // Table may not exist yet (pre-migration-18 DB)
  }
}

export function clearServerPid(db: Database.Database): void {
  try {
    db.prepare(`DELETE FROM server_state WHERE key IN ('pid', 'started_at')`).run();
  } catch {
    // Table may not exist
  }
}

function readServerPid(db: Database.Database): { pid: number; startedAt: string } | null {
  try {
    const pidRow = db.prepare(`SELECT value FROM server_state WHERE key = 'pid'`).get() as
      | { value: string }
      | undefined;
    const startedRow = db
      .prepare(`SELECT value FROM server_state WHERE key = 'started_at'`)
      .get() as { value: string } | undefined;
    if (!pidRow) return null;
    return { pid: Number(pidRow.value), startedAt: startedRow?.value ?? 'unknown' };
  } catch {
    return null;
  }
}

export function isServerRunning(db: Database.Database): boolean {
  const state = readServerPid(db);
  if (!state) return false;
  try {
    process.kill(state.pid, 0); // signal 0 = check if process exists
    return true;
  } catch {
    return false;
  }
}
