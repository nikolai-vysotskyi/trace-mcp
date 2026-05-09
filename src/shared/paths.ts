/**
 * Centralised filesystem-path accessors for trace-mcp.
 *
 * Why this module exists
 * ──────────────────────
 * Hardcoded `path.join(os.homedir(), '.trace-mcp', …)` literals were drifting
 * across the codebase (≥6 places before this module landed). When the data
 * dir needs to change — e.g. respect `XDG_DATA_HOME`, switch to a per-user
 * cache prefix, or relocate for tests — every literal has to be hunted down
 * by hand. claude-mem hit exactly this pain (PR #2237 / #2238) and resolved
 * it with a centralised `paths` module + an invariant test.
 *
 * What this module exports
 * ────────────────────────
 * Named accessors for every path the runtime touches. Anything new that
 * needs a host-side path MUST be added here — the invariant test in
 * `tests/shared/paths-invariant.test.ts` greps the source tree and fails
 * the build if a fresh `os.homedir()` + `.trace-mcp` literal appears
 * outside this file, `src/global.ts`, or the test grandfather list.
 *
 * Back-compat
 * ───────────
 * `src/global.ts` still owns TRACE_MCP_HOME (because the override logic for
 * `TRACE_MCP_DATA_DIR` lives there). This module re-exports it so callers
 * can `import { TRACE_MCP_HOME } from '../shared/paths.js'` without caring.
 */

import os from 'node:os';
import path from 'node:path';

import {
  DAEMON_LOG_PATH,
  DECISIONS_DB_PATH,
  GLOBAL_CONFIG_PATH,
  LAUNCHD_PLIST_PATH,
  LOCKS_DIR,
  REGISTRY_PATH,
  TOPOLOGY_DB_PATH,
  TRACE_MCP_HOME,
  getDbPath,
  getSnapshotPath,
} from '../global.js';

// ── trace-mcp-owned paths (re-exported from global.ts so callers
//    can use a single import site) ──────────────────────────────
export {
  DAEMON_LOG_PATH,
  DECISIONS_DB_PATH,
  GLOBAL_CONFIG_PATH,
  LAUNCHD_PLIST_PATH,
  LOCKS_DIR,
  REGISTRY_PATH,
  TOPOLOGY_DB_PATH,
  TRACE_MCP_HOME,
  getDbPath,
  getSnapshotPath,
};

/** Indexer DB directory (per-project DBs land here). */
export const INDEX_DIR = path.join(TRACE_MCP_HOME, 'index');

/** Embedding watermark cache (one JSON file per project). */
export const EMBED_WATERMARKS_PATH = path.join(TRACE_MCP_HOME, 'embed-watermarks.json');

/** Per-project session snapshots dir (compaction recovery). */
export const SESSIONS_DIR = path.join(TRACE_MCP_HOME, 'sessions');

/** Knowledge corpora storage root. */
export const CORPORA_DIR = path.join(TRACE_MCP_HOME, 'corpora');

/** Pre-indexed dependency bundles. */
export const BUNDLES_DIR = path.join(TRACE_MCP_HOME, 'bundles');

// ── Foreign IDE / agent paths trace-mcp introspects ──────────────

/** Claude Code project store: `~/.claude/projects/<encoded-cwd>/<session>.jsonl`. */
export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** Claude Code user-level MCP server config (legacy single-file form). */
export const CLAUDE_USER_MCP_PATH = path.join(os.homedir(), '.claude.json');

/** Codex CLI per-user config (TOML). */
export const CODEX_HOME = path.join(os.homedir(), '.codex');

/** Cursor IDE per-user MCP config. */
export const CURSOR_HOME = path.join(os.homedir(), '.cursor');

/** Windsurf IDE per-user MCP config. */
export const WINDSURF_HOME = path.join(os.homedir(), '.windsurf');

/** Hermes Agent home — overridable via `HERMES_HOME`. */
export function hermesHome(): string {
  return process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes');
}

/** Continue.dev MCP servers dir. */
export const CONTINUE_HOME = path.join(os.homedir(), '.continue');

/** JetBrains Junie MCP config dir. */
export const JUNIE_HOME = path.join(os.homedir(), '.junie');

/** Factory.ai Droid MCP config. */
export const FACTORY_HOME = path.join(os.homedir(), '.factory');

/** Sourcegraph Amp config (XDG-style). */
export const AMP_HOME = path.join(os.homedir(), '.config', 'amp');

/** Project-local trace-mcp dir name (NOT a full path — joined with project root). */
export const PROJECT_LOCAL_DIRNAME = '.trace-mcp';
