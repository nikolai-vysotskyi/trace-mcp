/* Guard: the onboarding sheet that installs the Claude Code hook, the
   per-project guard readout on Project Overview, and the Ollama panel that the
   same first-run flow leads into. Wording is unchanged — this namespace moved
   the strings, it did not rewrite them.

   Command lines, file paths and model names are identifiers the user copies and
   runs, so they stay in English in every language. */

export const guard = {
  /* ── Onboarding sheet ──────────────────────────────────────────────── */
  'onboarding.cliMissing.title': 'Install the trace-mcp CLI',
  'onboarding.cliMissing.body':
    "The app talks to your projects through the <code>trace-mcp</code> command, and it isn't on your PATH yet. Run this in a terminal, then reopen the app.",
  'onboarding.cliStale.title': 'Update the trace-mcp CLI',
  'onboarding.cliStale.body':
    'You have <code>{{current}}</code>; this app needs <code>{{required}}</code> or newer. Run this in a terminal, then reopen the app.',
  'onboarding.installPrompt.title': 'Set up the trace-mcp guard',
  'onboarding.installPrompt.body':
    "The guard routes Claude Code's Read, Grep, Glob and Bash calls through trace-mcp instead of raw file reads, which saves roughly 30–50% of the tokens in a session. New projects start in Coach mode — hints only, never blocking — and move to Strict after seven days.",
  'onboarding.installPrompt.note':
    '<code>~/.claude/settings.json</code> is backed up to <code>settings.json.bak</code> before anything is written.',
  'onboarding.installing.title': 'Installing the guard',
  'onboarding.installing.body': "Writing the hook into Claude Code's settings…",
  'onboarding.installed.title': 'Guard installed',
  'onboarding.installed.body': 'Restart Claude Code so it picks up the new hook configuration.',
  'onboarding.installed.script': 'Hook script',
  'onboarding.skipped.title': 'Guard not installed',
  'onboarding.skipped.body': 'You can install it later from Settings, under AI / embeddings.',
  'onboarding.done': 'Done',
  'onboarding.close': 'Close',
  'onboarding.install': 'Install guard',
  'onboarding.notNow': 'Not now',
  'onboarding.copied': 'Copied',
  'onboarding.copyCommand': 'Copy command',
  'onboarding.copyLabelled': 'Copy {{label}}',

  /* ── Project Overview readout ──────────────────────────────────────── */
  title: 'Guard',
  'row.status': 'Status',
  'row.mode': 'Mode',
  'row.promotion': 'Switches to strict',
  'row.promoted': 'Switched to strict',
  'row.promotedValue': 'Coach period ended',
  'row.enforcement': 'Enforcement',
  /* SectionError composes "Couldn't load <what>" in lattice/ui, which a later
     slice extracts; this is the fragment it takes. */
  statusErrorWhat: 'the guard status',

  'health.ok': 'Active',
  'health.stalled': 'Stalled',
  'health.down': 'Not running',
  'health.unknown': 'Unknown',

  'mode.aria': 'Guard mode',
  'mode.strict': 'Strict',
  'mode.strictHelp': 'Block Read, Grep and Glob when a trace-mcp tool answers the question',
  'mode.coach': 'Coach',
  'mode.coachHelp': 'Never block — suggest the trace-mcp tool instead',
  'mode.off': 'Off',
  'mode.offHelp': 'Leave Claude Code alone in this project',

  'bypass.resumes': 'Resumes {{when}}',
  'bypass.resumeNow': 'Resume now',
  'bypass.pause_one': 'Pause for {{count}} minute',
  'bypass.pause_other': 'Pause for {{count}} minutes',

  /* Future tense, so `relativeTime` (past-only, by design) cannot serve it. */
  'until.underMinute': 'in under a minute',
  'until.minutes_one': 'in {{count}} minute',
  'until.minutes_other': 'in {{count}} minutes',
  'until.hours_one': 'in {{count}} hour',
  'until.hours_other': 'in {{count}} hours',
  'until.days_one': 'in {{count}} day',
  'until.days_other': 'in {{count}} days',

  /* ── Ollama panel ──────────────────────────────────────────────────── */
  'ollama.title': 'Ollama',
  'ollama.unavailable': 'Ollama control is only available inside the trace-mcp app.',
  'ollama.running': 'Running · {{version}}',
  'ollama.unknownVersion': 'unknown version',
  'ollama.notRunning': 'Not running',
  'ollama.runningShort': 'Running',
  'ollama.start': 'Start',
  'ollama.starting': 'Starting…',
  'ollama.stop': 'Stop',
  'ollama.stopping': 'Stopping…',
  'ollama.startFailed': "Couldn't start Ollama: {{error}}",
  'ollama.stopFailed': "Couldn't stop Ollama: {{error}}",
  'ollama.unloadFailed': "Couldn't unload {{name}}: {{error}}",
  'ollama.deleteFailed': "Couldn't delete {{name}}: {{error}}",
  'ollama.unknownError': 'unknown error',

  'ollama.loadedTitle': 'Loaded in memory',
  'ollama.loadedEmptyTitle': 'Nothing loaded',
  'ollama.loadedEmptyBody': 'A model appears here while it is held in memory.',
  'ollama.installedTitle': 'Installed on disk',
  'ollama.installedEmptyTitle': 'No models installed',
  'ollama.installedEmptyBody': 'Run ollama pull <name> in a terminal to add one.',

  'ollama.vram': '{{size}} VRAM',
  'ollama.ram': '{{size}} RAM',
  'ollama.unloadIn': 'unload in {{time}}',
  'ollama.expiring': 'expiring',

  'ollama.unload': 'Unload',
  'ollama.unloading': 'Unloading…',
  'ollama.delete': 'Delete',
  'ollama.deleting': 'Deleting…',
  'ollama.confirmTitle': 'Delete {{name}}?',
  'ollama.confirmBody': 'The model is removed from disk. Pulling it again re-downloads it.',
  'ollama.confirmAction': 'Delete model',

  /* ── Setup wizard ── */
  'wizard.welcomeTitle': "Welcome to trace-mcp",
  'wizard.welcomeSubtitle': "Framework-aware code intelligence and architecture graphs for your coding assistants.",
  'wizard.continue': "Continue",
  'wizard.skip': "Skip for now",
  'wizard.finish': "Get started",
  'wizard.back': "Back",
  'wizard.daemon.title': "Background service",
  'wizard.daemon.installing': "Setting up background service…",
  'wizard.daemon.ready': "Background service is running and healthy.",
  'wizard.daemon.failed': "Could not set up background service.",
  'wizard.daemon.retry': "Retry setup",
  'wizard.clients.title': "Connect coding assistants",
  'wizard.clients.subtitle': "Select the AI assistants you want to connect to trace-mcp. Config files will only be updated after confirmation.",
  'wizard.clients.none': "No supported MCP clients detected. You can configure them later in Settings or MCP Clients.",
  'wizard.clients.connect': "Connect selected",
  'wizard.clients.connecting': "Connecting…",
  'wizard.clients.connected': "Connected",
  'wizard.clients.configLabel': "Config path:",
  'wizard.clients.manualNote': "Manual setup required in editor",
  'wizard.project.title': "Index your first project",
  'wizard.project.subtitle': "Select a codebase to index for symbol lookups, call hierarchies, and architecture graphs.",
  'wizard.project.suggested': "Suggested project",
  'wizard.project.chooseFolder': "Choose folder…",
  'wizard.project.changeFolder': "Change folder…",
  'wizard.project.noFolder': "No project selected.",
  'wizard.project.index': "Index project",
  'wizard.project.indexing': "Indexing…",
  'wizard.complete.title': "You're all set",
  'wizard.complete.subtitle': "trace-mcp is ready. Your coding assistants can now query the project graph.",
  'wizard.complete.daemon': "Background service",
  'wizard.complete.clients': "Connected assistants",
  'wizard.complete.project': "Active project",
} as const;
