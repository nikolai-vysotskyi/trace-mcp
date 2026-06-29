import { describe, expect, it } from 'vitest';
import type { DecisionRow } from '../../src/memory/decision-types.js';
import { toDecisionIndexEntry } from '../../src/memory/decision-index.js';

function row(over: Partial<DecisionRow>): DecisionRow {
  return {
    id: 7,
    title: 'Adopt argon2id for password hashing',
    content:
      'We moved from bcrypt to argon2id because argon2id resists GPU cracking ' +
      'better and the OWASP guidance now recommends it. Cost params: m=19MiB, t=2, p=1. ' +
      'This sentence should not appear in the one-line summary.',
    type: 'tech_choice',
    project_root: '/p',
    service_name: 'auth',
    symbol_id: 'src/auth.ts::hash#function',
    file_path: 'src/auth.ts',
    tags: '["auth","security"]',
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

describe('toDecisionIndexEntry — progressive disclosure (Task 12)', () => {
  it('omits the full content field entirely', () => {
    const entry = toDecisionIndexEntry(row({}));
    expect(entry).not.toHaveProperty('content');
  });

  it('keeps id, title, type and code anchors', () => {
    const entry = toDecisionIndexEntry(row({}));
    expect(entry.id).toBe(7);
    expect(entry.title).toBe('Adopt argon2id for password hashing');
    expect(entry.type).toBe('tech_choice');
    expect(entry.symbol_id).toBe('src/auth.ts::hash#function');
    expect(entry.file_path).toBe('src/auth.ts');
  });

  it('derives a short ~1-line summary from the first sentence of content', () => {
    const entry = toDecisionIndexEntry(row({}));
    expect(entry.summary).toBeTruthy();
    // First sentence only — the trailing decoy sentence is dropped.
    expect(entry.summary).not.toContain('should not appear');
    // Bounded length so it stays ~1 line.
    expect((entry.summary ?? '').length).toBeLessThanOrEqual(160);
  });

  it('truncates a very long single-sentence content with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const entry = toDecisionIndexEntry(row({ content: long }));
    expect((entry.summary ?? '').length).toBeLessThanOrEqual(160);
    expect(entry.summary?.endsWith('…')).toBe(true);
  });

  it('parses tags from the JSON column into an array', () => {
    const entry = toDecisionIndexEntry(row({}));
    expect(entry.tags).toEqual(['auth', 'security']);
  });

  it('handles empty / null content without throwing', () => {
    const entry = toDecisionIndexEntry(row({ content: '' }));
    expect(entry.summary).toBe('');
  });

  it('preserves verification/stale annotations when present', () => {
    const annotated = { ...row({}), verification: 'symbol_missing', stale: true } as DecisionRow & {
      verification: string;
      stale: boolean;
    };
    const entry = toDecisionIndexEntry(annotated);
    expect(entry.verification).toBe('symbol_missing');
    expect(entry.stale).toBe(true);
  });
});
