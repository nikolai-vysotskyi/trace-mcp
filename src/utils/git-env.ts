/**
 * Hardened environment for spawning git against an untrusted workspace.
 *
 * trace-mcp routinely runs git commands inside arbitrary user workspaces
 * (`get_git_churn`, `compare_branches`, `get_changed_symbols`, blame for
 * predictions, history snapshots, etc.). A malicious repo could plant a
 * `.git/config` referencing a hook, alias, fsmonitor command, or
 * `core.editor`/`credential.helper` that gets invoked by an otherwise
 * read-only command — turning indexing into RCE.
 *
 * Mirrors the jcodemunch v1.81.2 hardening: refuse system/global config,
 * silence terminal prompts. Callers spread the result into the spawn
 * env. Use `safeGitEnv()` for new code; existing call sites can adopt it
 * incrementally.
 */
const SAFE_GIT_ENV_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  // Don't read /etc/gitconfig — workspace-controlled paths cannot redirect us there
  GIT_CONFIG_NOSYSTEM: '1',
  // Don't read ~/.gitconfig either; if a user invokes us they trust their own
  // global config, but the workspace repo can override sub-keys via includeIf.
  // Pointing at /dev/null neutralizes both.
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  // Never block on credential prompts — we run non-interactively
  GIT_TERMINAL_PROMPT: '0',
  // Don't try to start an editor for any command that defaults to one
  GIT_EDITOR: 'true',
  // Disable advice noise that some commands print to stderr
  GIT_ADVICE: '0',
});

/**
 * Returns a frozen copy of process.env merged with the safe overrides.
 * Pass extra entries via `extra` — they win over the defaults.
 */
export function safeGitEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...SAFE_GIT_ENV_OVERRIDES };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete merged[k];
      else merged[k] = v;
    }
  }
  return merged;
}

/** Read-only export for callers that want to inspect the override list. */
export const SAFE_GIT_ENV_KEYS = Object.freeze(Object.keys(SAFE_GIT_ENV_OVERRIDES));
