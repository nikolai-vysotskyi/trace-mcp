// @vitest-environment jsdom
/* TRA-363. Three promises worth pinning:

   - the footer is ONE row, and that row is a menu trigger. The whole point was
     to stop the bottom of the sidebar growing a row per global action.
   - the menu's actions come from src/shared/global-actions.ts, the same list
     the native application menu builds from. A label typed here instead of
     read from there is the drift this design was supposed to make impossible.
   - it behaves like a menu on the keyboard: arrows move, Escape closes, and
     focus comes back to the trigger instead of landing on <body>. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GLOBAL_ACTIONS } from '../../../shared/global-actions.js';
import { LOCALES, LOCALE_KEY } from '../../../shared/i18n/locales.js';
import { setLocale, t } from '../../i18n';
import type { UpdateState } from '../../update-check.js';
import { AppMenu, type AppMenuProps } from '../AppMenu';

const openExternal = vi.fn();

function renderMenu(props: Partial<AppMenuProps> = {}) {
  const onAppearanceChange = vi.fn();
  const onCheckForUpdate = vi.fn();
  const onSettings = vi.fn();
  const update: UpdateState = { available: false, current: '3.1.1', lastChecked: Date.now() };
  render(
    <AppMenu
      update={update}
      checking={false}
      onCheckForUpdate={onCheckForUpdate}
      appearance="auto"
      onAppearanceChange={onAppearanceChange}
      onSettings={onSettings}
      {...props}
    />,
  );
  const trigger = screen.getByRole('button', { name: /trace-mcp/ });
  return { trigger, onAppearanceChange, onCheckForUpdate, onSettings };
}

function openMenu(trigger: HTMLElement): HTMLElement {
  fireEvent.click(trigger);
  return screen.getByRole('menu');
}

beforeEach(() => {
  openExternal.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = { openExternal };
});

/* The Language row switches for real — there is no store to fake, which is the
   point of it. Put the language back so the rest of the file reads English. */
afterEach(() => {
  setLocale('en');
  localStorage.removeItem(LOCALE_KEY);
});

describe('sidebar app menu', () => {
  it('is one row, and that row says it opens a menu', () => {
    const { trigger } = renderMenu();
    const footer = document.querySelector('.ws-sb-footer');
    expect(footer?.querySelectorAll('.ws-sb-row')).toHaveLength(1);
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens on click and flips aria-expanded', () => {
    const { trigger } = renderMenu();
    openMenu(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  /* The anti-drift test. If someone adds an action to the native menu and
     forgets this one — or relabels one of them — this fails. */
  it('renders every shared global action, with its own label and shortcut', () => {
    const { trigger } = renderMenu();
    const menu = openMenu(trigger);
    for (const action of GLOBAL_ACTIONS) {
      const item = within(menu).getByRole('menuitem', { name: new RegExp(t(action.labelKey)) });
      if (action.shortcut) expect(item.textContent).toContain(action.shortcut);
    }
  });

  it('anchors the menu on the app, not on an account it does not have', () => {
    const { trigger } = renderMenu();
    const menu = openMenu(trigger);
    const header = menu.querySelector('.ws-ctx-header');
    expect(header?.querySelector('.name')?.textContent).toBe('Version 3.1.1');
    expect(header?.querySelector('.status')?.textContent).toContain('Up to date');
    expect(header?.querySelector('.status')?.className).toContain('is-ok');
  });

  it('reports an available update in the header instead of a sidebar row', () => {
    const { trigger } = renderMenu({
      update: { available: true, current: '3.1.1', latest: '3.2.0' },
    });
    const header = openMenu(trigger).querySelector('.ws-ctx-header');
    expect(header?.querySelector('.status')?.textContent).toContain('Version 3.2.0 available');
    expect(header?.querySelector('.status')?.className).toContain('is-info');
  });

  /* Nikolai on the four-row APPEARANCE group: "это оч плохо во всплывашке".
     One labelled row with the switcher inline — and the segments are icon-only,
     so each one's accessible NAME is what has to carry Auto / Light / Dark. */
  it('offers Theme as one labelled row with an inline switcher', () => {
    const { trigger, onAppearanceChange } = renderMenu({ appearance: 'light' });
    const menu = openMenu(trigger);

    const row = within(menu).getByRole('group', { name: 'Theme' });
    expect(row.textContent).toBe('Theme'); // the label, and no item text
    const options = within(row).getAllByRole('menuitemradio');
    expect(options.map((o) => o.getAttribute('aria-label'))).toEqual(['Auto', 'Light', 'Dark']);
    expect(options.map((o) => o.getAttribute('title'))).toEqual(['Auto', 'Light', 'Dark']);
    // Selected, not merely hovered: the state is on the element, not the fill.
    expect(options.map((o) => o.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(options[1].className).toContain('is-active');

    fireEvent.click(options[2]);
    expect(onAppearanceChange).toHaveBeenCalledWith('dark');
    // Picking a theme does NOT close the menu — the point of an inline
    // switcher is watching the app change under it.
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it('is one Tab stop, entered on the current value', () => {
    const { trigger } = renderMenu({ appearance: 'dark' });
    const row = within(openMenu(trigger)).getByRole('group', { name: 'Theme' });
    const options = within(row).getAllByRole('menuitemradio');
    expect(options.map((o) => o.tabIndex)).toEqual([-1, -1, 0]);
  });

  /* TRA-388. Same row shape as Theme, with the one difference the values force:
     a language name is a word, so the segments carry the two-letter form and
     the full name — written in its OWN language, never translated — is the
     accessible name and the tooltip. */
  it('offers Language as one labelled row whose segments are words', () => {
    const { trigger } = renderMenu();
    const row = within(openMenu(trigger)).getByRole('group', { name: 'Language' });

    /* Read from LOCALES rather than spelled out: shipping a language is a
       one-line change there (TRA-389), and a test that has to be edited
       alongside it is a test that gets edited without being read. */
    const options = within(row).getAllByRole('menuitemradio');
    expect(options.map((o) => o.textContent)).toEqual(LOCALES.map((l) => l.short));
    expect(options.map((o) => o.getAttribute('aria-label'))).toEqual(LOCALES.map((l) => l.label));
    expect(options.map((o) => o.getAttribute('title'))).toEqual(LOCALES.map((l) => l.label));
    expect(options.map((o) => o.getAttribute('aria-checked'))).toEqual(
      LOCALES.map((l) => String(l.code === 'en')),
    );
    expect(options[0].className).toContain('is-active');
    // The track says it holds words, which is what island.css keys the padding
    // and the full-strength unselected colour off.
    expect(row.querySelector('.ws-ctx-seg')?.className).toContain('is-text');
    expect(options.map((o) => o.tabIndex)).toEqual(LOCALES.map((_, i) => (i === 0 ? 0 : -1)));
  });

  it('switches the whole menu at once, without closing it', () => {
    const { trigger } = renderMenu();
    const menu = openMenu(trigger);
    const row = within(menu).getByRole('group', { name: 'Language' });

    fireEvent.click(within(row).getByRole('menuitemradio', { name: 'Русский' }));

    // The row it lives in, and a neighbour it does not own: the switch is the
    // whole UI, not one label.
    expect(within(menu).getByRole('group', { name: 'Язык' })).toBeTruthy();
    expect(within(menu).getByRole('group', { name: 'Оформление' })).toBeTruthy();
    expect(localStorage.getItem(LOCALE_KEY)).toBe('ru');
    // …and the menu is still open to see it happen.
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it('moves within the Language row on left/right and past it on down', () => {
    const { trigger } = renderMenu();
    const menu = openMenu(trigger);
    const checked = within(menu).getByRole('menuitemradio', { name: 'English' });

    // The neighbour is whichever language LOCALES lists second, not Russian by
    // name — the list grows (TRA-389) and this test is about the arrow keys.
    const next = LOCALES[1];
    fireEvent.keyDown(checked, { key: 'ArrowRight' });
    expect(within(menu).getByRole('menuitemradio', { name: next.label })).toBeTruthy();

    fireEvent.keyDown(within(menu).getByRole('menuitemradio', { name: next.label }), {
      key: 'ArrowLeft',
    });
    expect(within(menu).getByRole('group', { name: 'Language' })).toBeTruthy();

    // Down out of the row reaches the items below, not the next segment.
    fireEvent.keyDown(document, { key: 'End' });
    expect(document.activeElement?.textContent).toContain('Check for updates');
  });

  /* The hard part Lead Engineer called out: two axes in one menu. Up/down has
     to keep moving between rows while left/right moves inside the switcher. */
  it('moves within the switcher on left/right and out of it on up/down', () => {
    const onAppearanceChange = vi.fn();
    const { trigger } = renderMenu({ appearance: 'light', onAppearanceChange });
    const menu = openMenu(trigger);
    const row = within(menu).getByRole('group', { name: 'Theme' });
    const checked = within(row).getByRole('menuitemradio', { name: 'Light' });

    // Down from Settings lands on the row's CHECKED segment, once — not once
    // per segment.
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(checked);

    fireEvent.keyDown(checked, { key: 'ArrowRight' });
    expect(onAppearanceChange).toHaveBeenLastCalledWith('dark');
    fireEvent.keyDown(checked, { key: 'ArrowLeft' });
    expect(onAppearanceChange).toHaveBeenLastCalledWith('auto');

    // …and down again leaves the row entirely, rather than stepping to Dark:
    // the next stop is the Language row, then the first real item after it.
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(row.contains(document.activeElement)).toBe(false);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('English');
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('View changelog');
  });

  it('runs the commands and opens the links', () => {
    const { trigger, onSettings, onCheckForUpdate } = renderMenu();
    fireEvent.click(within(openMenu(trigger)).getByRole('menuitem', { name: /Settings/ }));
    expect(onSettings).toHaveBeenCalled();

    fireEvent.click(within(openMenu(trigger)).getByRole('menuitem', { name: /Get help/ }));
    expect(openExternal).toHaveBeenCalledWith(
      'https://github.com/nikolai-vysotskyi/trace-mcp/issues',
    );

    fireEvent.click(within(openMenu(trigger)).getByRole('menuitem', { name: /Check for updates/ }));
    expect(onCheckForUpdate).toHaveBeenCalled();
  });

  /* TRA-376. "Check for updates…" acts on the app; the two above it leave for
     a browser. It sat flush under "Get help" as if it were a third GitHub page.
     Pinned by position, not by count, so adding a fourth link cannot quietly
     re-merge the groups. */
  it('separates the action on the app from the links that leave it', () => {
    const { trigger } = renderMenu();
    const menu = openMenu(trigger);
    const check = within(menu).getByRole('menuitem', { name: /Check for updates/ });
    expect(check.previousElementSibling?.getAttribute('role')).toBe('separator');

    const help = within(menu).getByRole('menuitem', { name: /Get help/ });
    const changelog = within(menu).getByRole('menuitem', { name: /View changelog/ });
    expect(help.previousElementSibling).toBe(changelog);
  });

  it('arrows through the items and wraps', () => {
    const { trigger } = renderMenu({ appearance: 'auto' });
    const menu = openMenu(trigger);
    /* The stop list, not the element list: each choice row contributes ONE stop
       (its checked segment), so up/down sees actions + 2. */
    const all = Array.from(
      menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
    ).filter((el) => !el.closest('[data-menu-row]') || el.getAttribute('aria-checked') === 'true');
    expect(all.length).toBe(GLOBAL_ACTIONS.length + 2); // + Theme and Language

    // Nothing is highlighted until the first arrow — a macOS menu does not
    // preselect its first item.
    expect(document.activeElement).not.toBe(all[0]);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(all[1]);
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(all[all.length - 1]);
    fireEvent.keyDown(document, { key: 'End' });
    expect(document.activeElement).toBe(all[all.length - 1]);
    fireEvent.keyDown(document, { key: 'Home' });
    expect(document.activeElement).toBe(all[0]);
  });

  it('closes on Escape and gives focus back to the trigger', () => {
    const { trigger } = renderMenu();
    trigger.focus();
    openMenu(trigger);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).not.toBe(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
