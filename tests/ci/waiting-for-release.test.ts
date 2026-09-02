import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations
import {
  describePr,
  findUnmergedClaims,
  formatReport,
} from '../../scripts/check-waiting-for-release.mjs';

// Shapes come from `multica issue pull-requests --output json`: lowercase state,
// plus the check rollup the platform already carries.
const PR_715_OPEN = {
  number: 715,
  state: 'open',
  merge_state_status: 'blocked',
  failed_check_names: ['CodeQL', 'Semgrep scan'],
};
const PR_715_MERGED = { number: 715, state: 'merged', merge_state_status: 'unknown' };

const issue = (identifier: string) => ({
  identifier,
  id: identifier,
  title: `work for ${identifier}`,
});

describe('findUnmergedClaims', () => {
  it('flags every issue parked against an unmerged PR', () => {
    // The TRA-659 incident: five issues on #715 while it was open and red.
    const entries = ['TRA-596', 'TRA-597', 'TRA-598', 'TRA-599', 'TRA-600'].map((k) => ({
      issue: issue(k),
      prs: [PR_715_OPEN],
    }));
    const { unmerged } = findUnmergedClaims(entries);
    expect(unmerged.map((u: { issue: { identifier: string } }) => u.issue.identifier)).toEqual([
      'TRA-596',
      'TRA-597',
      'TRA-598',
      'TRA-599',
      'TRA-600',
    ]);
  });

  it('passes once the PR is merged', () => {
    const { unmerged } = findUnmergedClaims([{ issue: issue('TRA-596'), prs: [PR_715_MERGED] }]);
    expect(unmerged).toEqual([]);
  });

  it('flags an issue whose only PR was closed unmerged', () => {
    const { unmerged } = findUnmergedClaims([
      { issue: issue('TRA-596'), prs: [{ number: 715, state: 'closed' }] },
    ]);
    expect(unmerged).toHaveLength(1);
  });

  it('accepts a superseded PR as long as one linked PR merged', () => {
    const { unmerged } = findUnmergedClaims([
      { issue: issue('TRA-616'), prs: [{ number: 735, state: 'closed' }, PR_715_MERGED] },
    ]);
    expect(unmerged).toEqual([]);
  });

  it('reports an issue with no linked PR without failing on it', () => {
    const { unmerged, unlinked } = findUnmergedClaims([{ issue: issue('TRA-591'), prs: [] }]);
    expect(unmerged).toEqual([]);
    expect(unlinked.map((i: { identifier: string }) => i.identifier)).toEqual(['TRA-591']);
  });
});

describe('describePr', () => {
  it('names the state, the merge state, and the failing checks', () => {
    expect(describePr(PR_715_OPEN)).toBe('#715 open, blocked, failing: CodeQL, Semgrep scan');
  });

  it('drops the merge state the platform could not resolve', () => {
    expect(describePr(PR_715_MERGED)).toBe('#715 merged');
  });
});

describe('formatReport', () => {
  it('names the issue and its PR', () => {
    const report = formatReport(
      findUnmergedClaims([{ issue: issue('TRA-596'), prs: [PR_715_OPEN] }]),
    );
    expect(report).toContain('TRA-596');
    expect(report).toContain('#715 open, blocked, failing: CodeQL, Semgrep scan');
  });

  it('says so when everything checks out', () => {
    expect(formatReport({ unmerged: [], unlinked: [] })).toContain('has a merged one');
  });

  it('lists the unverifiable issues even when nothing failed', () => {
    const report = formatReport(findUnmergedClaims([{ issue: issue('TRA-591'), prs: [] }]));
    expect(report).toContain('Not verifiable');
    expect(report).toContain('TRA-591');
  });
});
