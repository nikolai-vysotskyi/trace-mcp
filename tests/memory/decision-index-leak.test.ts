/**
 * Adversarial content-leak checks for progressive disclosure (Task 12).
 *
 * `query_decisions { index_only: true }` must NEVER leak the full `content`
 * field — not directly, not via a suspiciously-long `summary`, and not via
 * any other nested field. `toDecisionIndexEntry` builds an explicit fresh
 * object (so it structurally cannot forward unlisted fields), but the
 * `summary` derivation itself has an edge case worth pinning down: content
 * with NO sentence-ending punctuation returns the raw text up to
 * SUMMARY_MAX(160) chars. For content shorter than 160 chars with no
 * punctuation, the "summary" IS the full content — by design, since a ~150
 * char note already reads as one line. This suite proves that boundary is
 * exactly where the code says it is, not fuzzier.
 */
import { describe, expect, it } from 'vitest';
import type { DecisionRow } from '../../src/memory/decision-types.js';
import { summarizeContent, toDecisionIndexEntry } from '../../src/memory/decision-index.js';

function row(over: Partial<DecisionRow>): DecisionRow {
  return {
    id: 1,
    title: 'T',
    content: 'c',
    type: 'tech_choice',
    project_root: '/p',
    service_name: null,
    symbol_id: null,
    file_path: null,
    tags: null,
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_until: null,
    session_id: null,
    source: 'manual',
    confidence: 1,
    git_branch: null,
    review_status: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: null,
    hit_count: 0,
    last_hit_at: null,
    ...over,
  };
}

describe('progressive disclosure — content leak hardening', () => {
  it('never carries a `content` key at all, for any input shape', () => {
    const entry = toDecisionIndexEntry(row({ content: 'anything, does not matter here' }));
    expect(Object.keys(entry)).not.toContain('content');
  });

  it('the bulky part of a multi-sentence body never appears anywhere in the serialized entry', () => {
    const content =
      'Adopt argon2id for password hashing. ' +
      'This second sentence is the bulky body that must never appear in the summary or leak anywhere else in the payload.';
    const entry = toDecisionIndexEntry(row({ content }));
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('bulky body');
    expect(serialized).not.toContain('never appear in the summary');
  });

  it('bounds the summary to <=160 chars even for long unpunctuated content', () => {
    // No '.', '!', '?' anywhere — the regex match falls through to the whole
    // flattened string, so truncation is the ONLY thing standing between this
    // and a full content leak.
    const longNoPunct = 'x'.repeat(1000);
    const entry = toDecisionIndexEntry(row({ content: longNoPunct }));
    expect(entry.summary.length).toBeLessThanOrEqual(160);
    expect(entry.summary).not.toBe(longNoPunct);
    expect(entry.summary.endsWith('…')).toBe(true);
  });

  it('a short (<160 char) unpunctuated content IS returned verbatim as the summary (documented, not a leak)', () => {
    // This is the honest boundary case: a 100-char note with no punctuation
    // has nothing to truncate, so summary === content. That is intentional
    // (a ~1-line note has nothing extra to hide) — assert it explicitly so
    // nobody "fixes" summarizeContent into silently truncating short content
    // too, which would make short summaries lossy for no reason.
    const short = 'y'.repeat(100);
    expect(summarizeContent(short)).toBe(short);
    const entry = toDecisionIndexEntry(row({ content: short }));
    expect(entry.summary).toBe(short);
    expect(entry.summary.length).toBeLessThanOrEqual(160);
  });

  it('truncates content that is exactly 1 char over the SUMMARY_MAX boundary', () => {
    const exact160 = 'z'.repeat(160);
    const over161 = 'z'.repeat(161);
    expect(summarizeContent(exact160)).toBe(exact160); // no truncation needed
    expect(summarizeContent(exact160).endsWith('…')).toBe(false);
    const truncated = summarizeContent(over161);
    expect(truncated.length).toBeLessThanOrEqual(160);
    expect(truncated.endsWith('…')).toBe(true);
    expect(truncated).not.toBe(over161);
  });

  it('does not leak content through any field when content contains secret-shaped substrings', () => {
    // Simulates the worst case: a decision whose content contains something
    // that looks like a credential. First-sentence + 160-char cap must still
    // apply — the leak surface is bounded regardless of content shape.
    const secret = 'API_KEY=sk-abcdef1234567890abcdef1234567890abcdef1234567890';
    const content = `${secret}. This is the rest of a much longer decision body that goes on and on and on well past the summary cutoff point for sure.`;
    const entry = toDecisionIndexEntry(row({ content }));
    // First-sentence extraction keeps the secret (it's in sentence 1) but MUST
    // NOT pull in the rest of the body.
    expect(entry.summary).not.toContain('rest of a much longer decision body');
    expect(entry.summary.length).toBeLessThanOrEqual(160);
  });

  it('handles null/undefined content without throwing and without leaking undefined-shaped text', () => {
    const entry = toDecisionIndexEntry(row({ content: null as unknown as string }));
    expect(entry.summary).toBe('');
    expect(JSON.stringify(entry)).not.toMatch(/undefined|null/);
  });
});
