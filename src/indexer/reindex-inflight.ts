import path from 'node:path';

/**
 * Process-wide registry of projects with indexing work in flight right now.
 *
 * TRA-1125: `projects_indexing` in the vitals line only ever counted projects
 * in the initial-load path — `project-manager.ts` sets `status = 'indexing'`
 * there. Every incremental path *requires* status `ready` to proceed and never
 * changes it, so by construction every reindex on a live daemon was logged as
 * idle. In the measured window 264 of 264 vitals samples reported
 * `projects_indexing: 0` while the daemon burned 99.3% CPU on a reindex burst,
 * which made every "idle RSS" figure in docs/perf a silent mix of idle and busy.
 *
 * TRA-1763: the TRA-1125 fix covered only the single-file paths (HTTP handler +
 * `register_edit`). The deferred full edge-reconcile (`fireEdgeReconcile`),
 * the deferred coverage check (`fireCoverageReconcile`), every watcher-driven
 * `indexFiles` batch (including the >200-file bulk full-pass fallback), and
 * every ready-state `indexAll` (drops/storm full-walk, forced reindex) run
 * after `status: ready` and were equally invisible. The pipeline holds a mark
 * for all of them now; the vitals counter is `status`-based projects plus
 * this registry, minus the overlap (see `isReindexing`, used by `getCounts`
 * in `cli.ts` so the initial load is not counted twice).
 *
 * Lives in `indexer/` (not `daemon/`) so the pipeline can import it without
 * creating an indexer→daemon edge: `daemon/reindex-file-handler.ts` only
 * re-exports these for its existing callers.
 */
const inFlight = new Map<string, number>();

/** Normalize the in-flight key: callers key by raw client strings,
 *  registration strings, or pipeline root paths, which can differ in trailing
 *  slashes or relative segments for the same project. */
function keyOf(project: string): string {
  return path.resolve(project);
}

/** Distinct projects with indexing work in flight. Feeds the vitals line. */
export function countReindexingProjects(): number {
  return inFlight.size;
}

/** Whether `project` currently holds an in-flight mark. Used to keep the
 *  status-based term of `projects_indexing` from double-counting a project
 *  that is both `status = 'indexing'` (initial load) and marked here. */
export function isReindexing(project: string): boolean {
  return inFlight.has(keyOf(project));
}

/**
 * Mark indexing work as started; the returned function marks it finished and
 * is safe to call more than once. Every indexing path on a live daemon must
 * hold this while it runs — single-file callers (HTTP handler,
 * `register_edit`, the `reindex` tool) mark at the call site, while the
 * pipeline marks `indexAll` / `indexFiles` / the deferred reconciles itself
 * so watcher-driven and timer-driven work cannot slip through again.
 * Nested marks for the same project only bump the refcount; the distinct
 * project count reported by `countReindexingProjects()` is unaffected.
 */
export function beginReindex(project: string): () => void {
  const key = keyOf(project);
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (inFlight.get(key) ?? 1) - 1;
    if (n > 0) inFlight.set(key, n);
    else inFlight.delete(key);
  };
}
