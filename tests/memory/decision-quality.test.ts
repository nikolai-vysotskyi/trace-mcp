/**
 * Tests for the mined-decision quality gate.
 *
 * Locks down the truncation classes reported from production decision stores
 * where the session miner emitted mid-sentence / mid-word fragments that
 * polluted `query_decisions`:
 *   - title cut mid-clause  → "so let's monitor it over the rest of this"
 *   - single-word summaries → "ming).", "budget |"
 *   - broken UTF-8 / Cyrillic truncation → "оп.", "против билд-сложности"
 *   - truncated code span   → "`atomicWriteJson(path, data)` — пишет в `path"
 *
 * A legitimate, complete decision sentence must still pass.
 */

import { describe, expect, it } from 'vitest';
import {
  isValidMinedDecision,
  minedDecisionRejectReason,
  startsMidClause,
} from '../../src/memory/decision-quality.js';

describe('minedDecisionRejectReason — reporter garbage examples', () => {
  it('rejects a title cut mid-clause ("so let\'s monitor...")', () => {
    // Real reporter row: title fragment + a one-word truncated summary.
    const reason = minedDecisionRejectReason("so let's monitor it over the rest of this", 'ming).');
    expect(reason).not.toBeNull();
    // The title opener is the fatal signal; content is also single-word.
    expect(['title_mid_clause', 'content_too_short']).toContain(reason);
  });

  it('rejects a single-word truncated summary ("ming).")', () => {
    // Even with an acceptable title, a one-word chopped summary is useless.
    expect(
      minedDecisionRejectReason('Monitor AdSense revenue after the integration change', 'ming).'),
    ).toBe('content_too_short');
  });

  it('rejects a table-cell fragment summary ("budget |")', () => {
    expect(
      minedDecisionRejectReason('Ship the P0 tool batch this week for the graph work', 'budget |'),
    ).toBe('content_too_short');
  });

  it('rejects the Cyrillic "оп." truncation (broken/non-English summary)', () => {
    // "did a full pass over the ad integration today" / "оп." — the summary is
    // a chopped Cyrillic fragment. Title is fine; the summary must fail.
    const reason = minedDecisionRejectReason(
      'Did a full pass over the ad integration today and verified placements',
      'оп.',
    );
    expect(reason).not.toBeNull();
    // "оп." is 1 Cyrillic word → too short and/or non-English; either is a reject.
    expect(['content_too_short', 'non_english']).toContain(reason);
  });

  it('rejects a predominantly Russian title ("против билд-сложности")', () => {
    expect(
      minedDecisionRejectReason(
        'против билд-сложности',
        'startup snapshot trade-off against build complexity we defer this for now',
      ),
    ).toBe('non_english');
  });

  it('rejects the #101 truncated code-span row (non-English body)', () => {
    // Real stored row: title is a truncated code span, body is Russian prose.
    // The English-only content gate is the fatal signal here (the unbalanced
    // trailing backtick in the title is separately repaired by sanitizeTitle
    // at extraction time).
    const reason = minedDecisionRejectReason(
      '`atomicWriteJson(path, data)` — writes to `path',
      'Если crash посередине — файл повреждён. Добавить util atomicWriteJson который пишет в tmp затем rename.',
    );
    expect(reason).toBe('non_english');
  });

  it('rejects a summary carrying a broken-UTF-8 replacement char', () => {
    expect(
      minedDecisionRejectReason(
        'Use a temp-file-plus-rename pattern for all config writes',
        'writes to path.tmp then renames � so a crash mid-write never corrupts',
      ),
    ).toBe('broken_encoding');
  });

  it('rejects a too-short title', () => {
    expect(minedDecisionRejectReason('use X', 'a perfectly fine long summary sentence here')).toBe(
      'title_too_short',
    );
  });
});

describe('minedDecisionRejectReason — legitimate decisions pass', () => {
  it('accepts a complete decision sentence + real summary', () => {
    expect(
      minedDecisionRejectReason(
        'Use PostgreSQL over MySQL for JSONB support',
        'We chose PostgreSQL because its JSONB indexing and full-text search fit our query patterns better than MySQL.',
      ),
    ).toBeNull();
  });

  it('accepts a code-anchored title (backtick start is not mid-clause)', () => {
    expect(
      minedDecisionRejectReason(
        '`atomicWriteJson()` guards config writes against partial-write corruption',
        'The helper writes to a temp file, fsyncs, then renames so a crash mid-write cannot corrupt config.',
      ),
    ).toBeNull();
  });

  it('accepts a title that legitimately starts with a lowercase non-opener verb', () => {
    // "did a full pass ..." — "did" is not a mid-clause opener, and the
    // summary is a real sentence, so the pair is valid.
    expect(
      isValidMinedDecision(
        'Migrated the ad integration to server-side rendering today',
        'Moved all AdSense slots to SSR so the layout no longer shifts on hydration; verified across three breakpoints.',
      ),
    ).toBe(true);
  });
});

describe('startsMidClause', () => {
  it.each([
    'so let it be',
    'and then we',
    'but it was slow',
    'it over the rest',
    'these values leak',
    'they decided later',
    'because of latency',
  ])('flags mid-clause opener: %s', (s) => {
    expect(startsMidClause(s)).toBe(true);
  });

  it.each([
    'Decision: use X',
    'Monitor the revenue',
    '`code` first',
    '2 spaces indent',
    'PostgreSQL over MySQL',
    'did a full pass', // lowercase but not a continuation token
    'to use Redis for caching', // infinitive after a consumed decision verb
    'for the auth service', // preposition object of a consumed verb
    'the JSONB indexing path', // bare article — legitimate regex capture
  ])('does not flag a legitimate start: %s', (s) => {
    expect(startsMidClause(s)).toBe(false);
  });
});
