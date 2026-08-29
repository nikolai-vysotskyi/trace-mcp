/* global-actions.ts — the app's global actions, defined ONCE (TRA-363).

   These four reach the user from two places: the native application menu
   (main/menu.ts, TRA-297) and the sidebar's app menu (renderer AppMenu). That
   is the normal cross-platform arrangement — the menu bar is their native home
   on macOS, and a Windows or Linux user finds them where the app's own chrome
   puts them — but two hand-maintained lists drift: a relabelled item, a moved
   shortcut, an action added to one surface and forgotten in the other.

   So neither surface owns a label or a key. This file does, and both read it.
   The main process turns each entry into a MenuItemConstructorOptions; the
   renderer turns it into a MenuItem. Only presentation differs: the native menu
   draws no icons and needs an Electron accelerator string, the in-app menu
   draws a Lattice glyph and a ⌘-hint.

   It deliberately lives outside both `main/` and `renderer/` — the process that
   imports it is not allowed to matter, so it holds data and nothing else. No
   `electron` import, no DOM, no React.

   Appearance is NOT here. It is a preference with three states, not a command,
   and it exists only in the in-app menu and Settings — a list with one member
   cannot drift. */

export type GlobalActionId = 'settings' | 'check-for-update' | 'view-changelog' | 'get-help';

export interface GlobalAction {
  /** Also the `app-command` name the native menu sends to the focused window. */
  id: GlobalActionId;
  label: string;
  /** Electron accelerator for the application menu. */
  accelerator?: string;
  /** The same key drawn as a macOS glyph, for the in-app menu's hint column. */
  shortcut?: string;
  /** Present when the action opens a page instead of dispatching a command. */
  url?: string;
  /** Lattice glyph name. The native menu ignores it. */
  icon: string;
}

/** Order here is the order the in-app menu renders them in. */
export const GLOBAL_ACTIONS: readonly GlobalAction[] = [
  {
    id: 'settings',
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    shortcut: '⌘,',
    icon: 'settings',
  },
  /* "View changelog", not "What's new": the item opens the releases page, and
     someone checking whether a specific fix shipped searches for the word
     "changelog". The glyph is the rolled sheet from the reference Nikolai gave
     — not sparkles, and not the plain page that replaced them (TRA-376). */
  {
    id: 'view-changelog',
    label: 'View changelog',
    url: 'https://github.com/nikolai-vysotskyi/trace-mcp/releases',
    icon: 'scroll',
  },
  /* A question mark, not a speech bubble: this opens GitHub issues, and a
     speech bubble would promise a person on the other end. */
  {
    id: 'get-help',
    label: 'Get help',
    url: 'https://github.com/nikolai-vysotskyi/trace-mcp/issues',
    icon: 'help',
  },
  {
    id: 'check-for-update',
    label: 'Check for updates…',
    icon: 'refresh',
  },
];

export function globalAction(id: GlobalActionId): GlobalAction {
  const found = GLOBAL_ACTIONS.find((a) => a.id === id);
  // Unreachable through the type, but a silently missing menu item is exactly
  // the failure this file exists to prevent — say so instead of rendering less.
  if (!found) throw new Error(`no global action "${id}"`);
  return found;
}
