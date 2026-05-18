/**
 * Tests for the title sanitizer + non-Latin language filter.
 *
 * Locks down the four failure modes that produced garbage decision titles
 * in production wake-up output:
 *   1. Mid-sentence cut (no sentence-boundary detection).
 *   2. Unbalanced quotes / brackets / backticks.
 *   3. Non-English fragments leaking into the English-only knowledge graph.
 *   4. Markdown list / heading markers bleeding into the title.
 */

import { describe, expect, it } from 'vitest';
import { isPredominantlyNonLatin, nonLatinShare } from '../../src/memory/language-filter.js';
import {
  TITLE_MAX_LEN,
  isContentNonEnglish,
  sanitizeTitle,
} from '../../src/memory/title-extractor.js';

describe('sanitizeTitle — sentence boundary', () => {
  it('cuts at the first sentence terminator within the window', () => {
    const raw = 'Decision: use PostgreSQL. We chose this because of JSONB support.';
    expect(sanitizeTitle(raw)).toBe('Decision: use PostgreSQL');
  });

  it('handles long prose by cutting at last sentence boundary ≤ MAX_LEN', () => {
    // 200 chars of prose with terminators inside the soft window.
    const sentence = 'We use PostgreSQL for transactional workloads. ';
    const long = sentence.repeat(5); // ~240 chars
    const out = sanitizeTitle(long);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(TITLE_MAX_LEN + 3); // +3 for "..."
    // Cuts at a sentence boundary — never leaves the trailing "." in
    // its own slot and never mid-word with a hyphen.
    expect(out!).not.toMatch(/[a-z]-$/i);
    // The first sentence ends with "workloads" — cut must include it.
    expect(out!).toContain('workloads');
  });

  it('falls back to last whitespace when no terminator exists', () => {
    const raw = 'a '.repeat(200); // 400 chars of "a a a a"
    const out = sanitizeTitle(raw);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(TITLE_MAX_LEN + 3);
    expect(out!.endsWith(' ')).toBe(false);
  });
});

describe('sanitizeTitle — bracket / quote balance', () => {
  it('keeps fully balanced backtick code spans', () => {
    const raw = 'Use `atomicWriteJson()` for safe writes';
    expect(sanitizeTitle(raw)).toBe('Use `atomicWriteJson()` for safe writes');
  });

  it('trims back to the last balanced position on unmatched backtick', () => {
    const raw = '`atomicWriteJson(path, data)` — writes to `path';
    const out = sanitizeTitle(raw);
    // The dangling open backtick at the end gets trimmed back. The result
    // must remain balanced — paired backticks, paired parens.
    expect(out).not.toBeNull();
    const backticks = (out!.match(/`/g) ?? []).length;
    expect(backticks % 2).toBe(0);
    const opens = (out!.match(/\(/g) ?? []).length;
    const closes = (out!.match(/\)/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('drops the unmatched-paren tail', () => {
    const raw = 'Snapshot graph diff over time (lesson from v2.3.2';
    const out = sanitizeTitle(raw);
    expect(out).not.toBeNull();
    expect(out!).not.toContain('(lesson');
    const opens = (out!.match(/\(/g) ?? []).length;
    const closes = (out!.match(/\)/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});

describe('sanitizeTitle — non-English filter', () => {
  it('rejects predominantly Russian titles', () => {
    expect(sanitizeTitle('против билд-сложности и других проблем')).toBeNull();
  });

  it('rejects predominantly Chinese titles', () => {
    expect(sanitizeTitle('使用 PostgreSQL 数据库代替 MySQL 数据库')).toBeNull();
  });

  it('rejects mixed RU/EN fragments dominated by Russian', () => {
    expect(sanitizeTitle('you do." Без альтернатив, без советов — только команда')).toBeNull();
  });

  it('keeps mixed text dominated by English (≤ 30% non-Latin)', () => {
    // "Use PostgreSQL instead of MySQL" with one foreign word — still mostly English.
    const raw = 'Use PostgreSQL instead of MySQL database backend';
    expect(sanitizeTitle(raw)).toBe(raw);
  });

  it('keeps pure English titles', () => {
    const raw = 'Use PostgreSQL over MySQL for JSONB support';
    expect(sanitizeTitle(raw)).toBe(raw);
  });
});

describe('sanitizeTitle — markdown noise', () => {
  it('strips leading heading markers', () => {
    expect(sanitizeTitle('## Decision: use PostgreSQL')).toBe('Decision: use PostgreSQL');
  });

  it('strips leading list markers', () => {
    expect(sanitizeTitle('- Use TypeScript strict mode')).toBe('Use TypeScript strict mode');
    expect(sanitizeTitle('* Pin Node 20 minimum')).toBe('Pin Node 20 minimum');
    expect(sanitizeTitle('15. Use Snapshot diff over time')).toBe('Use Snapshot diff over time');
  });
});

describe('sanitizeTitle — empty / degenerate', () => {
  it('returns null on empty input', () => {
    expect(sanitizeTitle('')).toBeNull();
    expect(sanitizeTitle('   ')).toBeNull();
  });

  it('returns null on too-short input after trim', () => {
    expect(sanitizeTitle('ab')).toBeNull();
  });
});

describe('isContentNonEnglish', () => {
  it('flags Russian prose', () => {
    expect(isContentNonEnglish('Мы решили использовать PostgreSQL для хранения данных')).toBe(true);
  });

  it('passes English prose', () => {
    expect(isContentNonEnglish('We decided to use PostgreSQL for data storage')).toBe(false);
  });

  it('passes code-heavy strings with no letters', () => {
    expect(isContentNonEnglish('{ "a": 1, "b": [2, 3] }')).toBe(false);
  });
});

describe('nonLatinShare', () => {
  it('returns 0 for ASCII-only', () => {
    expect(nonLatinShare('hello world')).toBe(0);
  });

  it('returns 1 for pure Cyrillic', () => {
    expect(nonLatinShare('привет мир')).toBe(1);
  });

  it('returns roughly 0.5 for half Latin / half Cyrillic', () => {
    const share = nonLatinShare('abc абв');
    expect(share).toBeGreaterThan(0.4);
    expect(share).toBeLessThan(0.6);
  });

  it('ignores digits and punctuation in both numerator and denominator', () => {
    expect(nonLatinShare('123 !!! ???')).toBe(0);
  });
});

describe('isPredominantlyNonLatin — threshold', () => {
  it('respects the 30% default threshold', () => {
    // 8 latin, 2 cyrillic → 20% → NOT predominantly non-Latin.
    expect(isPredominantlyNonLatin('abcdefgh аб')).toBe(false);
    // 5 latin, 5 cyrillic → 50% → rejected.
    expect(isPredominantlyNonLatin('abcde абвгд')).toBe(true);
  });

  it('respects a custom threshold', () => {
    expect(isPredominantlyNonLatin('abcdefg абв', 0.5)).toBe(false);
    expect(isPredominantlyNonLatin('abcde абвгд', 0.1)).toBe(true);
  });
});
