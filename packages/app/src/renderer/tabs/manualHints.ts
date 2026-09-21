/**
 * Manual-setup hints for MCP clients the app cannot configure itself
 * (TRA-1109).
 *
 * The rule these follow: a hint a human types or pastes must produce exactly
 * the entry the automatic setup would have written. Every automatic write
 * points `command` at the absolute launcher shim
 * (`~/.trace/bin/trace`, resolved in the main process via
 * `getLauncherShimPath`), never at a bare binary name resolved from PATH —
 * on a machine with a stale npm install beside the desktop app those are two
 * different programs at two different versions.
 *
 * The menu paths ("Settings → Tools → …") stay untranslated on purpose: they
 * are the literal path a user clicks inside somebody else's app, and a
 * translated path sends them looking for a menu that is not there.
 */

/** Server key `init` registers under (mirrors `MCP_KEY` in src/init/mcp-client.ts). */
export const MANUAL_MCP_KEY = 'trace';

/** Fallback command token when the shim path is not known (no IPC in dev browsers). */
export const MANUAL_FALLBACK_COMMAND = 'trace';

export type ManualClientName = 'jetbrains-ai' | 'warp';

function commandOf(shimPath: string | null | undefined): string {
  const cmd = shimPath?.trim();
  return cmd ? cmd : MANUAL_FALLBACK_COMMAND;
}

/**
 * The `command` + `args` entry the automatic setup would write for this
 * client, as a paste-ready JSON snippet (Warp).
 */
export function buildWarpSnippet(shimPath: string | null | undefined): string {
  return JSON.stringify({
    mcpServers: {
      [MANUAL_MCP_KEY]: { command: commandOf(shimPath), args: ['serve'] },
    },
  });
}

/** The full one-line hint shown under the row once expanded. */
export function buildManualHint(
  name: ManualClientName,
  shimPath: string | null | undefined,
): string {
  const command = commandOf(shimPath);
  if (name === 'jetbrains-ai') {
    return `Settings → Tools → AI Assistant → MCP → Add → Command: ${command}, Args: serve`;
  }
  return `Settings → Agents → MCP servers → + Add → paste ${buildWarpSnippet(shimPath)}`;
}

/**
 * What the row's Copy button puts on the clipboard: the value the user would
 * otherwise type (JetBrains: the long shim path) or paste (Warp: the snippet).
 */
export function buildManualCopyText(
  name: ManualClientName,
  shimPath: string | null | undefined,
): string {
  if (name === 'jetbrains-ai') return commandOf(shimPath);
  return buildWarpSnippet(shimPath);
}
