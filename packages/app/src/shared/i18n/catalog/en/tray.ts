/* The tray: its context menu, its tooltip, and the title the menu window and
   its tab carry. Wording is unchanged from main/tray.ts.

   "trace-mcp" is the product's name and stays in Latin in every language — a
   translated brand is a brand nobody can search for. */

export const tray = {
  daemonRunning: 'Daemon running',
  daemonStopped: 'Daemon stopped',
  workspace: 'Workspace',
  clients: 'MCP Clients',
  settings: 'Settings',
  quit: 'Quit trace-mcp',
  tooltipRunning: 'trace-mcp — running',
  tooltipStopped: 'trace-mcp — daemon unreachable',
  /** Window and tab title of the menu window. */
  menuWindow: 'Menu',
} as const;
