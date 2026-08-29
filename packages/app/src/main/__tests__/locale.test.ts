/* The mirror file is the only thing the main process knows about the language
   (TRA-386): localStorage lives in the renderer, and the application menu is
   built before any window exists. If this file is misread, the whole menu bar
   and the tray come up in the wrong language on every cold launch.

   Shape and cases follow appearance.test.ts — same failure mode, same rules. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Locale } from '../../shared/i18n/locales.js';
import { t } from '../i18n';
import { readLocale, writeLocale } from '../locale';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'trace-mcp-locale-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('locale persistence', () => {
  it('round-trips every language the app ships', () => {
    const dir = tmp();
    for (const l of ['en', 'ru'] as Locale[]) {
      writeLocale(dir, l);
      expect(readLocale(dir)).toBe(l);
    }
  });

  it('reads English when nothing was ever written', () => {
    expect(readLocale(tmp())).toBe('en');
  });

  /* A hand-edited file, or a language dropped from LOCALES in a later release,
     must not leave the menu bar reading raw keys. */
  it('reads English from a file naming a language we do not ship', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'locale'), 'kl', 'utf8');
    expect(readLocale(dir)).toBe('en');
  });

  it('tolerates trailing whitespace', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'locale'), 'ru\n', 'utf8');
    expect(readLocale(dir)).toBe('ru');
  });

  it('never throws on an unwritable directory', () => {
    expect(() => writeLocale('/dev/null/nope', 'ru')).not.toThrow();
  });
});

describe('main-process i18n', () => {
  /* The main process has no react-i18next and no components; a namespaced key
     resolving to itself is what a broken catalogue registration looks like. */
  it('resolves the namespaces the menu and the tray read', () => {
    expect(t('menu:file')).toBe('File');
    expect(t('tray:daemonRunning')).toBe('Daemon running');
  });
});
