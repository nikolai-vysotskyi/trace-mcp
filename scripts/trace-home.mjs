/**
 * Where the CLI keeps its runtime state, for the plain-Node scripts.
 *
 * TRA-611 renamed `~/.trace-mcp` → `~/.trace`, and `src/global.ts` performs the
 * rename on first import. These scripts cannot import that module — it is
 * TypeScript, and importing it would trigger the rename as a side effect — so
 * they carry the same two-line fallback the Electron main process has in
 * `packages/app/src/main/trace-home.ts::getLauncherDir`.
 *
 * Same rule as there: **prefer the new name only when it is actually on disk.**
 * Guessing `.trace` on a machine whose CLI still writes `.trace-mcp` costs a
 * split brain (a marker or pidfile nothing else reads); waiting for the
 * directory to exist costs nothing, because the CLI creates it before anything
 * needs to be found in it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `TRACE_HOME` / `TRACE_MCP_HOME` are honoured only when the caller did not pin
 * a home directory: an explicit `homeDir` is a test seam or a sandbox root, and
 * an env var leaking in from the developer's shell would send the lookup back
 * out to the real machine.
 *
 * @param {string} [homeDir] Override `os.homedir()` (tests, sandboxes).
 * @returns {string} Absolute path to the CLI state directory.
 */
export function traceHomeDir(homeDir) {
  if (homeDir === undefined) {
    const envDir = process.env.TRACE_HOME?.trim() || process.env.TRACE_MCP_HOME?.trim();
    if (envDir) return envDir;
    homeDir = os.homedir();
  }
  const current = path.join(homeDir, '.trace');
  return fs.existsSync(current) ? current : path.join(homeDir, '.trace-mcp');
}
