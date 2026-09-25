/**
 * Cooperative time-slicing for edge-resolution write passes (TRA-1764).
 *
 * Every resolver used to wrap its whole pass in ONE better-sqlite3
 * transaction — fully synchronous on the daemon's only thread. On a large
 * repo a full pass (deferred edge-reconcile, or a >200-file watcher batch
 * that takes the inline full-pass fallback) holds the event loop for
 * seconds: `sample(1)` put 3642/3642 main-thread samples inside
 * `sqlite3_step` while `/health` on the same thread answered nothing for 5 s
 * and the desktop watchdog shot the daemon.
 *
 * `commitInChunks` splits the pass into one transaction per chunk with a
 * fair event-loop yield between chunks, so the longest synchronous span
 * a health check can observe is one chunk, not the whole pass. Chunked
 * commits relax per-pass atomicity — a concurrent reader can observe a
 * half-resolved graph mid-pass — but passes already commit independently
 * with yields between stages (`runInOwnTurn` in `runEdgeResolvers`), so a
 * half-resolved graph is observable today; this only narrows the window to
 * one chunk instead of widening a new one.
 *
 * Sizing: a chunk should stay comfortably under the 1 s health budget on
 * slow disks. Measured per-row cost of an INSERT..ON CONFLICT edge write is
 * ~1 ms, so 250 rows ≈ 250 ms worst case with headroom. Single-statement
 * passes (file projection) chunk by id range instead — see
 * PROJECTION_ID_CHUNK.
 */
import type Database from 'better-sqlite3';
import { logger } from '../logger.js';
import { yieldToEventLoopFair } from '../utils/event-loop.js';

/** Rows committed per transaction by row-loop resolvers. */
export const RESOLVER_WRITE_CHUNK = 250;

/** `edges.id` span covered by one file-projection transaction. */
export const PROJECTION_ID_CHUNK = 2000;

/** Slow-chunk tripwire shared with the file-projection range loop (TRA-1957). */
export const SLOW_RESOLVER_CHUNK_MS = 2000;

/**
 * Run `runChunk` over `items` in slices of `chunkSize`, each slice in its
 * own transaction, yielding to the event loop between slices. No-op (no
 * transaction, no yield) for an empty list; a single slice behaves exactly
 * like the old whole-pass transaction.
 */
export async function commitInChunks<T>(
  db: Database.Database,
  items: readonly T[],
  runChunk: (chunk: T[]) => void,
  chunkSize: number = RESOLVER_WRITE_CHUNK,
): Promise<void> {
  const run = db.transaction((chunk: T[]) => runChunk(chunk));
  const chunkCount = Math.ceil(items.length / chunkSize);
  for (let i = 0; i < items.length; i += chunkSize) {
    if (i > 0) await yieldToEventLoopFair();
    // TRA-1957: never go quiet on a slow chunk — the 3.33.0 wedge was a
    // single synchronous span with no log line for 14+ min.
    const chunkStart = Date.now();
    run(items.slice(i, i + chunkSize));
    const chunkMs = Date.now() - chunkStart;
    if (chunkMs >= SLOW_RESOLVER_CHUNK_MS) {
      logger.warn(
        { chunkIndex: i / chunkSize, chunkCount, chunkMs, chunkSize },
        'Resolver chunk took suspiciously long (TRA-1957)',
      );
    }
  }
}
