// In-memory accumulator for `reindex-file` telemetry events. Surfaces a
// summary the daemon can serve via /api/stats and `daemon stats` can render.

export interface ReindexEvent {
  ts: number;
  pathSource: 'http' | 'mcp' | 'watcher';
  skippedRecent: boolean;
  skippedHash: boolean;
  indexed: number;
  /** Indexing work only. See `queuedMs` — the two used to be summed here,
   *  which is how a 30 ms reindex reported hours of latency (TRA-935). */
  elapsedMs: number;
  /** Time the call spent waiting for the reindex lock before work began. */
  queuedMs?: number;
  error?: boolean;
}

export interface ReindexStatsSummary {
  total: number;
  fast_skipped_recent: number;
  fast_skipped_hash: number;
  indexed: number;
  errors: number;
  p50_ms: number;
  p95_ms: number;
  /** p95 of lock-queue wait. A high value here with a low `p95_ms` means the
   *  reindexes are fast and the queue in front of them is not. */
  p95_queued_ms: number;
}

const MAX_RING = 5000;

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

export class ReindexStats {
  private ring: ReindexEvent[] = [];
  private head = 0;
  private size = 0;

  record(event: Omit<ReindexEvent, 'ts'> & { ts?: number }): void {
    const ev: ReindexEvent = {
      ts: event.ts ?? Date.now(),
      pathSource: event.pathSource,
      skippedRecent: event.skippedRecent,
      skippedHash: event.skippedHash,
      indexed: event.indexed,
      elapsedMs: event.elapsedMs,
      queuedMs: event.queuedMs,
      error: event.error,
    };
    if (this.size < MAX_RING) {
      this.ring.push(ev);
      this.size++;
    } else {
      this.ring[this.head] = ev;
      this.head = (this.head + 1) % MAX_RING;
    }
  }

  snapshot(): ReindexEvent[] {
    return this.ring.slice();
  }

  summarize(sinceMs?: number): ReindexStatsSummary {
    // WHY sinceMs as a window length (not absolute ts): the /api/stats endpoint
    // accepts `?since=1h` which parseDuration() returns as a relative window —
    // matches the daemon-stats CLI semantics.
    const events = this.snapshot();
    const cutoff = sinceMs != null && sinceMs > 0 ? Date.now() - sinceMs : null;
    let recent = 0;
    let hash = 0;
    let indexed = 0;
    let errors = 0;
    const elapsed: number[] = [];
    const queued: number[] = [];
    let total = 0;
    for (const e of events) {
      if (cutoff != null && e.ts < cutoff) continue;
      total++;
      if (e.error) errors++;
      else if (e.skippedRecent) recent++;
      else if (e.skippedHash) hash++;
      else if (e.indexed > 0) indexed++;
      elapsed.push(e.elapsedMs);
      queued.push(e.queuedMs ?? 0);
    }
    const sorted = [...elapsed].sort((a, b) => a - b);
    const sortedQueued = [...queued].sort((a, b) => a - b);
    return {
      total,
      fast_skipped_recent: recent,
      fast_skipped_hash: hash,
      indexed,
      errors,
      p50_ms: percentile(sorted, 0.5),
      p95_ms: percentile(sorted, 0.95),
      p95_queued_ms: percentile(sortedQueued, 0.95),
    };
  }

  reset(): void {
    this.ring = [];
    this.head = 0;
    this.size = 0;
  }
}

let _global: ReindexStats | null = null;

export function getReindexStats(): ReindexStats {
  if (!_global) _global = new ReindexStats();
  return _global;
}

export function __resetReindexStatsForTests(): void {
  _global = null;
}
