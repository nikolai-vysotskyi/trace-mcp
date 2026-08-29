/* The native application menu (main/menu.ts) and the four shared global actions
   the in-app menu draws from the same list. Wording is unchanged from those two
   files — this namespace moved the strings, it did not rewrite them.

   Standard macOS items (About, Services, Hide, Quit, the Edit roles, the zoom
   and window roles) are NOT here on purpose: Electron takes those labels from
   the OS, already in the system language. Hand-translating a role's label is
   how an app ends up with a Russian "Скрыть" next to an English "Services".

   `selectProjectRoot` is the folder picker File ▸ Open project… opens — it is
   this menu's dialog, so it lives with the item that raises it. */

export const menu = {
  file: 'File',
  newWindow: 'New window',
  openProject: 'Open project…',
  quickOpen: 'Quick open…',
  closeTab: 'Close tab',
  closeWindow: 'Close window',
  edit: 'Edit',
  find: 'Find',
  view: 'View',
  toggleSidebar: 'Toggle sidebar',
  reload: 'Reload',
  window: 'Window',
  help: 'Help',
  documentation: 'Documentation',
  selectProjectRoot: 'Select project root',

  // The shared global actions (src/shared/global-actions.ts). Both the native
  // menu and the sidebar's app menu render these, which is why the list holds a
  // key rather than a string.
  settings: 'Settings…',
  viewChangelog: 'View changelog',
  getHelp: 'Get help',
  checkForUpdate: 'Check for updates…',
} as const;
