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

// ─── Reference validation ────────────────────────────────────────────
//
// Tools like compare_branches and get_changed_symbols accept raw git ref
// strings from the MCP caller. If those strings ever reach a shell command
// (`execSync(\`git ... ${ref}\`)`) or are passed as the first argv to a
// subcommand without `--`, a malicious caller can inject git flags or shell
// metacharacters: a ref of `-c=core.sshCommand=evil` becomes a global option
// when interpolated, and `; rm -rf /;` is full RCE under execSync.
//
// We never need to round-trip exotic ref characters — git refs in the wild
// use the conservative subset below. Tightening here costs nothing and
// closes a whole class of bugs.

/**
 * Strict whitelist for git refs / commitishes accepted from external input.
 * Allows: ASCII letters, digits, `_`, `-`, `.`, `/`, `@`, `^`, `~`, `+`.
 * Rejects: leading `-`, empty string, anything with `..`, control chars,
 * spaces, shell metacharacters.
 *
 * Note: git itself permits a wider character set (see
 * `git check-ref-format`), but every ref produced by a normal workflow
 * fits this whitelist. Callers that need broader names can call git's
 * own checker.
 */
const REF_RE = /^[a-zA-Z0-9_./@^~+-]+$/;

export function isSafeGitRef(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 256) return false;
  if (value.startsWith('-')) return false;
  if (value.includes('..')) return false;
  return REF_RE.test(value);
}

/**
 * Throws if `value` is not a safe git ref. Keeps call sites short while
 * surfacing a clear error message at the boundary.
 */
export function assertSafeGitRef(value: unknown, paramName: string): asserts value is string {
  if (!isSafeGitRef(value)) {
    throw new Error(
      `Invalid git ref for "${paramName}": ${JSON.stringify(value)}. Refs must match ${REF_RE} and not start with "-".`,
    );
  }
}

/**
 * Validate every ref-like argument in a record; returns the first failure.
 * Useful for compare_branches / get_changed_symbols which accept several
 * refs at once.
 */
export function findUnsafeRef(
  refs: Record<string, unknown>,
): { name: string; value: unknown } | null {
  for (const [name, value] of Object.entries(refs)) {
    if (value === undefined || value === null) continue;
    if (!isSafeGitRef(value)) return { name, value };
  }
  return null;
}
