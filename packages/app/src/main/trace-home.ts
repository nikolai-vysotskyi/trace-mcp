/**
 * Where the CLI keeps its runtime state, and what its binary is called.
 *
 * TRA-610 renames both: `~/.trace-mcp` → `~/.trace`, `trace-mcp` → `trace`,
 * `TRACE_MCP_*` → `TRACE_*`. The rename ships from the CLI side (TRA-611) and
 * the app is installed and upgraded independently of it, so at any moment a
 * machine can be on either name — or, mid-migration, on both.
 *
 * The rule every resolver here follows: **prefer the new name only when it is
 * actually on disk, otherwise stay on the old one.** An app that guessed `.trace`
 * on a machine whose CLI still writes `.trace-mcp` would install its daemon into
 * a directory nothing else reads, and report a healthy daemon the CLI cannot see.
 * Guessing wrong costs a split brain; waiting for the directory to exist costs
 * nothing, because the CLI creates it before anything needs to be found in it.
 *
 * These replace the copies daemon-lifecycle.ts and daemon-install.ts each
 * carried, whose own comments asked to be kept in sync and had already drifted.
 * `resolveCliCommand` stays in daemon-install.ts and reads its shim from here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

/** Mirrors src/init/launcher.ts::getLauncherDir. */
export function getLauncherDir(): string {
  const envDir = process.env.TRACE_HOME?.trim() || process.env.TRACE_MCP_HOME?.trim();
  if (envDir) return envDir;
  const current = path.join(os.homedir(), '.trace');
  return fs.existsSync(current) ? current : path.join(os.homedir(), '.trace-mcp');
}

/** Shim basenames, current name first. */
export const SHIM_NAMES = IS_WINDOWS
  ? (['trace.cmd', 'trace-mcp.cmd'] as const)
  : (['trace', 'trace-mcp'] as const);

/**
 * The launcher shim `init` installed, or — when neither name is there yet —
 * the path the CLI is expected to write, so callers have something to name in
 * an error message.
 */
export function getLauncherShimPath(dir = getLauncherDir()): string {
  const candidates = SHIM_NAMES.map((n) => path.join(dir, 'bin', n));
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[candidates.length - 1];
}
