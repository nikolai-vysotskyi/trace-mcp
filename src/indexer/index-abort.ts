/**
 * Cooperative indexing cancellation (TRA-1017).
 *
 * Lives in its own leaf module so both `pipeline.ts` and
 * `extract-and-persist.ts` can use it without a circular import (the latter
 * was deliberately decoupled from the former — see its header comment).
 *
 * Cancellation is cooperative: the signal is checked at batch and phase
 * boundaries, so a run always stops *between* persist transactions, never
 * inside one. The index is left in its last consistent state and the next
 * run resumes where the aborted one stopped (every batch after the change
 * prefilter is content-hash gated).
 */

/**
 * Thrown when an indexing run observes its `AbortSignal` at a phase/batch
 * boundary and stops early.
 *
 * This is not a failure: callers shutting the project down must not record
 * it as an indexing error. A dedicated class — rather than the DOM
 * `AbortError` from `signal.throwIfAborted()` — keeps that distinction
 * greppable and lets callers distinguish "asked to stop" from real failures
 * without matching on message text.
 */
export class IndexAbortedError extends Error {
  constructor(rootPath = '') {
    super(rootPath ? `Indexing aborted for ${rootPath}` : 'Indexing aborted');
    this.name = 'IndexAbortedError';
  }
}

/** Throw `IndexAbortedError` when `signal` has been aborted (no-op without one). */
export function throwIfIndexAborted(signal?: AbortSignal, rootPath = ''): void {
  if (signal?.aborted) throw new IndexAbortedError(rootPath);
}

/**
 * What a repair run owes a dirty path (TRA-1017).
 *
 * - `repair`: the file may still need its edges rebuilt — force-extract it.
 *   Returned both when it looks fine (the hash gate cannot be trusted for
 *   dirty files) and when access failed: an unreadable file errors out of
 *   the repair extract, and the errors gate retains the marker.
 * - `retire-row`: the path is confirmed gone (or was never a file) — its
 *   stored row is reconciled away and the obligation retires with it.
 */
export type RepairPathDisposition = 'repair' | 'retire-row';

/**
 * Classify one dirty path from a stat attempt (TRA-1017). Pure — unit-tested
 * directly; the pipeline supplies the stat outcome.
 *
 * `existsSync` is the wrong primitive here: it conflates "deleted" with
 * "inaccessible" (both false). An inaccessible file must be RETAINED — its
 * row is stale and only a successful re-extract repairs it — while a deleted
 * one must be RECONCILED, or the deferred path (which never reconciles
 * scope) would clear the marker with the stale row still stored.
 */
export function classifyRepairStat(
  stat: { ok: true; isFile: boolean } | { ok: false; code?: string },
): RepairPathDisposition {
  if (!stat.ok) {
    return stat.code === 'ENOENT' || stat.code === 'ENOTDIR' ? 'retire-row' : 'repair';
  }
  return stat.isFile ? 'repair' : 'retire-row';
}
