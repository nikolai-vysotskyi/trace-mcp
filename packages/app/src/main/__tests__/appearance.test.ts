import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Appearance,
  parseAppearance,
  readAppearance,
  themeSourceFor,
  writeAppearance,
} from '../appearance';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'trace-mcp-appearance-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseAppearance', () => {
  it('keeps the two explicit choices', () => {
    expect(parseAppearance('light')).toBe('light');
    expect(parseAppearance('dark')).toBe('dark');
  });

  /* Same rule as the renderer: absence of a stored value IS Auto, so there is
     no third value to write and no way to get stuck on a bogus override. */
  it('treats anything else as Auto', () => {
    for (const raw of ['auto', '', 'Light', 'system', null, undefined, 7, {}]) {
      expect(parseAppearance(raw)).toBe('auto');
    }
  });
});

describe('themeSourceFor', () => {
  it('maps the app choice onto nativeTheme.themeSource', () => {
    expect(themeSourceFor('auto')).toBe('system');
    expect(themeSourceFor('light')).toBe('light');
    expect(themeSourceFor('dark')).toBe('dark');
  });

  /* The whole defect TRA-369 fixes: 'system' is what the native layer already
     did on its own, so Light and Dark must never resolve to it. */
  it('never sends an explicit choice back to the system appearance', () => {
    for (const a of ['light', 'dark'] as Appearance[]) {
      expect(themeSourceFor(a)).not.toBe('system');
    }
  });
});

describe('appearance persistence', () => {
  it('round-trips every choice', () => {
    const dir = tmp();
    for (const a of ['light', 'dark', 'auto'] as Appearance[]) {
      writeAppearance(dir, a);
      expect(readAppearance(dir)).toBe(a);
    }
  });

  it('reads Auto when nothing was ever written', () => {
    expect(readAppearance(tmp())).toBe('auto');
  });

  /* A hand-edited or half-written file must not pin the window to a material
     the app never chose. */
  it('reads Auto from a corrupt file', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'appearance'), 'lig', 'utf8');
    expect(readAppearance(dir)).toBe('auto');
  });

  it('tolerates trailing whitespace', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'appearance'), 'dark\n', 'utf8');
    expect(readAppearance(dir)).toBe('dark');
  });

  /* Persisting is best-effort: a theme switch still has to work when userData
     cannot be written. */
  it('never throws on an unwritable directory', () => {
    expect(() => writeAppearance('/dev/null/nope', 'dark')).not.toThrow();
  });
});
