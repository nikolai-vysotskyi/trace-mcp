/**
 * Contract tests for GET /api/projects/coverage query parsing (TRA-2928):
 * the REST endpoint reads this parser, so project query validation and
 * limit clamping are pinned here without spinning up the daemon.
 */

import { describe, expect, it } from 'vitest';
import {
  PROJECT_COVERAGE_DEFAULT_LIMIT,
  PROJECT_COVERAGE_MAX_LIMIT,
  parseProjectCoverageQuery,
} from '../../src/api/project-coverage-query.js';

function url(query: string): URL {
  return new URL(`http://127.0.0.1:3741/api/projects/coverage${query}`);
}

describe('parseProjectCoverageQuery', () => {
  it('returns undefined limit when limit param is omitted', () => {
    const parsed = parseProjectCoverageQuery(url('?project=/tmp/x'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      projectRoot: '/tmp/x',
      limit: undefined,
    });
  });

  it('rejects when ?project= is missing', () => {
    const parsed = parseProjectCoverageQuery(url('?limit=10'));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe('Missing ?project= query param');
  });

  it('parses valid limit correctly (e.g. limit=1)', () => {
    const parsed = parseProjectCoverageQuery(url('?project=/tmp/x&limit=1'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.limit).toBe(1);
  });

  it('clamps limit to the 2000 ceiling and falls back on garbage', () => {
    const over = parseProjectCoverageQuery(url('?project=/tmp/x&limit=5000'));
    expect(over.ok && over.value.limit).toBe(PROJECT_COVERAGE_MAX_LIMIT);

    const garbage = parseProjectCoverageQuery(url('?project=/tmp/x&limit=bogus'));
    expect(garbage.ok && garbage.value.limit).toBe(PROJECT_COVERAGE_DEFAULT_LIMIT);

    const negative = parseProjectCoverageQuery(url('?project=/tmp/x&limit=-10'));
    expect(negative.ok && negative.value.limit).toBe(0);

    const valid = parseProjectCoverageQuery(url('?project=/tmp/x&limit=150'));
    expect(valid.ok && valid.value.limit).toBe(150);
  });
});
