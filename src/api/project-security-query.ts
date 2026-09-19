/**
 * Query-param parser for `GET /api/projects/security` (cli.ts). Pure and
 * side-effect free so the route's contract (severity validation, limit clamp,
 * rules splitting) is unit-testable without spinning up the daemon.
 */

import type { RuleName, Severity } from '../tools/quality/security-scan.js';

export interface ProjectSecurityQuery {
  rules: RuleName[];
  severityThreshold?: Severity;
  includeLowConfidence: boolean;
  limit: number;
}

export const PROJECT_SECURITY_DEFAULT_LIMIT = 500;
export const PROJECT_SECURITY_MAX_LIMIT = 2000;

const VALID_SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low']);

export function parseProjectSecurityQuery(
  url: URL,
): { ok: true; value: ProjectSecurityQuery } | { ok: false; error: string } {
  const severityThreshold = url.searchParams.get('severity_threshold') ?? undefined;
  if (severityThreshold !== undefined && !VALID_SEVERITIES.has(severityThreshold)) {
    return { ok: false, error: 'Invalid severity_threshold (critical|high|medium|low)' };
  }

  const flag = url.searchParams.get('include_low_confidence');
  const includeLowConfidence = flag === '1' || flag === 'true';

  const rulesParam = (url.searchParams.get('rules') ?? 'all').trim();
  const rules = (
    rulesParam === 'all' || rulesParam === ''
      ? ['all']
      : rulesParam
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
  ) as RuleName[];
  if (rules.length === 0) {
    return { ok: false, error: 'No valid rules specified' };
  }

  const rawLimit = parseInt(
    url.searchParams.get('limit') ?? String(PROJECT_SECURITY_DEFAULT_LIMIT),
    10,
  );
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(0, rawLimit), PROJECT_SECURITY_MAX_LIMIT)
    : PROJECT_SECURITY_DEFAULT_LIMIT;

  return {
    ok: true,
    value: {
      rules,
      severityThreshold: severityThreshold as Severity | undefined,
      includeLowConfidence,
      limit,
    },
  };
}
