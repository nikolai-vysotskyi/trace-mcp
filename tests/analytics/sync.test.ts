/**
 * Unit coverage for the TRA-76 "unreachable data source" signal:
 * `attachNoSessionDataWarning()` / `buildNoSessionDataWarning()` in
 * src/analytics/sync.ts.
 */
import { describe, expect, it } from 'vitest';
import { attachNoSessionDataWarning, buildNoSessionDataWarning } from '../../src/analytics/sync.js';

describe('buildNoSessionDataWarning()', () => {
  it('mentions the resolved project path when provided', () => {
    const [warning] = buildNoSessionDataWarning('/Users/me/project');
    expect(warning).toContain('/Users/me/project');
    expect(warning).toContain('~/.claude/projects');
  });

  it('falls back to a generic scope description when no project path is given', () => {
    const [warning] = buildNoSessionDataWarning(undefined);
    expect(warning).toContain('any registered project');
  });
});

describe('attachNoSessionDataWarning()', () => {
  it('attaches _warnings only when the aggregation is empty AND no files were found on disk', () => {
    const report = attachNoSessionDataWarning({}, true, true, '/proj');
    expect(report._warnings).toBeDefined();
    expect(report._warnings?.[0]).toContain('/proj');
  });

  it('does not warn when the aggregation is empty but files exist on disk (genuinely nothing for this period)', () => {
    const report = attachNoSessionDataWarning({}, true, false, '/proj');
    expect(report._warnings).toBeUndefined();
  });

  it('does not warn when the aggregation has data even if no files were found on disk this run', () => {
    const report = attachNoSessionDataWarning({}, false, true, '/proj');
    expect(report._warnings).toBeUndefined();
  });

  it('does not warn when both signals indicate real data', () => {
    const report = attachNoSessionDataWarning({}, false, false, '/proj');
    expect(report._warnings).toBeUndefined();
  });
});
