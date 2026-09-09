import { describe, expect, it } from 'vitest';
import { anchors, checkRemoteClaims } from '../../scripts/check-remote-claims.mjs';

/**
 * The two claim surfaces that are not files — TRA-1120.
 *
 * `scripts/check-remote-claims.mjs` fetches the GitHub repo description and the
 * npm registry description and compares both to `docs/_data/`. The fetch is
 * nightly in CI; these cases are the offline half, because a `tests/docs/*` run
 * must not depend on someone else's uptime.
 *
 * The strings below are the real ones, live on 2026-09-07: 70.5% on GitHub and
 * 90.6% on npm on the same day, both unguarded, with CI green throughout.
 */
describe('remote claim surfaces (TRA-1120)', () => {
  const anchor = anchors();
  /**
   * The shipped description, with its measured figure read out of the anchor
   * rather than typed — TRA-1141 re-measured the median and this fixture was
   * the one place still asserting the previous one.
   */
  const MEASURED = `${anchor.savings[0]}%`;
  const CLEAN =
    'Framework-aware code intelligence MCP server — 88 framework integrations, 81 languages, ' +
    `${MEASURED} fewer input tokens to review a pull request`;

  it('reads its anchors out of docs/_data/, not out of prose', () => {
    expect(anchor.counts.languages).toBeGreaterThan(0);
    expect(anchor.counts.frameworks).toBeGreaterThan(0);
    // The figures a one-liner is allowed to quote are generated ones. If this
    // list ever gains a hand-typed member, the gate has stopped being a gate.
    expect(anchor.savings.length).toBeGreaterThanOrEqual(2);
    expect(anchor.packageDescription).toContain(String(anchor.counts.languages));
  });

  it('passes the description we actually ship', () => {
    expect(checkRemoteClaims([{ name: 'npm', text: CLEAN, mirrors: CLEAN }], anchor)).toEqual([]);
  });

  it('catches the retired figure npm was serving', () => {
    const problems = checkRemoteClaims(
      [{ name: 'npm', text: CLEAN.replace(MEASURED, '90.6%') }],
      anchor,
    );
    expect(problems.join('\n')).toContain('retired');
    // One stale number, one finding — not one per rule that happens to match it.
    expect(problems).toHaveLength(1);
  });

  // Both found by review of the first cut of this gate, both confirmed by
  // running the regexes: the adverb and the spelled-out unit each slipped a
  // retired claim past every check with zero problems reported.
  it('catches the adverb too — "100% locally" is the same claim as "100% local"', () => {
    for (const phrasing of ['100% locally', 'completely locally', 'fully local']) {
      expect(
        checkRemoteClaims([{ name: 'gh', text: `${CLEAN}. Runs ${phrasing}.` }], anchor).join('\n'),
        phrasing,
      ).toContain('usage ping is on by default');
    }
  });

  it('catches a retired figure spelled out instead of glyphed', () => {
    // `%` is what every pattern here hunts for, and a description pasted out of
    // prose need not carry one.
    for (const spelling of ['90.6 percent', '90.6 per cent']) {
      expect(
        checkRemoteClaims([{ name: 'npm', text: CLEAN.replace(MEASURED, spelling) }], anchor).join(
          '\n',
        ),
        spelling,
      ).toContain('retired');
    }
  });

  it('catches a percentage that is simply not in docs/_data/', () => {
    expect(
      checkRemoteClaims([{ name: 'gh', text: CLEAN.replace(MEASURED, '75%') }], anchor).join('\n'),
    ).toContain('not in docs/_data/');
  });

  it('catches a count that has drifted from counts.yml', () => {
    expect(
      checkRemoteClaims(
        [{ name: 'gh', text: CLEAN.replace('81 languages', '80 languages') }],
        anchor,
      ).join('\n'),
    ).toContain('counts.yml says');
  });

  it('catches "100% local" while the usage ping is opt-out (TRA-1013)', () => {
    const problems = checkRemoteClaims([{ name: 'gh', text: `${CLEAN}. 100% local.` }], anchor);
    expect(problems.join('\n')).toContain('usage ping is on by default');
    // "100% local" must not also be reported as an unsourced savings figure.
    expect(problems).toHaveLength(1);
  });

  it('allows the locality claim once it says what the ping does', () => {
    // The fix TRA-1013 asks for is a stronger sentence, not a vaguer one. A
    // gate that failed this too would push the copy back to saying nothing.
    expect(
      checkRemoteClaims(
        [
          {
            name: 'gh',
            text: `${CLEAN}. Your code and index never leave the machine; an anonymous usage ping is on by default and opt-out.`,
          },
        ],
        anchor,
      ),
    ).toEqual([]);
  });

  it('reports npm drifting from package.json as its own, softer finding', () => {
    const problems = checkRemoteClaims(
      [{ name: 'npm', text: CLEAN, mirrors: `${CLEAN}, 100% MIT` }],
      anchor,
    );
    expect(problems.join('\n')).toContain('drifted from package.json');
  });

  it('reports an empty description rather than passing it', () => {
    expect(checkRemoteClaims([{ name: 'gh', text: '' }], anchor).join('\n')).toContain(
      'no description at all',
    );
  });
});
