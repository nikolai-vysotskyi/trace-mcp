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

  /* `kpiDeltaCaption` shares one 26px, two-line box with the arrow and the
     value ("↑+105.6k ") and with whatever `relativeTime` returns ("59 минут
     назад"), in a tile 145–225px wide. Only the wording around `{{when}}` is
     ours to spend, and Russian spent 16 characters of it on "по сравнению с: "
     — four lines of caption under a one-line number, and a 138px tile where
     `TILE_H` says 112 (TRA-464).

     ponytail: a character budget, not a rendered measurement — jsdom cannot
     wrap text. Measured on the running Electron window at 1280×800, where the
     tile is 158px: 22 characters of caption fit two lines, 38 need three. */
  it('keeps the KPI delta caption short enough for two lines', () => {
    for (const [code, catalog] of Object.entries(CATALOGS)) {
      const affix = catalog.workspace.kpiDeltaCaption.replace('{{when}}', '');
      const label = `${code}/workspace:kpiDeltaCaption ${JSON.stringify(affix)}`;
      expect([...affix].length, label).toBeLessThanOrEqual(14);
    }
  });

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

  /* Parity guarantees the key exists, not that anyone translated it. The way
     that shows up is a Latin word marooned in a Devanagari sentence: the Hindi
     workspace read "कोई सिक्योरिटी findings नहीं" on the KPI strip and
     "Workspace" in the sidebar, both of which parity called fine (TRA-803).

     Scoped to the two words this pass settled, and to the surfaces they appear
     on, rather than to every Latin word in `hi` — the catalogue still leaves
     "decisions", "corpus" and the nav labels in English, which is a translation
     backlog, not a regression. */
  it('keeps the settled Hindi terms out of English (TRA-803)', () => {
    const surfaces = ['workspace', 'shell', 'tray', 'overview', 'ask'] as const;
    for (const ns of surfaces) {
      for (const [key, value] of Object.entries(CATALOGS.hi[ns])) {
        expect(/findings?\b/i.test(value), `hi/${ns}:${key} — "${value}"`).toBe(false);
        expect(/\bworkspace\b/i.test(value), `hi/${ns}:${key} — "${value}"`).toBe(false);
      }
    }
  });
});
