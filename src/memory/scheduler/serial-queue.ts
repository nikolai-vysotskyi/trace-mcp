/**
 * SerialQueue — minimal FIFO with concurrency=1.
 *
 * Each enqueued task runs to completion before the next one starts. A task
 * that throws is surfaced via its own returned promise; the queue stays
 * alive and proceeds to the next task. Designed for sequencing background
 * work that must not race (LLM stampedes, embedding bursts, SQLite write
 * contention).
 *
 * Generic over `T` so the caller's task result type is preserved on the
 * returned promise.
 *
 * Reusable — NOT specific to memory pipeline.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private inflight = 0;
  private depth = 0;

  /** Enqueue a task. Returns a promise that resolves/rejects with the task's result. */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.depth++;
    const run = async (): Promise<T> => {
      this.inflight++;
      try {
        return await task();
      } finally {
        this.inflight--;
        this.depth--;
      }
    };
    // Chain on the existing tail so order is preserved AND a throwing task
    // does not poison the chain. `.catch(() => undefined)` swallows the
    // failure for the chain bookkeeping while the caller's `.then` on the
    // returned promise still receives the original rejection.
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Number of tasks waiting + currently running. */
  get size(): number {
    return this.depth;
  }

  /** True while at least one task is in-flight. */
  get busy(): boolean {
    return this.inflight > 0;
  }

  /**
   * Wait until every currently enqueued task has settled. Tasks enqueued
   * after `drain()` is called are NOT awaited — call `drain()` again to
   * pick them up. Suitable for clean-shutdown paths.
   */
  async drain(): Promise<void> {
    // Snapshot the current tail. A failure in the chain has already been
    // swallowed (see enqueue), so awaiting the tail never rejects.
    await this.tail;
  }
}
