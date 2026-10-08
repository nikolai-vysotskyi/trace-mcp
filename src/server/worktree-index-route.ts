/**
 * Session-side view of a linked worktree's branch index (GH #1481, step 2).
 *
 * The daemon keeps, per linked worktree, a copy of the canonical index with
 * the branch delta re-indexed into it (`src/daemon/worktree-index.ts`). A
 * session for that worktree is still created against the canonical project;
 * once the copy is ready, its tool calls are answered by the copy instead.
 * This module holds only the contract the tool gate and `batch` need, so the
 * server layer never imports the daemon.
 */

import type { WorktreeDelta } from '../worktree-delta.js';
import type { ToolResponse } from './types.js';

/** A ready branch index a worktree session can dispatch tool calls to. */
export interface WorktreeIndexTarget {
  /**
   * Run `tool` against the branch index. Resolves to undefined when the index
   * cannot answer (tool unknown there, or the index was retired in between) —
   * the caller then runs its own handler.
   */
  run(tool: string, params: Record<string, unknown>): Promise<ToolResponse | undefined>;
  /**
   * Files whose current worktree content has not reached the branch index
   * yet (a sync is still running), as a delta for `markStaleOnBranch`. Null
   * when the index is up to date.
   */
  pending(): WorktreeDelta | null;
}

export interface WorktreeIndexRoute {
  /**
   * The branch index to answer from, or null to answer from the canonical
   * index as before (feature off, copy still building, build failed). Waits a
   * bounded time; never rejects.
   */
  resolve(): Promise<WorktreeIndexTarget | null>;
}

/**
 * Wrap a tool callback so it runs on `target` and falls back to `fallback`
 * when the branch index cannot answer. `onDelegated` fires when the branch
 * index produced the response.
 */
export function delegateToWorktreeIndex(
  target: WorktreeIndexTarget,
  tool: string,
  fallback: (...args: unknown[]) => unknown,
  onDelegated?: () => void,
): (...args: unknown[]) => Promise<unknown> {
  return async (...args: unknown[]) => {
    const params =
      args[0] && typeof args[0] === 'object' ? (args[0] as Record<string, unknown>) : {};
    const response = await target.run(tool, params);
    if (response === undefined) return fallback(...args);
    onDelegated?.();
    return response;
  };
}
