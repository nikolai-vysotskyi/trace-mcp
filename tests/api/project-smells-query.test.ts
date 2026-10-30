/**
 * Contract tests for GET /api/projects/smells query parsing (TRA-2788):
 * the REST endpoint reads this parser, so its priority_threshold validation,
 * limit clamp and category splitting are pinned here without spinning up
 * the daemon.
 */

import { describe, expect, it } from 'vitest';
import {
  PROJECT_SMELLS_DEFAULT_LIMIT,
  PROJECT_SMELLS_MAX_LIMIT,
  VALID_SMELL_PRIORITIES,
  parseProjectSmellsQuery,
} from '../../src/api/project-smells-query.js';

function url(query: string): URL {
  return new URL(`http://127.0.0.1:3741/api/projects/smells${query}`);
}

describe('parseProjectSmellsQuery', () => {
  it('defaults to undefined category, no threshold, limit 500', () => {
    const parsed = parseProjectSmellsQuery(url('?project=/tmp/x'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      category: undefined,
      priorityThreshold: undefined,
      limit: PROJECT_SMELLS_DEFAULT_LIMIT,
    });
  });

  it('accepts each valid priority_threshold', () => {
    for (const level of ['high', 'medium', 'low']) {
      const parsed = parseProjectSmellsQuery(url(`?project=/tmp/x&priority_threshold=${level}`));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value.priorityThreshold).toBe(level);
    }
  });

  it('rejects an unknown priority_threshold', () => {
    for (const invalid of ['critical', 'CRITICAL', 'urgent', 'info', '', '123']) {
      const parsed = parseProjectSmellsQuery(url(`?project=/tmp/x&priority_threshold=${invalid}`));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error).toBe('Invalid priority_threshold (high|medium|low)');
    }
  });

  it('clamps limit to the 2000 ceiling and falls back on garbage', () => {
    const over = parseProjectSmellsQuery(url('?project=/tmp/x&limit=5000'));
    expect(over.ok && over.value.limit).toBe(PROJECT_SMELLS_MAX_LIMIT);

    const garbage = parseProjectSmellsQuery(url('?project=/tmp/x&limit=bogus'));
    expect(garbage.ok && garbage.value.limit).toBe(PROJECT_SMELLS_DEFAULT_LIMIT);

    const negative = parseProjectSmellsQuery(url('?project=/tmp/x&limit=-10'));
    expect(negative.ok && negative.value.limit).toBe(0);

    const valid = parseProjectSmellsQuery(url('?project=/tmp/x&limit=150'));
    expect(valid.ok && valid.value.limit).toBe(150);
  });

  it('splits a comma-separated category list and trims whitespace', () => {
    const parsed = parseProjectSmellsQuery(
      url('?project=/tmp/x&category=todo_comment, debug_artifact'),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.category).toEqual(['todo_comment', 'debug_artifact']);
  });
});
