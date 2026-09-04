import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations
import {
  claimedKeys,
  findDuplicatePrs,
  formatReport,
  isReleasePr,
  issueKeys,
} from '../../scripts/check-duplicate-pr.mjs';

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

// #723, the release-please PR that the guard failed on 2026-09-01: its body is
// the changelog, so it names every issue merged since the last release.
const PR_723 = {
  number: 723,
  title: 'chore(master): release 3.12.0',
  body: '## 3.12.0\n\n### Features\n\n* first-run setup flow (TRA-439)\n* price the default tool surface (TRA-448)\n* dead-daemon pane (TRA-469)',
};

// TRA-856: four real open PRs from 2026-09-04 that the guard flagged against
// each other for citing a sibling issue as context. Bodies trimmed to the
// sentences that carry the TRA keys.
const PR_871 = {
  number: 871,
  title: 'Attribute daemon shutdowns: log exit context on SIGTERM (TRA-809)',
  body: 'Fixes the diagnosability half of TRA-809: the daemon restarted 137 times in 40 h.',
};
const PR_874 = {
  number: 874,
  title: 'perf(daemon): release idle extract workers (TRA-811)',
  body: 'The daemon on the measuring machine restarts every ~3 min (TRA-809) and never reaches the 5-minute window there.\n\nCloses TRA-811.',
};
const PR_875 = {
  number: 875,
  title: 'fix(indexer): re-scan when the watcher tells us it dropped events (TRA-813)',
  body: 'Closes TRA-813.\n\nThere the daemon restarts every few minutes (TRA-809) and a start does a full pass.',
};
const PR_882 = {
  number: 882,
  title: 'docs(ops): user-signal run 2026-09-05 — code search as a channel',
  body: 'Ledger update for the run of 2026-09-05 (TRA-837). Records TRA-845, TRA-846 and TRA-843, and the index-coverage work in TRA-791.',
};
const PR_854 = {
  number: 854,
  title: 'ops: index-coverage ledger — 11 of 24 pages unindexed (TRA-791)',
  body: 'Records what Google actually has for trace-mcp.com, so a run stops re-deriving it by hand.',
};

describe('isReleasePr', () => {
  it('recognises the release-please title and nothing else', () => {
    expect(isReleasePr(PR_723)).toBe(true);
    expect(isReleasePr({ title: 'chore(deps): bump vitest' })).toBe(false);
    expect(isReleasePr(PR_597)).toBe(false);
  });
});

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

describe('claimedKeys', () => {
  it('claims the title key and the closing-keyword keys only', () => {
    expect(claimedKeys(PR_874)).toEqual(['TRA-811']);
    expect(claimedKeys(PR_875)).toEqual(['TRA-813']);
    expect(claimedKeys(PR_871)).toEqual(['TRA-809']);
  });

  it('claims nothing when a body only references issues', () => {
    expect(claimedKeys(PR_882)).toEqual([]);
  });

  it('reads a closing keyword that names several issues', () => {
    expect(claimedKeys({ title: 'fix: x', body: 'Closes TRA-1, TRA-2 and TRA-3.' })).toEqual([
      'TRA-1',
      'TRA-2',
      'TRA-3',
    ]);
  });

  it('does not read a closing keyword separated from the key by prose', () => {
    expect(claimedKeys({ title: 'fix: x', body: 'Fixes the reporting half of TRA-9.' })).toEqual(
      [],
    );
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

  it('never flags the release PR, whose changelog names every merged issue', () => {
    expect(findDuplicatePrs(PR_723, [PR_597, PR_611])).toEqual([]);
  });

  it('never flags a PR against the release PR either', () => {
    expect(findDuplicatePrs(PR_597, [PR_723])).toEqual([]);
  });

  it('passes the four PRs that only cite a sibling issue as context (TRA-856)', () => {
    const open = [PR_871, PR_874, PR_875, PR_882, PR_854];
    for (const pr of open) {
      expect(findDuplicatePrs(pr, open)).toEqual([]);
    }
  });
});

describe('formatReport', () => {
  it('names the clashing PR and the way out', () => {
    const report = formatReport(findDuplicatePrs(PR_598, [PR_597]));
    expect(report).toContain('- #597 — docs: price the default tool surface');
    expect(report).toContain('Follow-up to #NNN');
  });
});
