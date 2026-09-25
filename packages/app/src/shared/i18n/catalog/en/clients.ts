/* The menu window's "MCP clients" surface.

   Client names (Claude Code, Cursor, Warp…) are product names and stay in the
   component, untranslated. So are the manual-setup hints: those are the literal menu path
   a user clicks inside somebody else's app, and a translated path sends them
   looking for a menu that is not there. */

export const clients = {
  title: 'MCP clients',
  refresh: 'Refresh clients',

  supported: 'Supported clients',
  sessions: 'Active sessions',
  detecting: 'Detecting clients',
  loadingSessions: 'Loading sessions',

  noSessionsTitle: 'No active sessions',
  noSessionsSubtitle: 'A session appears here when a client connects to the daemon.',
  unnamedSession: 'Unnamed session',

  sessionActive: 'Active',
  sessionIdle: 'Idle',
  sessionStale: 'Stale',

  configured: 'Configured',
  configuredHint:
    'trace-mcp is in the config for this client; this format cannot be checked for updates',
  noConfigFile: 'No config file found',
  connected: 'Connected',
  connect: 'Connect',
  connecting: 'Connecting…',
  update: 'Update',
  updating: 'Updating…',
  updateAll: 'Update all',
  legacyHint: 'Registered as trace-mcp; init now writes trace',
  migrate: 'Migrate',
  migrating: 'Migrating…',
  migrateAll: 'Migrate all',
  updatingProgress: 'Updating {{done}} of {{total}}',
  migratingProgress: 'Migrating {{done}} of {{total}}',
  writeFailed: 'The config could not be written.',
  driftedField: 'Drifted field: {{field}}',
  /* TRA-1647 pickup hints: what the user must do after a write before the
     client picks it up. Shown in the row caption right after a successful
     Connect/Update, and on the Connected indicator's tooltip. {{client}} is
     the product name, which stays untranslated (see the header note). */
  pickupRestartApp: 'Restart {{client}} to apply the update',
  pickupRestartSession: 'Restart the {{client}} session to apply the update',
  pickupReloadWindow: 'Reload the {{client}} window to apply the update',
  /* TRA-1932 disconnect: the entry is gone but the running server lingers
     until restart, so the caption after a Disconnect names the unload step.
     Kept as separate keys (not a verb parameter) so translators can phrase
     "unload the server" naturally. */
  disconnect: 'Disconnect',
  disconnecting: 'Disconnecting…',
  disconnectTitle: 'Disconnect {{client}}?',
  disconnectBody:
    'Removes the trace-mcp entry from this client’s config. Shared hooks and other settings stay untouched.',
  disconnectConfirm: 'Disconnect',
  disconnectFailed: 'The entry could not be removed.',
  disconnectPickupRestartApp: 'Restart {{client}} to unload the server',
  disconnectPickupRestartSession: 'Restart the {{client}} session to unload the server',
  disconnectPickupReloadWindow: 'Reload the {{client}} window to unload the server',
  blockedTitle: 'Quit Claude.app first',
  blockedWhy:
    '{{client}} keeps its config where Claude.app rewrites it while running, so anything written now is thrown away. Quit the app completely and update again.',
  blockedWhyDisconnect:
    '{{client}} keeps its config where Claude.app rewrites it while running, so anything removed now comes back. Quit the app completely and retry the disconnect.',
  blockedStep1: '1. Quit Claude.app completely (Cmd+Q on macOS) — closing the window is not enough.',
  blockedStep2: '2. Press Retry update below.',
  blockedStep2Disconnect: '2. Press Retry disconnect below.',
  blockedStep3: '3. Start Claude.app again.',
  blockedRetry: 'Retry update',
  blockedRetryDisconnect: 'Retry disconnect',
  blockedDismiss: 'Got it',
  setUpManually: 'Set up manually…',
  hideSteps: 'Hide steps',
  /* TRA-1109: the manual rows name the absolute launcher shim and offer it on
     the clipboard — the path is long and typed by hand (JetBrains) or the
     snippet is pasted (Warp). */
  copyShimPath: 'Copy shim path',
  copyWarpSnippet: 'Copy JSON snippet',

  enforcementLevel: 'Enforcement level',
  levelBase: 'Base',
  levelBaseHint: 'CLAUDE.md only — soft routing rules',
  levelStandard: 'Standard',
  levelStandardHint: 'CLAUDE.md and hooks',
  levelMax: 'Max',
  levelMaxHint: 'CLAUDE.md, hooks and tweakcc — recommended',
  /* TRA-1698 PreToolUse redirect: the entry alone does not close the value
     loop — without the hook agents keep reading files directly. */
  hookActive: 'Hook active',
  hookActiveHint: 'PreToolUse redirect is wired in — file reads go through trace-mcp',
  hookMissing: 'No redirect hook',
  hookMissingHint: 'Entry is configured but agents still read files directly',
  enableRedirect: 'Enable redirect',
  enablingRedirect: 'Enabling…',
  redirectEnabled: 'PreToolUse redirect is on — file reads now go through trace-mcp',
  redirectFailed: 'The redirect hook could not be installed.',
} as const;
