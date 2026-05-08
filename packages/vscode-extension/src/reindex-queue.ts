/**
 * Per-file debounced reindex queue.
 *
 * We deliberately split this out from the VS Code activation glue so unit
 * tests can drive the queue with fake timers and a fake spawner — there's
 * no need to bring up @vscode/test-electron for what is fundamentally a
 * timer + Map.
 */

export interface ReindexQueueOptions {
  /** Debounce window in ms. Saves of the same path inside the window collapse. */
  debounceMs: number;
  /** Called once per file after the debounce window elapses. */
  spawn: (filePath: string) => Promise<void>;
  /** Called when a spawn rejects — typically logs to a channel. */
  onError?: (filePath: string, err: unknown) => void;
}

export interface ReindexQueue {
  /** Enqueue a save. Resets the per-file timer. */
  enqueue(filePath: string): void;
  /** Cancel all pending timers (called on extension deactivate). */
  dispose(): void;
  /**
   * For tests: number of pending timers. Production code should never
   * inspect this directly.
   */
  pendingCount(): number;
}

export function createReindexQueue(opts: ReindexQueueOptions): ReindexQueue {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function enqueue(filePath: string): void {
    const existing = timers.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      timers.delete(filePath);
      void opts.spawn(filePath).catch((err) => {
        if (opts.onError) opts.onError(filePath, err);
      });
    }, opts.debounceMs);
    timers.set(filePath, timer);
  }

  function dispose(): void {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  }

  return {
    enqueue,
    dispose,
    pendingCount: () => timers.size,
  };
}
