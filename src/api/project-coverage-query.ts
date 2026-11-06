/**
 * Query-param parser for `GET /api/projects/coverage` (cli.ts, TRA-2928). Pure and
 * side-effect free so the route's contract (projectRoot presence, limit clamp)
 * is unit-testable without spinning up the daemon.
 */

export interface ProjectCoverageQuery {
  projectRoot: string;
  limit?: number;
}

export const PROJECT_COVERAGE_DEFAULT_LIMIT = 500;
export const PROJECT_COVERAGE_MAX_LIMIT = 2000;

export function parseProjectCoverageQuery(
  url: URL,
): { ok: true; value: ProjectCoverageQuery } | { ok: false; error: string } {
  const projectRoot = url.searchParams.get('project');
  if (!projectRoot) {
    return { ok: false, error: 'Missing ?project= query param' };
  }

  const raw = url.searchParams.get('limit');
  let limit: number | undefined;
  if (raw !== null) {
    const rawLimit = parseInt(raw, 10);
    limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(0, rawLimit), PROJECT_COVERAGE_MAX_LIMIT)
      : PROJECT_COVERAGE_DEFAULT_LIMIT;
  }

  return {
    ok: true,
    value: {
      projectRoot,
      limit,
    },
  };
}
