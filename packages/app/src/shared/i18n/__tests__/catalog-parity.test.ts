/* A translation catalogue rots by omission: a slice adds a key to en/ and the
   other languages silently fall back, which looks fine in English and ships a
   half-translated screen everywhere else. This is the check that fails first.

   Plural suffixes are compared by base key, not literally: Russian legitimately
   has `_few`/`_many` where English has only `_one`/`_other`. */

import { describe, expect, it } from 'vitest';
import { CATALOGS, en } from '../catalog/index.js';
import { LOCALES } from '../locales.js';

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function baseKeys(catalog: Record<string, Record<string, string>>): Set<string> {
  const out = new Set<string>();
  for (const [ns, strings] of Object.entries(catalog)) {
    for (const key of Object.keys(strings)) out.add(`${ns}:${key.replace(PLURAL_SUFFIX, '')}`);
  }
  return out;
}

describe('translation catalogues', () => {
  const source = baseKeys(en);

  it('ships a catalogue for every locale the app offers', () => {
    for (const locale of LOCALES) expect(CATALOGS[locale.code]).toBeDefined();
  });

  for (const locale of LOCALES.filter((l) => l.code !== 'en')) {
    it(`${locale.code} covers every English key and adds none of its own`, () => {
      const theirs = baseKeys(CATALOGS[locale.code]);
      expect([...source].filter((k) => !theirs.has(k))).toEqual([]);
      expect([...theirs].filter((k) => !source.has(k))).toEqual([]);
    });
  }

  /* The check above compares BASE keys, so it is blind to the form that
     matters: a Spanish catalogue with only `_one`/`_other` passes it, and then
     renders the English string at exactly 1 000 000 because i18next asked for
     `_many`, missed, and fell through to fallbackLng. Every language must carry
     precisely the plural categories CLDR gives it — no fewer, so nothing falls
     back, and no more, so a form that can never be selected does not sit there
     looking translated (TRA-450). */
  const PLURAL_ONLY = /_(zero|one|two|few|many|other)$/;
  for (const locale of LOCALES) {
    it(`${locale.code} carries exactly its CLDR plural forms`, () => {
      const expected = [...new Intl.PluralRules(locale.code).resolvedOptions().pluralCategories];
      const theirs = CATALOGS[locale.code];
      for (const [ns, strings] of Object.entries(en)) {
        const bases = new Set(
          Object.keys(strings)
            .filter((k) => PLURAL_ONLY.test(k))
            .map((k) => k.replace(PLURAL_SUFFIX, '')),
        );
        for (const base of bases) {
          const forms = Object.keys(theirs[ns] ?? {})
            .filter((k) => PLURAL_ONLY.test(k) && k.replace(PLURAL_SUFFIX, '') === base)
            .map((k) => (PLURAL_ONLY.exec(k) as RegExpExecArray)[1]);
          expect([...forms].sort(), `${locale.code}/${ns}:${base}`).toEqual([...expected].sort());
        }
      }
    });
  }

  it('leaves no string empty', () => {
    for (const [code, catalog] of Object.entries(CATALOGS)) {
      for (const [ns, strings] of Object.entries(catalog)) {
        for (const [key, value] of Object.entries(strings)) {
          expect(value.trim(), `${code}/${ns}:${key}`).not.toBe('');
        }
      }
    }
  });

  /* An interpolation the translator dropped is a placeholder rendered blank —
     "Ещё установок npm устарели". Cheap to catch, invisible in review. */
  it('keeps the same interpolation placeholders as English', () => {
    const placeholders = (s: string): string[] =>
      [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    for (const [code, catalog] of Object.entries(CATALOGS)) {
      if (code === 'en') continue;
      for (const [ns, strings] of Object.entries(catalog)) {
        for (const [key, value] of Object.entries(strings)) {
          const base = key.replace(PLURAL_SUFFIX, '');
          const englishForms = Object.entries(en[ns as keyof typeof en] ?? {}).filter(
            ([k]) => k.replace(PLURAL_SUFFIX, '') === base,
          );
          const allowed = new Set(englishForms.flatMap(([, v]) => placeholders(v)));
          for (const p of placeholders(value)) {
            // `count` is supplied by i18next itself for plural keys.
            if (p === 'count') continue;
            expect(allowed.has(p), `${code}/${ns}:${key} interpolates {{${p}}}`).toBe(true);
          }
        }
      }
    }
  });
});
