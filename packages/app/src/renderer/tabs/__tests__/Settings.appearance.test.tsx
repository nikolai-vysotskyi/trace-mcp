// @vitest-environment jsdom
//
// Appearance moved out of the sidebar footer and into the Settings screen
// (TRA-306). The footer no longer offers it, so this is now the only surface
// that does — and it has to keep offering all three states even when the
// daemon is unreachable, because the theme lives in localStorage and has
// nothing to do with the daemon.
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCALES, LOCALE_KEY } from '../../../shared/i18n/locales.js';
import { setLocale } from '../../i18n';
import { Settings } from '../Settings';

beforeEach(() => {
  const makeApiProxy = (name = ''): unknown =>
    new Proxy(function () {} as object, {
      get: (_t, prop) => makeApiProxy(typeof prop === 'string' ? prop : ''),
      apply: () => (name.startsWith('on') ? () => undefined : Promise.resolve(undefined)),
    });
  (window as unknown as { electronAPI: unknown }).electronAPI = makeApiProxy();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('daemon down'))),
  );
  vi.stubGlobal(
    'EventSource',
    class {
      close() {}
    },
  );
});

afterEach(() => {
  setLocale('en');
  localStorage.removeItem(LOCALE_KEY);
});

describe('Settings — app preferences', () => {
  it('offers Auto / Light / Dark even with no daemon', () => {
    render(<Settings appearance="auto" onAppearanceChange={() => {}} />);
    const select = screen.getByLabelText('Theme') as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(['Auto', 'Light', 'Dark']);
    expect(select.value).toBe('auto');
  });

  it('reports the picked appearance upwards', () => {
    const onChange = vi.fn();
    render(<Settings appearance="auto" onAppearanceChange={onChange} />);
    const select = screen.getByLabelText('Theme') as HTMLSelectElement;
    select.value = 'dark';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('dark');
  });

  /* TRA-388. The same choice as the app menu's Language row, on the surface
     people go to looking for settings — and with the room for the full names
     rather than the row's two letters. Written in their own language: someone
     hunting for Russian is looking for "Русский". */
  it('offers Language beside Theme, in the languages own names', () => {
    render(<Settings appearance="auto" onAppearanceChange={() => {}} />);
    const select = screen.getByLabelText('Language') as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(LOCALES.map((l) => l.label));
    expect(select.value).toBe('en');
  });

  it('switches the surface at runtime and persists the choice', () => {
    render(<Settings appearance="auto" onAppearanceChange={() => {}} />);
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'ru' } });

    // No prop to report upwards to and no restart: the screen is already Russian.
    expect(screen.getByLabelText('Язык')).toBeTruthy();
    expect(screen.getByLabelText('Тема')).toBeTruthy();
    expect(localStorage.getItem(LOCALE_KEY)).toBe('ru');
  });
});
