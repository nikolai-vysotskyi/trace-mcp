/* The menu window's "MCP clients" surface.

   Client names (Claude Code, Cursor, Warp…) are product names and stay in the
   component, untranslated. So do MANUAL_HINTS: those are the literal menu path
   a user clicks inside somebody else's app, and a translated path sends them
   looking for a menu that is not there. */

export const clients = {
  title: 'MCP clients',
  refresh: 'Refresh clients',

  supported: 'Supported clients',
  sessions: 'Active sessions',
  detecting: 'Detecting clients',
  loadingSessions: 'Loading sessions',

  daemonDownTitle: 'Daemon not reachable',
  daemonDownSubtitle:
    'trace-mcp clients connect through the local daemon. Start it to see and configure them.',
  startDaemon: 'Start daemon',
  starting: 'Starting…',

  noSessionsTitle: 'No active sessions',
  noSessionsSubtitle: 'A session appears here when a client connects to the daemon.',
  unnamedSession: 'Unnamed session',

  sessionActive: 'Active',
  sessionIdle: 'Idle',
  sessionStale: 'Stale',

  connected: 'Connected',
  connect: 'Connect',
  connecting: 'Connecting…',
  updateAvailable: 'Update available',
  update: 'Update',
  updating: 'Updating…',
  driftedField: 'Drifted field: {{field}}',
  setUpManually: 'Set up manually…',
  hideSteps: 'Hide steps',

  enforcementLevel: 'Enforcement level',
  levelBase: 'Base',
  levelBaseHint: 'CLAUDE.md only — soft routing rules',
  levelStandard: 'Standard',
  levelStandardHint: 'CLAUDE.md and hooks',
  levelMax: 'Max',
  levelMaxHint: 'CLAUDE.md, hooks and tweakcc — recommended',
} as const;
