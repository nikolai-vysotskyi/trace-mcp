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

  it('renders long status text cleanly in the header without breaking structure', () => {
    const longError =
      'Cannot set properties of undefined (setting autoDownload) — long status message that wraps across multiple lines';
    const { trigger } = renderMenu({
      update: { available: false, current: '3.10.0', error: longError },
    });
    const header = openMenu(trigger).querySelector('.ws-ctx-header');
    const statusText = header?.querySelector('.status .text');
    expect(statusText?.textContent).toBe(longError);
    expect(statusText?.getAttribute('title')).toBe(longError);
    expect(header?.querySelector('.status')?.className).toContain('is-warn');
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

  /* TRA-450. Theme's row shape, Theme's pill replaced by a pop-up: ten language
     names are words in five scripts, and DESIGN.md puts anything past four
     values on this side of the line. Each entry leads with the language's OWN
     name — never translated — and carries the English name after it so the list
     is navigable by someone who reads none of those scripts. */
  it('offers Language as a pop-up row listing every language the app ships', () => {
    const { trigger } = renderMenu();
    const menu = openMenu(trigger);

    const select = within(menu).getByLabelText('Language') as HTMLSelectElement;
    // One stop for the whole row, and the visible label is not a second name
    // for a screen reader to read out — the control already carries it.
    expect(select.closest('[data-menu-row]')).toBeTruthy();
    expect([...select.options].map((o) => o.value)).toEqual(LOCALES.map((l) => l.code));
    expect([...select.options].map((o) => o.text)).toEqual(
      LOCALES.map((l) => (l.label === l.englishLabel ? l.label : `${l.label} — ${l.englishLabel}`)),
    );
    // English leads because it is the source language; the rest go by code, so
    // no entry's position is a claim about its importance.
    expect(select.options[0].text).toBe('English');
    expect([...select.options].slice(1).map((o) => o.value)).toEqual(
      [...LOCALES].slice(1).map((l) => l.code).sort(),
    );
    expect(select.value).toBe('en');
  });

  it('switches the whole menu at once, without closing it', () => {
    const { trigger } = renderMenu();
    const menu = openMenu(trigger);
    fireEvent.change(within(menu).getByLabelText('Language'), { target: { value: 'ru' } });

    // The control itself, and a neighbour it does not own: the switch is the
    // whole UI, not one label.
    expect(within(menu).getByLabelText('Язык')).toBeTruthy();
    expect(within(menu).getByRole('group', { name: 'Оформление' })).toBeTruthy();
    expect(localStorage.getItem(LOCALE_KEY)).toBe('ru');
    // …and the menu is still open to see it happen.
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  /* A pop-up row has no segments to step through, so it is one stop like any
     other row — and the stop is the control itself, not a checked child. */
  it('makes the Language pop-up a single stop between Theme and the items below', () => {
    const { trigger } = renderMenu();
    const menu = openMenu(trigger);
    const select = within(menu).getByLabelText('Language');

    // Settings, Theme, Language: three downs from nothing focused.
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(select);

    // Down again leaves the row entirely rather than stepping inside it.
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('View changelog');

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
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Language');
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
       — the pill row its checked segment, the pop-up row its select — so up/down
       sees actions + 2. */
    const all = Array.from(
      menu.querySelectorAll<HTMLElement>('[role^="menuitem"], select'),
    ).filter(
      (el) =>
        !el.closest('[data-menu-row]') ||
        el.getAttribute('aria-checked') === 'true' ||
        el.tagName === 'SELECT',
    );
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
