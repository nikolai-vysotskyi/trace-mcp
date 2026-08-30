import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations
import { findDuplicatePrs, formatReport, issueKeys } from '../../scripts/check-duplicate-pr.mjs';

// Fixtures are the real PRs from the TRA-476 incident, trimmed to the fields
// the check reads. Two of these pairs are duplicates that cost a full
// implementation each; two are healthy follow-ups that must still pass.
const PR_597 = {
  number: 597,
  title: 'docs: price the default tool surface on one basis everywhere (TRA-448)',
  body: 'Closes TRA-448.',
};
const PR_598 = {
  number: 598,
  title: 'docs: say which basis prices the default tool surface (TRA-448)',
  body: 'Closes TRA-448.\n\nThree pages priced the shipped default tool surface at three numbers.',
};
const PR_611 = {
  number: 611,
  title: 'fix(app): Project Overview says a dead daemon once, not six times (TRA-469)',
  body: 'Closes TRA-469.',
};
const PR_613 = {
  number: 613,
  title: 'fix(app): one answer for an unreachable daemon on Project Overview (TRA-469)',
  body: 'Closes TRA-469.',
};
const PR_614 = {
  number: 614,
  title: 'fix(app): centre the daemon-down pane on Project Overview (TRA-469)',
  body: 'Follow-up to #611 (TRA-469), found by looking at the shipped render.',
};
const PR_612 = {
  number: 612,
  title: 'fix(workspace): measure the pane before the first paint, not after it',
  body: 'Follow-up to #608.',
};

describe('issueKeys', () => {
  it('collects distinct keys case-insensitively', () => {
    expect(issueKeys('Closes TRA-448, supersedes tra-448 and TRA-455')).toEqual([
      'TRA-448',
      'TRA-455',
    ]);
  });

  it('is empty for a PR that names no issue', () => {
    expect(issueKeys(PR_612.title)).toEqual([]);
  });
});

describe('findDuplicatePrs', () => {
  it('flags the second PR on an issue another open PR already claims', () => {
    expect(findDuplicatePrs(PR_598, [PR_597]).map((p) => p.number)).toEqual([597]);
    expect(findDuplicatePrs(PR_613, [PR_611]).map((p) => p.number)).toEqual([611]);
  });

  it('passes a follow-up that cites the PR it builds on', () => {
    expect(findDuplicatePrs(PR_614, [PR_611])).toEqual([]);
  });

  it('passes a PR whose sibling has already merged and left the open list', () => {
    expect(findDuplicatePrs(PR_614, [])).toEqual([]);
  });

  it('passes a PR that names no issue', () => {
    expect(findDuplicatePrs(PR_612, [PR_611])).toEqual([]);
  });

  it('ignores itself and unrelated issues', () => {
    expect(findDuplicatePrs(PR_597, [PR_597, PR_611])).toEqual([]);
  });
});

describe('formatReport', () => {
  it('names the clashing PR and the way out', () => {
    const report = formatReport(findDuplicatePrs(PR_598, [PR_597]));
    expect(report).toContain('- #597 — docs: price the default tool surface');
    expect(report).toContain('Follow-up to #NNN');
  });
});
