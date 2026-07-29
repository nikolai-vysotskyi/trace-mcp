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
  endsMidClause,
  hasEllipsis,
  hasNarrationMarker,
  hasTableRemnant,
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

describe('minedDecisionRejectReason — #231 follow-up live survivors', () => {
  it('rejects #101: code-span title with a Cyrillic tail + unbalanced backtick', () => {
    // Real survivor: the big `atomicWriteJson(...)` code span inflated the
    // Latin ratio so the Cyrillic tail slipped the ratio check; the trailing
    // backtick is also unbalanced. Either signal is a valid reject.
    const reason = minedDecisionRejectReason(
      '`atomicWriteJson(path, data)` — пишет в `path',
      'A complete-enough English summary sentence about atomic writes to disk here.',
    );
    expect(reason).not.toBeNull();
    expect(['non_english', 'title_truncated']).toContain(reason);
  });

  it('rejects #77: dangling imperative tail ("… Make it")', () => {
    expect(
      minedDecisionRejectReason(
        '`applyCodemod` — sync regex over many files. Make it',
        'A real English summary about running codemods synchronously across the tree here.',
      ),
    ).toBe('title_truncated');
  });

  it('rejects #78: markdown table-row remnant ("| | P1")', () => {
    expect(
      minedDecisionRejectReason(
        '`diff_graph_snapshots` — graph evolution over time | | P1',
        'A real English summary describing snapshot graph diffing over time in enough words.',
      ),
    ).toBe('title_truncated');
  });

  it('rejects #75: numbered-list fragment, unclosed paren + bold, Cyrillic tail', () => {
    const reason = minedDecisionRejectReason(
      '15. **Snapshot graph diff over time** (урок v2.3.2',
      'A real English summary describing the snapshot graph diff idea in enough words here.',
    );
    expect(reason).not.toBeNull();
    // Unbalanced "(" is caught as title_truncated; the Cyrillic "урок" is
    // caught as non_english. Both are legitimate reject reasons.
    expect(['title_truncated', 'non_english']).toContain(reason);
  });

  it('rejects a content field cut mid-clause ("… migrate to")', () => {
    expect(
      minedDecisionRejectReason(
        'Move the config writer onto the atomic helper',
        'we decided the legacy writer is unsafe and that all callers should migrate to',
      ),
    ).toBe('content_truncated');
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

  it('accepts a complete sentence whose title embeds a balanced code span', () => {
    // The #101 shape done RIGHT: balanced code span, English prose, no cut.
    expect(
      minedDecisionRejectReason(
        'Use `atomicWriteJson(path, data)` for all state-file writes to prevent torn JSON',
        'Every writer routes through the helper so a crash mid-write can never leave a partial file.',
      ),
    ).toBeNull();
  });

  it('accepts a decision that ends in a code span', () => {
    expect(
      isValidMinedDecision(
        'Route all config persistence through `atomicWriteJson`',
        'The helper writes to a temp file then renames, so concurrent readers never see a partial `config.json`',
      ),
    ).toBe(true);
  });

  it('accepts a decision ending on a bare period', () => {
    expect(
      isValidMinedDecision(
        'Adopt Redis for the session cache layer',
        'We decided to use Redis for caching because its TTL and eviction fit our session model.',
      ),
    ).toBe(true);
  });

  it('does not flag a legit title that merely contains a single shell pipe example', () => {
    // A lone pipe inside prose (not a doubled cell, not a trailing priority
    // cell) must not be mistaken for a table remnant.
    expect(hasTableRemnant('Pipe build output through `tsc | biome` in the CI gate')).toBe(false);
  });
});

describe('minedDecisionRejectReason — #17 narration-noise survivors', () => {
  it('rejects a bare result verb with dropped object ("Nailed — ...")', () => {
    const reason = minedDecisionRejectReason(
      "nailed — and it's not flaky, it's a stale-cache + image-rotation interaction",
      'A real English summary long enough to pass the content-length floor here.',
    );
    expect(reason).toBe('title_narration');
  });

  it('rejects "confirmed with hard numbers" as a bare result-verb tail', () => {
    expect(
      minedDecisionRejectReason(
        'confirmed with hard numbers',
        'A real English summary long enough to pass the content-length floor here.',
      ),
    ).toBe('title_narration');
  });

  it('rejects the exact generic placeholder title "investigation"', () => {
    expect(
      minedDecisionRejectReason(
        'investigation',
        'Phase 1 root cause investigation into the flaky test failures across the suite.',
      ),
    ).toBe('title_narration');
  });

  it('rejects first-person planning narration ("found. Let me verify...")', () => {
    expect(
      minedDecisionRejectReason(
        'found. Let me verify by also checking tests and callers',
        'A real English summary long enough to pass the content-length floor here.',
      ),
    ).toBe('title_narration');
  });

  it('rejects a title carrying an explicit ellipsis truncation marker', () => {
    expect(
      minedDecisionRejectReason(
        'a type mismatch at a call site (...), all 3 confined to...',
        'A real English summary long enough to pass the content-length floor here.',
      ),
    ).not.toBeNull();
  });

  it('rejects content that trails off with an ellipsis', () => {
    expect(
      minedDecisionRejectReason(
        'Use PostgreSQL over MySQL for JSONB support',
        'We chose PostgreSQL because its JSONB indexing fit our query patterns better...',
      ),
    ).toBe('content_truncated');
  });

  it('does not flag a legitimate title using "found" as a real verb with an object', () => {
    expect(hasNarrationMarker('Found a race condition in the cache invalidation path')).toBe(false);
  });

  it('does not flag legitimate prose containing three literal dots mid-sentence', () => {
    expect(hasEllipsis('Use PostgreSQL over MySQL for JSONB support')).toBe(false);
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

describe('endsMidClause', () => {
  it.each([
    'sync regex over many files. Make it',
    'Migrate the config writer to',
    'Wrap every write with',
    'This defers the snapshot work and',
    'Choose Postgres because',
    'Keep the retry budget under',
  ])('flags mid-clause tail: %s', (s) => {
    expect(endsMidClause(s)).toBe(true);
  });

  it.each([
    'Use Postgres over MySQL for JSONB support',
    'The helper renames the temp file atomically.',
    'Route writes through `atomicWriteJson`',
    'Adopt Redis for the session cache layer',
    'Ship the P0 batch this week', // ends "week" (content word), not dangling
  ])('does not flag a complete tail: %s', (s) => {
    expect(endsMidClause(s)).toBe(false);
  });
});

describe('hasTableRemnant', () => {
  it.each([
    'graph evolution over time | | P1',
    'Do the thing | P0 | later stuff | P1',
    'Ship it | P0',
  ])('flags table remnant: %s', (s) => {
    expect(hasTableRemnant(s)).toBe(true);
  });

  it.each([
    'Use Postgres over MySQL for JSONB support',
    'Pipe build output through `tsc | biome` in CI',
  ])('does not flag legit prose: %s', (s) => {
    expect(hasTableRemnant(s)).toBe(false);
  });
});
