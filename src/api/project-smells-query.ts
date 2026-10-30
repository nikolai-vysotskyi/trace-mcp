/**
 * Query-param parser for `GET /api/projects/smells` (cli.ts). Pure and
 * side-effect free so the route's contract (priority_threshold validation,
 * limit clamp, category splitting) is unit-testable without spinning up the daemon.
 */

import type { SmellCategory, SmellPriority } from '../tools/quality/code-smells.js';

export interface ProjectSmellsQuery {
  category?: SmellCategory[];
  priorityThreshold?: SmellPriority;
  limit: number;
}

export const PROJECT_SMELLS_DEFAULT_LIMIT = 500;
export const PROJECT_SMELLS_MAX_LIMIT = 2000;

export const VALID_SMELL_PRIORITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);

export function parseProjectSmellsQuery(
  url: URL,
): { ok: true; value: ProjectSmellsQuery } | { ok: false; error: string } {
  const priorityThreshold = url.searchParams.get('priority_threshold') ?? undefined;
  if (priorityThreshold !== undefined && !VALID_SMELL_PRIORITIES.has(priorityThreshold)) {
    return { ok: false, error: 'Invalid priority_threshold (high|medium|low)' };
  }

  const categoryParam = url.searchParams.get('category');
  const category = categoryParam
    ? (categoryParam
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean) as SmellCategory[])
    : undefined;

  const rawLimit = parseInt(
    url.searchParams.get('limit') ?? String(PROJECT_SMELLS_DEFAULT_LIMIT),
    10,
  );
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(0, rawLimit), PROJECT_SMELLS_MAX_LIMIT)
    : PROJECT_SMELLS_DEFAULT_LIMIT;

  return {
    ok: true,
    value: {
      category,
      priorityThreshold: priorityThreshold as SmellPriority | undefined,
      limit,
    },
  };
}
