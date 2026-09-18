/**
 * Contract tests for GET /api/projects/security query parsing (TRA-1675):
 * the Overview Security section reads this endpoint, so its severity
 * validation, limit clamp and rules splitting are pinned here without
 * spinning up the daemon.
 */

import { describe, expect, it } from 'vitest';
import {
  PROJECT_SECURITY_DEFAULT_LIMIT,
  PROJECT_SECURITY_MAX_LIMIT,
  parseProjectSecurityQuery,
} from '../../src/api/project-security-query.js';

function url(query: string): URL {
  return new URL(`http://127.0.0.1:3741/api/projects/security${query}`);
}

describe('parseProjectSecurityQuery', () => {
  it('defaults to all rules, no threshold, limit 500', () => {
    const parsed = parseProjectSecurityQuery(url('?project=/tmp/x'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      rules: ['all'],
      severityThreshold: undefined,
      includeLowConfidence: false,
      limit: PROJECT_SECURITY_DEFAULT_LIMIT,
    });
  });

  it('accepts each valid severity_threshold', () => {
    for (const level of ['critical', 'high', 'medium', 'low']) {
      const parsed = parseProjectSecurityQuery(url(`?project=/tmp/x&severity_threshold=${level}`));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value.severityThreshold).toBe(level);
    }
  });

  it('rejects an unknown severity_threshold', () => {
    const parsed = parseProjectSecurityQuery(url('?project=/tmp/x&severity_threshold=info'));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/severity_threshold/);
  });

  it('clamps limit to the 2000 ceiling and falls back on garbage', () => {
    const over = parseProjectSecurityQuery(url('?project=/tmp/x&limit=5000'));
    expect(over.ok && over.value.limit).toBe(PROJECT_SECURITY_MAX_LIMIT);

    const garbage = parseProjectSecurityQuery(url('?project=/tmp/x&limit=bogus'));
    expect(garbage.ok && garbage.value.limit).toBe(PROJECT_SECURITY_DEFAULT_LIMIT);
  });

  it('splits a comma-separated rules list and trims whitespace', () => {
    const parsed = parseProjectSecurityQuery(url('?project=/tmp/x&rules=sql_injection, xss'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.rules).toEqual(['sql_injection', 'xss']);
  });

  it('reads include_low_confidence as a flag', () => {
    const one = parseProjectSecurityQuery(url('?project=/tmp/x&include_low_confidence=1'));
    expect(one.ok && one.value.includeLowConfidence).toBe(true);

    const truthy = parseProjectSecurityQuery(url('?project=/tmp/x&include_low_confidence=true'));
    expect(truthy.ok && truthy.value.includeLowConfidence).toBe(true);

    const absent = parseProjectSecurityQuery(url('?project=/tmp/x'));
    expect(absent.ok && absent.value.includeLowConfidence).toBe(false);
  });
});
