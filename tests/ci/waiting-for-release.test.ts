import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations
import {
  claimedKeys,
  findUnmergedClaims,
  formatReport,
} from '../../scripts/check-waiting-for-release.mjs';

// The TRA-659 incident, trimmed to the fields the check reads: both PRs were
// open and red while six issues sat in `waiting_for_release` against them.
const PR_711_OPEN = {
  number: 711,
  title: 'fix(indexer): support framework and manifest detection in monorepos (#705)',
  body: 'Resolves #705 (TRA-578)\n\nAuto-merge enabled.',
  state: 'OPEN',
  mergeStateStatus: 'BLOCKED',
};
const PR_715_OPEN = {
  number: 715,
  title: 'feat(state): implement SKILL.state linear context engine (TRA-596)',
  body: 'Closes TRA-596\nCloses TRA-597\nCloses TRA-598\nCloses TRA-599\nCloses TRA-600',
  state: 'OPEN',
  mergeStateStatus: 'BLOCKED',
};
const PR_723_RELEASE = {
  number: 723,
  title: 'chore(master): release 3.12.0',
  body: '* framework detection in monorepos (TRA-578)\n* state engine (TRA-596)',
  state: 'OPEN',
  mergeStateStatus: 'BLOCKED',
};

const issue = (identifier: string) => ({
  identifier,
  id: identifier,
  title: `work for ${identifier}`,
});

describe('claimedKeys', () => {
  it('reads a key off the title', () => {
    expect(claimedKeys(PR_715_OPEN)).toContain('TRA-596');
  });

  it('reads keys off closing-keyword body lines', () => {
    expect(claimedKeys(PR_715_OPEN)).toEqual([
      'TRA-596',
      'TRA-597',
      'TRA-598',
      'TRA-599',
      'TRA-600',
    ]);
  });

  it('reads a key parenthesised on the closing line', () => {
    expect(claimedKeys(PR_711_OPEN)).toEqual(['TRA-578']);
  });

  it('ignores a key mentioned in passing', () => {
    expect(
      claimedKeys({
        number: 1,
        title: 'docs: note the duplicate-PR guard',
        body: 'Background: the TRA-476 incident cost two implementations.',
      }),
    ).toEqual([]);
  });

  it('ignores a release PR, whose changelog names already-merged work', () => {
    expect(claimedKeys(PR_723_RELEASE)).toEqual([]);
  });
});

describe('findUnmergedClaims', () => {
  it('flags every issue parked against an unmerged PR', () => {
    const { unmerged } = findUnmergedClaims(
      ['TRA-578', 'TRA-596', 'TRA-597', 'TRA-598', 'TRA-599', 'TRA-600'].map(issue),
      [PR_711_OPEN, PR_715_OPEN, PR_723_RELEASE],
    );
    expect(unmerged.map((u: { issue: { identifier: string } }) => u.issue.identifier)).toEqual([
      'TRA-578',
      'TRA-596',
      'TRA-597',
      'TRA-598',
      'TRA-599',
      'TRA-600',
    ]);
  });

  it('passes once the PR is merged', () => {
    const { unmerged } = findUnmergedClaims(
      [issue('TRA-578')],
      [{ ...PR_711_OPEN, state: 'MERGED', mergeStateStatus: 'UNKNOWN' }],
    );
    expect(unmerged).toEqual([]);
  });

  it('flags an issue whose only PR was closed unmerged', () => {
    const { unmerged } = findUnmergedClaims(
      [issue('TRA-578')],
      [{ ...PR_711_OPEN, state: 'CLOSED' }],
    );
    expect(unmerged).toHaveLength(1);
  });

  it('accepts a superseded PR as long as one claiming PR merged', () => {
    const { unmerged } = findUnmergedClaims(
      [issue('TRA-578')],
      [
        { ...PR_711_OPEN, state: 'CLOSED' },
        { ...PR_711_OPEN, number: 712, state: 'MERGED' },
      ],
    );
    expect(unmerged).toEqual([]);
  });

  it('reports an issue no PR claims without failing on it', () => {
    const { unmerged, unlinked } = findUnmergedClaims([issue('TRA-616')], [PR_715_OPEN]);
    expect(unmerged).toEqual([]);
    expect(unlinked.map((i: { identifier: string }) => i.identifier)).toEqual(['TRA-616']);
  });
});

describe('formatReport', () => {
  it('names the PR and its real state', () => {
    const report = formatReport(findUnmergedClaims([issue('TRA-578')], [PR_711_OPEN]));
    expect(report).toContain('TRA-578');
    expect(report).toContain('#711 OPEN/BLOCKED');
  });

  it('says so when everything checks out', () => {
    expect(formatReport({ unmerged: [], unlinked: [] })).toContain('has a merged PR');
  });
});
