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
