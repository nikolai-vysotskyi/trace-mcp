// @vitest-environment jsdom
/* The runtime contract: a language switch changes strings, plurals and Intl
   output together, and nothing has to restart for it. */

import { afterEach, describe, expect, it } from 'vitest';
import { LOCALE_KEY } from '../../../shared/i18n/locales.js';
import { currentLocale, i18next, initialLocale, setLocale, t } from '../index.js';
import { formatDate, formatNumber, relativeTime } from '../format.js';
import { describeStaleRoots, formatAgo } from '../../update-check.js';

const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);

afterEach(() => {
  setLocale('en');
  localStorage.removeItem(LOCALE_KEY);
});

describe('locale selection', () => {
  it('prefers the stored choice over the system language', () => {
    localStorage.setItem(LOCALE_KEY, 'ru');
    expect(initialLocale()).toBe('ru');
  });

  it('ignores a stored value that is not a language we ship', () => {
    localStorage.setItem(LOCALE_KEY, 'tlh');
    expect(initialLocale()).toBe('en');
  });

  it('switches at runtime and persists the choice', () => {
    setLocale('ru');
    expect(currentLocale()).toBe('ru');
    expect(localStorage.getItem(LOCALE_KEY)).toBe('ru');
    expect(document.documentElement.getAttribute('lang')).toBe('ru');
  });
});

describe('plurals', () => {
  /* The whole reason for a library rather than a lookup table: 1 / 3 / 7 land
     on three different Russian forms and on only two English ones.

     The fixture is test-owned rather than a product key. It used to be
     `update:staleRoots`, which stopped being plural when TRA-377 narrowed that
     warning to the single root MCP clients run — and no shipped string should
     have to stay plural just to keep this property covered. */
  i18next.addResourceBundle('en', 'test', {
    files_one: '{{count}} file',
    files_other: '{{count}} files',
  });
  i18next.addResourceBundle('ru', 'test', {
    files_one: '{{count}} файл',
    files_few: '{{count}} файла',
    files_many: '{{count}} файлов',
    files_other: '{{count}} файла',
  });
  const forms = (count: number): string => t('test:files', { count });

  it('uses English one/other', () => {
    expect(forms(1)).toBe('1 file');
    expect(forms(3)).toBe('3 files');
    expect(forms(7)).toBe('7 files');
  });

  it('uses Russian one/few/many', () => {
    setLocale('ru');
    expect(forms(1)).toBe('1 файл');
    expect(forms(3)).toBe('3 файла');
    expect(forms(7)).toBe('7 файлов');
  });
});

describe('Intl formatting follows the language', () => {
  it('formats relative time', () => {
    expect(relativeTime(NOW - 7_200_000, NOW)).toBe('2 hours ago');
    setLocale('ru');
    expect(relativeTime(NOW - 7_200_000, NOW)).toBe('2 часа назад');
    expect(relativeTime(NOW - 18_000_000, NOW)).toBe('5 часов назад');
  });

  it('clamps a future timestamp instead of rendering "in 3 seconds"', () => {
    expect(relativeTime(NOW + 3_000, NOW)).toBe('0 seconds ago');
  });

  it('formats numbers and dates', () => {
    expect(formatNumber(1234567.5)).toBe('1,234,567.5');
    setLocale('ru');
    // Non-breaking space in ru grouping — compare on the digits, not the gap.
    expect(formatNumber(1234567.5).replace(/\s/g, ' ')).toBe('1 234 567,5');
    expect(formatDate(NOW, { year: 'numeric', month: '2-digit', day: '2-digit' })).toBe(
      '29.08.2026',
    );
  });
});

describe('update-check strings', () => {
  it('says "never" in the active language', () => {
    expect(formatAgo(undefined)).toBe('never');
    setLocale('ru');
    expect(formatAgo(undefined)).toBe('никогда');
  });

  it('formats the last check compactly, in a form Russian survives', () => {
    expect(formatAgo(NOW - 7_200_000, NOW)).toBe('2 hr. ago');
    setLocale('ru');
    expect(formatAgo(NOW - 7_200_000, NOW)).toBe('2 ч назад');
  });

  it('translates the stale-root warning, install and command included', () => {
    const root = '/a/lib/node_modules';
    const en = describeStaleRoots([{ root, version: '2.9.0' }]);
    expect(en.label).toBe('MCP clients still run v2.9.0');
    expect(en.title).toContain(`${root}/trace-mcp`);
    expect(en.title).toContain(en.command);

    setLocale('ru');
    const ru = describeStaleRoots([{ root, version: '2.9.0' }]);
    expect(ru.label).toBe('MCP-клиенты работают на v2.9.0');
    expect(ru.title).toContain(`${root}/trace-mcp`);
    expect(ru.title).toContain(ru.command);
  });
});
