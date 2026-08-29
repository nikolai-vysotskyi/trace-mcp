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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GLOBAL_ACTIONS } from '../../../shared/global-actions.js';
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
      const item = within(menu).getByRole('menuitem', { name: new RegExp(action.label) });
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

    // …and down again leaves the row entirely, rather than stepping to Dark.
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(row.contains(document.activeElement)).toBe(false);
    expect(document.activeElement?.textContent).toContain("What's new");
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

  it('arrows through the items and wraps', () => {
    const { trigger } = renderMenu({ appearance: 'auto' });
    const menu = openMenu(trigger);
    /* The stop list, not the element list: the Theme row contributes ONE stop
       (its checked segment), so up/down sees actions + 1. */
    const all = Array.from(
      menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
    ).filter((el) => !el.closest('[data-menu-row]') || el.getAttribute('aria-checked') === 'true');
    expect(all.length).toBe(GLOBAL_ACTIONS.length + 1); // + the Theme row

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
