/* Which language a cold launch picks, before anyone has chosen one (TRA-450).
   Region-tagged locales are the whole difficulty: `pt` is not `pt-BR` and
   `zh-TW` is emphatically not `zh-CN`, and getting either wrong hands a reader
   a language they did not ask for while looking like it worked. */

import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES, isLocale, pickLocale } from '../locales.js';

describe('LOCALES', () => {
  it('leads with the source language and carries both names for each entry', () => {
    expect(LOCALES[0].code).toBe(DEFAULT_LOCALE);
    for (const l of LOCALES) {
      expect(l.label.trim()).not.toBe('');
      expect(l.englishLabel.trim()).not.toBe('');
    }
  });

  it('has no duplicate codes', () => {
    expect(new Set(LOCALES.map((l) => l.code)).size).toBe(LOCALES.length);
  });

  it('accepts only codes it ships', () => {
    expect(isLocale('zh-CN')).toBe(true);
    expect(isLocale('zh-TW')).toBe(false);
    expect(isLocale('zh')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe('pickLocale', () => {
  it('matches an exact tag', () => {
    expect(pickLocale(['pt-BR'])).toBe('pt-BR');
    expect(pickLocale(['zh-CN'])).toBe('zh-CN');
  });

  it('is case-insensitive about the region', () => {
    expect(pickLocale(['pt-br'])).toBe('pt-BR');
    expect(pickLocale(['ZH-cn'])).toBe('zh-CN');
  });

  it('falls back to the language when the region is one we do not ship', () => {
    expect(pickLocale(['pt-PT'])).toBe('pt-BR');
    expect(pickLocale(['pt'])).toBe('pt-BR');
    expect(pickLocale(['zh-TW'])).toBe('zh-CN');
    expect(pickLocale(['ru-RU'])).toBe('ru');
  });

  /* The reason pickLocale runs two passes rather than resolving one tag at a
     time: a reader who listed a second preference gets it, instead of the
     nearest guess at their first. */
  it('prefers a later exact match over an earlier language-only guess', () => {
    expect(pickLocale(['zh-TW', 'en'])).toBe('en');
    expect(pickLocale(['pt-PT', 'es'])).toBe('es');
  });

  it('still guesses when nothing in the list is exact', () => {
    expect(pickLocale(['zh-TW', 'zh-HK'])).toBe('zh-CN');
  });

  it('falls back to English on an empty or unknown list', () => {
    expect(pickLocale([])).toBe('en');
    expect(pickLocale(['tlh', 'xx-YY'])).toBe('en');
  });
});
