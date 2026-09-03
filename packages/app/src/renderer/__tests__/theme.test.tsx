/**
 * @vitest-environment jsdom
 */
/* The bug this locks down (TRA-305): the old toggle only ever wrote 'light' or
 * 'dark', so one click pinned the app forever and the system-appearance
 * listener stopped mattering. Auto must be reachable again, and reaching it
 * must clear the stored key rather than store a third value. */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appearanceOptions, THEME_KEY, useTheme } from '../theme.js';

/** matchMedia is not implemented in jsdom — stand in a controllable one. */
let systemDark = false;
const listeners = new Set<() => void>();

beforeEach(() => {
  systemDark = false;
  listeners.clear();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        media: query,
        get matches() {
          return query.includes('dark') && systemDark;
        },
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  (window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

function setSystem(dark: boolean) {
  systemDark = dark;
  act(() => {
    for (const fn of listeners) fn();
  });
}

describe('useTheme', () => {
  it('offers exactly Auto / Light / Dark', () => {
    expect(appearanceOptions().map((o) => o.value)).toEqual(['auto', 'light', 'dark']);
  });

  it('starts on Auto and follows the system', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.appearance).toBe('auto');
    expect(result.current.theme).toBe('light');

    setSystem(true);
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('pins the appearance when Light or Dark is picked', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setAppearance('light'));

    expect(result.current.theme).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    // Pinned means pinned: the system flipping no longer moves it.
    setSystem(true);
    expect(result.current.theme).toBe('light');
  });

  it('gets back to Auto, and Auto clears the stored key', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setAppearance('dark'));
    act(() => result.current.setAppearance('auto'));

    expect(result.current.appearance).toBe('auto');
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);

    setSystem(true);
    expect(result.current.theme).toBe('dark');
  });

  /* TRA-354: the sidebar's vibrancy is a native view following nativeTheme, so
     an appearance change that stops at [data-theme] left light-mode material
     behind dark-mode text — the sidebar rendered as an empty pale pane. */
  it('tells the main process about the appearance, not just the DOM', () => {
    const setAppearance = vi.fn();
    (window as unknown as { electronAPI: unknown }).electronAPI = { setAppearance };
    const { result } = renderHook(() => useTheme());
    expect(setAppearance).toHaveBeenLastCalledWith('auto');

    act(() => result.current.setAppearance('dark'));
    expect(setAppearance).toHaveBeenLastCalledWith('dark');
  });

  it('restores a stored choice on mount, and ignores junk', () => {
    localStorage.setItem(THEME_KEY, 'dark');
    expect(renderHook(() => useTheme()).result.current.appearance).toBe('dark');

    localStorage.setItem(THEME_KEY, 'aubergine');
    expect(renderHook(() => useTheme()).result.current.appearance).toBe('auto');
  });

  /* TRA-369. [data-theme] is a CSS attribute and the sidebar's material is an
     NSVisualEffectView — CSS cannot reach it. Unless the choice is mirrored to
     the main process, Light on a dark system draws a dark sidebar next to a
     light content pane. Auto has to be mirrored too, or a window pinned to Dark
     stays dark after the user goes back to Auto. */
  it('mirrors every appearance to the native layer', () => {
    const setAppearance = vi.fn();
    vi.stubGlobal('electronAPI', { setAppearance });

    const { result } = renderHook(() => useTheme());
    expect(setAppearance).toHaveBeenLastCalledWith('auto');

    act(() => result.current.setAppearance('light'));
    expect(setAppearance).toHaveBeenLastCalledWith('light');

    act(() => result.current.setAppearance('auto'));
    expect(setAppearance).toHaveBeenLastCalledWith('auto');
  });

  /* The bridge is optional (older preload, and the renderer also runs under the
     dev server), so a missing setAppearance must not take the app down. */
  it('survives a preload without the bridge', () => {
    vi.stubGlobal('electronAPI', undefined);
    expect(() => renderHook(() => useTheme())).not.toThrow();
  });

  /* A real `storage` event fires AFTER the other window's write landed, so the
     test has to move localStorage too — the event is the nudge, not the value. */
  it('syncs from another window, including a clear back to Auto', () => {
    const { result } = renderHook(() => useTheme());
    act(() => {
      localStorage.setItem(THEME_KEY, 'dark');
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY, newValue: 'dark' }));
    });
    expect(result.current.appearance).toBe('dark');

    act(() => {
      localStorage.removeItem(THEME_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY, newValue: null }));
    });
    expect(result.current.appearance).toBe('auto');
  });

  /* TRA-754. TRA-700 split the single useTheme() call into two — the window
     shell keeps `theme` for .ws-stage[data-mode], the tab view keeps
     setAppearance for the toggle — and per-hook useState let them disagree:
     the click moved [data-theme] and localStorage but not [data-mode], so the
     app only picked up the new theme on the next launch. */
  it('every instance in the window sees the same choice', () => {
    const shell = renderHook(() => useTheme());
    const tab = renderHook(() => useTheme());

    act(() => tab.result.current.setAppearance('dark'));
    expect(shell.result.current.appearance).toBe('dark');
    expect(shell.result.current.theme).toBe('dark');

    act(() => tab.result.current.setAppearance('auto'));
    expect(shell.result.current.appearance).toBe('auto');
  });
});
