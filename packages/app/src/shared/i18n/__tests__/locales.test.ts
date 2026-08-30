/* Which language a cold launch picks, before anyone has chosen one (TRA-450).
   Region-tagged locales are the whole difficulty: `pt` is not `pt-BR`, and
   getting it wrong hands a reader a language they did not ask for while looking
   like it worked. */

import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES, isLocale, pickLocale } from '../locales.js';

describe('LOCALES', () => {
  it('leads with the source language, then goes by code', () => {
    expect(LOCALES[0].code).toBe(DEFAULT_LOCALE);
    const rest = LOCALES.slice(1).map((l) => l.code);
    expect(rest).toEqual([...rest].sort());
  });

  it('carries both names for every entry', () => {
    for (const l of LOCALES) {
      expect(l.label.trim()).not.toBe('');
      expect(l.englishLabel.trim()).not.toBe('');
    }
  });

  it('has no duplicate codes', () => {
    expect(new Set(LOCALES.map((l) => l.code)).size).toBe(LOCALES.length);
  });

  it('accepts only codes it ships', () => {
    expect(isLocale('pt-BR')).toBe(true);
    expect(isLocale('pt')).toBe(false);
    expect(isLocale('zh')).toBe(true);
    expect(isLocale('zh-CN')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe('pickLocale', () => {
  it('matches an exact tag', () => {
    expect(pickLocale(['pt-BR'])).toBe('pt-BR');
    expect(pickLocale(['ja'])).toBe('ja');
  });

  it('is case-insensitive about the region', () => {
    expect(pickLocale(['pt-br'])).toBe('pt-BR');
    expect(pickLocale(['PT-BR'])).toBe('pt-BR');
  });

  it('falls back to the language when the region is one we do not ship', () => {
    expect(pickLocale(['pt-PT'])).toBe('pt-BR');
    expect(pickLocale(['pt'])).toBe('pt-BR');
    expect(pickLocale(['ru-RU'])).toBe('ru');
    // `zh` is deliberately the bare macrolanguage tag, so both scripts land here.
    expect(pickLocale(['zh-CN'])).toBe('zh');
    expect(pickLocale(['zh-TW'])).toBe('zh');
  });

  /* The reason pickLocale runs two passes rather than resolving one tag at a
     time: a reader who listed a second preference gets it, instead of the
     nearest guess at their first. */
  it('prefers a later exact match over an earlier language-only guess', () => {
    expect(pickLocale(['pt-PT', 'en'])).toBe('en');
    expect(pickLocale(['pt-PT', 'es'])).toBe('es');
  });

  it('still guesses when nothing in the list is exact', () => {
    expect(pickLocale(['pt-PT', 'pt-AO'])).toBe('pt-BR');
  });

  it('falls back to English on an empty or unknown list', () => {
    expect(pickLocale([])).toBe('en');
    expect(pickLocale(['tlh', 'xx-YY'])).toBe('en');
  });
});
