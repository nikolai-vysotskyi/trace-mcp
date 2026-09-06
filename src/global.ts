/**
 * Global paths and helpers for ~/.trace/ directory structure.
 *
 * All trace state lives here:
 *   ~/.trace/.config.json          — global config
 *   ~/.trace/registry.json         — project registry
 *   ~/.trace/index/<name>-<hash>.db — per-project databases
 *
 * Machines that still have `~/.trace-mcp/` (pre-rename installs) get it
 * renamed to `~/.trace/` the first time this module loads — see
 * `migrateLegacyHomeDir` below.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Inlined rather than importing ./utils/path-migration.js — this module must
// stay free of cross-module imports (see ensureGlobalDirs() below for why:
// tests/cli/env-overrides.test.ts runs global.ts under
// `node --experimental-strip-types`, which can't resolve .js -> .ts imports
// of sibling modules).
function isSymlink(targetPath: string): boolean {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * One-time rename `~/.trace-mcp` -> `~/.trace` (TRA-611). A same-volume
 * `renameSync` is atomic and instant regardless of DB size, unlike a
 * copy-based migration which would leave a stale, disk-doubling duplicate
 * behind (nothing then ever deletes the old copy). Runs at most once per
 * machine: once `target` exists this — and every future call, since
 * TRACE_MCP_HOME below only calls it when `target` is still missing —
 * short-circuits immediately.
 *
 * Skipped under Vitest (`process.env.VITEST`, set by the runner itself and
 * inherited by any subprocess a test spawns): this runs at *import* time, so
 * without the guard, any test that imports this module with no
 * TRACE_MCP_DATA_DIR override — e.g. tests/cli/env-overrides.test.ts's
 * "falls back to default" case, which deliberately clears the override to
 * exercise real os.homedir() resolution in a spawned subprocess — would
 * silently rename a real developer's `~/.trace-mcp` on disk. In-process tests
 * are already protected by tests/setup/isolate-home.ts pinning
 * TRACE_MCP_DATA_DIR before any project module loads; this guard covers the
 * one path that pins the var away on purpose.
 */
/**
 * Durable marker left inside the new home the moment the rename succeeds.
 * `TRACE_MCP_HOME_MIGRATED` below is only `true` for the single process that
 * performed the rename — too narrow a signal for `installLegacyBinCompat()`
 * (src/init/launcher.ts), which needs to retry creating the legacy compat
 * symlink on a *later* `trace init`/`upgrade` run if it failed (or was
 * skipped by a dry-run) the first time. This file existing is the durable
 * "a migration happened here at some point" fact that survives restarts.
 */
export const LEGACY_MIGRATION_MARKER = '.migrated-from-trace-mcp';

function migrateLegacyHomeDir(target: string, legacy: string): boolean {
  if (process.env.VITEST) return false;
  try {
    if (fs.existsSync(target)) return false;
    if (isSymlink(target) || isSymlink(legacy)) return false;
    if (!fs.statSync(legacy).isDirectory()) return false;
    fs.renameSync(legacy, target);
    try {
      fs.writeFileSync(path.join(target, LEGACY_MIGRATION_MARKER), '');
    } catch {
      /* best-effort — worst case a later run just doesn't retry the symlink */
    }
    return true;
  } catch (err) {
    // ENOENT means there is no legacy dir at all — a clean install, nothing to
    // say. Anything else (cross-device rename on a mounted $HOME, permissions)
    // means the data IS there and we are about to start from an empty home
    // instead: indistinguishable from a fresh install unless we say so. The
    // old directory is left untouched, so the fix is a manual move (TRA-732).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        `[trace] Could not migrate "${legacy}" to "${target}": ${(err as Error).message}\n` +
          `[trace] Starting with an empty "${target}". Your existing projects, decision ` +
          `memory and indexes are still in "${legacy}" — move that directory to ` +
          `"${target}" manually to keep them.`,
      );
    }
    return false;
  }
}

/**
 * Root of all trace-mcp global state.
 *
 * Default: `~/.trace/`. Override with `TRACE_MCP_DATA_DIR=<path>` for
 * Docker volumes, ephemeral CI workspaces, multi-repo orchestrators, or
 * shared cache locations. CRG v2.3.0 (#155) introduced the same knob — the
 * env var replaces the default verbatim, with `~` expansion. Resolved at
 * import time so a user-facing change requires a process restart.
 */
const { home: TRACE_MCP_HOME_RESOLVED, migrated: TRACE_MCP_HOME_MIGRATED_RESOLVED } = (() => {
  const override = process.env.TRACE_MCP_DATA_DIR;
  if (override && override.length > 0) {
    const expanded = override.startsWith('~')
      ? path.join(os.homedir(), override.slice(1))
      : override;
    return { home: path.resolve(expanded), migrated: false };
  }
  const homedir = os.homedir();
  const target = path.join(homedir, '.trace');
  const legacy = path.join(homedir, '.trace-mcp');
  return { home: target, migrated: migrateLegacyHomeDir(target, legacy) };
})();

export const TRACE_MCP_HOME = TRACE_MCP_HOME_RESOLVED;

/**
 * True only for the single run that performed the `~/.trace-mcp` -> `~/.trace`
 * rename above. Consumed by `src/init/launcher.ts` to know when a compat
 * symlink for scripts hardcoded to the old `bin/trace-mcp` path needs to be
 * (re)created — that symlink then persists on disk, so later runs (where this
 * is always `false`) don't need to touch it again.
 */
export const TRACE_MCP_HOME_MIGRATED = TRACE_MCP_HOME_MIGRATED_RESOLVED;

/** Global config file (replaces per-project .trace-mcp.json). */
export const GLOBAL_CONFIG_PATH = path.join(TRACE_MCP_HOME, '.config.json');

/** Directory for per-project SQLite databases. */
export const INDEX_DIR = path.join(TRACE_MCP_HOME, 'index');

/**
 * Index DBs for one-shot agent-run checkouts (TRA-396). Kept in their own
 * subdirectory because those roots are never written to registry.json, so a
 * registry-driven sweep can't reach their DBs and `prune` can only class them
 * as `orphan_unregistered` — a category soft GC deliberately never deletes,
 * since for a *normal* project it just means "not re-added yet". The
 * directory is the marker that makes them safely collectable by age; see
 * `sweepEphemeralDbs` in registry.ts.
 */
export const EPHEMERAL_INDEX_DIR = path.join(INDEX_DIR, 'ephemeral');

/** Global project registry. */
export const REGISTRY_PATH = path.join(TRACE_MCP_HOME, 'registry.json');

/** Topology database (cross-service graph). */
export const TOPOLOGY_DB_PATH = path.join(TRACE_MCP_HOME, 'topology.db');

/** Decision memory database (cross-session knowledge graph). */
export const DECISIONS_DB_PATH = path.join(TRACE_MCP_HOME, 'decisions.db');

/** Agent execution state database (SKILL.state engine). */
export const STATE_DB_PATH = path.join(TRACE_MCP_HOME, 'state.db');

/** Per-project + per-operation PID lock files (see src/utils/pid-lock.ts). */
export const LOCKS_DIR = path.join(TRACE_MCP_HOME, 'locks');

/**
 * Cross-process sentinel directory: heartbeat/status files, consultation
 * markers, the guard bypass file — everything the MCP server writes for the
 * guard hook and the desktop app to read.
 *
 * Deliberately NOT `$TMPDIR` (TRA-869). TMPDIR is per-process, not per-machine:
 * the writer (an MCP server the client spawned) and the readers (the guard hook
 * the agent harness spawns, the desktop app launchd starts) routinely hold
 * different values — macOS defaults to a per-user `/var/folders/.../T`, and any
 * task runner sets its own. Measured on a live machine: the server was writing
 * `/var/folders/.../T/trace-mcp-alive-d1c1b6f267c7` and refreshing it every 5s
 * while the hook looked in `/tmp/multica-task-.../` and reported "trace-mcp
 * server not running" on every single call — so the guard degraded to allowing
 * the Read/Grep fallback this product exists to replace, against a healthy,
 * connected session.
 */
export const STATUS_DIR = path.join(TRACE_MCP_HOME, 'status');

/** Default port the daemon listens on. Override with TRACE_MCP_DAEMON_PORT. */
export const DEFAULT_DAEMON_PORT =
  process.env.TRACE_MCP_DAEMON_PORT && !Number.isNaN(Number(process.env.TRACE_MCP_DAEMON_PORT))
    ? Number(process.env.TRACE_MCP_DAEMON_PORT)
    : 3741;

/** Daemon log file path. */
export const DAEMON_LOG_PATH = path.join(TRACE_MCP_HOME, 'daemon.log');

/**
 * Opt-out sentinel for the background daemon (#202). When this file exists,
 * `ensureDaemon`/`tryAutoSpawnDaemon` treat the daemon as explicitly disabled:
 * they do NOT (re)install the launchd plist or spawn a detached process. Written
 * by `trace-mcp daemon stop`, cleared by `trace-mcp daemon start`/`restart`.
 * Lets a user who prefers pure stdio remove the daemon and have it stay gone.
 */
export const DAEMON_DISABLED_PATH = path.join(TRACE_MCP_HOME, 'daemon.disabled');

/** launchd plist path for auto-start on macOS. */
export const LAUNCHD_PLIST_PATH = path.join(
  os.homedir(),
  'Library',
  'LaunchAgents',
  'com.trace-mcp.server.plist',
);

/**
 * Default global config template with all supported parameters.
 * Written to ~/.trace-mcp/.config.json on first run so users can edit values
 * instead of looking up parameter names in docs.
 */
/**
 * Strip single-line // comments from JSONC text and fix trailing commas.
 * Handles // inside quoted strings correctly.
 */
export function stripJsonComments(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    // String literal — copy verbatim
    if (text[i] === '"') {
      const start = i;
      i++; // opening quote
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++; // skip escaped char
        i++;
      }
      i++; // closing quote
      result += text.slice(start, i);
      continue;
    }
    // Line comment — skip to end of line
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    result += text[i];
    i++;
  }
  // Remove trailing commas before } or ]
  return result.replace(/,(\s*[}\]])/g, '$1');
}

/** Default config template as JSONC (with comments). */
export const DEFAULT_CONFIG_JSONC = `{
  // ── AI / Embeddings ──────────────────────────────────────────────
  "ai": {
    "enabled": false,
    "provider": "onnx",                          // "onnx" (local, zero-config) | "ollama" | "openai"
    // "base_url": "http://localhost:11434",     // custom endpoint (ollama/openai)
    // "api_key": "",                            // required for openai; or set OPENAI_API_KEY env
    // "inference_model": "gemma4:e4b",          // ollama: "gemma4:e4b", openai: "gpt-4o-mini"
    // "fast_model": "gemma4:e4b",               // ollama: "gemma4:e4b", openai: "gpt-4o-mini"
    // "embedding_model": "",                    // onnx: "Xenova/all-MiniLM-L6-v2", ollama: "qwen3-embedding:0.6b", openai: "text-embedding-3-small"
    // "embedding_dimensions": 384,              // onnx: 384, openai: 1536
    "summarize_on_index": false,
    "summarize_batch_size": 20,
    "summarize_kinds": ["class", "function", "method", "interface", "trait", "enum", "type"],
    "concurrency": 1                            // match OLLAMA_NUM_PARALLEL for ollama
    // "reranker_model": ""                      // optional: e.g. "bge-reranker-v2-m3"
  },

  // ── Security ─────────────────────────────────────────────────────
  "security": {
    // "secret_patterns": [],                    // extra regex patterns to detect secrets
    // "max_file_size_bytes": 1048576,           // skip files larger than this (1 MB)
    // "max_files": 10000                        // max files per project
  },

  // ── Predictive analysis ──────────────────────────────────────────
  "predictive": {
    "enabled": true,
    "weights": {
      "bug":         { "churn": 0.20, "fix_ratio": 0.20, "complexity": 0.20, "coupling": 0.15, "pagerank": 0.10, "authors": 0.15 },
      "tech_debt":   { "complexity": 0.30, "coupling": 0.25, "test_gap": 0.25, "churn": 0.20 },
      "change_risk": { "blast_radius": 0.25, "complexity": 0.20, "churn": 0.20, "test_gap": 0.20, "coupling": 0.15 }
    },
    "cache_ttl_minutes": 60,
    "git_since_days": 180,
    "module_depth": 2
  },

  // ── Intent / domain classification ───────────────────────────────
  "intent": {
    "enabled": false,
    // "domain_hints": {},                       // { "domain_name": ["path/pattern/**"] }
    // "custom_domains": [],                     // [{ "name": "...", "path_patterns": ["..."] }]
    "auto_classify_on_index": true,
    "classify_batch_size": 100
  },

  // ── Runtime tracing (OpenTelemetry) ──────────────────────────────
  "runtime": {
    "enabled": false,
    "otlp": {
      "port": 4318,
      "host": "127.0.0.1",
      "max_body_bytes": 4194304
    },
    "retention": {
      "max_span_age_days": 7,
      "max_aggregate_age_days": 90,
      "prune_interval": 100
    },
    "mapping": {
      "fqn_attributes": ["code.function", "code.namespace", "code.filepath"],
      "route_patterns": ["^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\\\s+(.+)$"]
    }
  },

  // ── Cross-repo topology ──────────────────────────────────────────
  "topology": {
    "enabled": true,
    // "repos": [],                              // extra repo paths for subprojects
    "auto_detect": true,
    "auto_discover": true
    // "contract_globs": []                      // globs for API contract files
  },

  // ── Quality gates ────────────────────────────────────────────────
  "quality_gates": {
    "enabled": true,
    "fail_on": "error",                          // "error" | "warning" | "none"
    "rules": {
      // "max_cyclomatic_complexity":       { "threshold": 20, "severity": "error" },
      // "max_coupling_instability":        { "threshold": 0.8, "severity": "warning" },
      // "max_circular_import_chains":      { "threshold": 0, "severity": "error" },
      // "max_dead_exports_percent":        { "threshold": 10, "severity": "warning" },
      // "max_tech_debt_grade":             { "threshold": "C", "severity": "warning" },
      // "max_security_critical_findings":  { "threshold": 0, "severity": "error" },
      // "max_antipattern_count":           { "threshold": 5, "severity": "warning" },
      // "max_code_smell_count":            { "threshold": 10, "severity": "warning" }
    }
  },

  // ── Tool exposure ────────────────────────────────────────────────
  "tools": {
    "preset": "minimal",                         // "minimal" | "standard" | "full" | custom preset name — anything outside the preset is one load_tools call away
    // "include": [],                            // whitelist specific tools
    // "exclude": [],                            // blacklist specific tools
    // "descriptions": {},                       // override tool descriptions
    "description_verbosity": "full",             // "full" | "minimal" | "none"
    "instructions_verbosity": "full",            // "full" | "minimal" | "none"
    "agent_behavior": "off",                     // "strict" | "minimal" | "off" — behavior rules (anti-sycophancy, goal-driven, etc.). Max-tier init sets to "strict".
    "meta_fields": true                          // true | false | ["_hints", "_budget_warning", ...]
  },

  // ── Indexing ignore rules ────────────────────────────────────────
  "ignore": {
    "directories": [],                           // extra directory names to skip
    "patterns": []                               // extra gitignore-style patterns
  },

  // ── Framework-specific ───────────────────────────────────────────
  "frameworks": {
    "laravel": {
      "artisan": { "enabled": true, "timeout": 10000 },
      "graceful_degradation": true
    }
  },

  // ── Logging ───────────────────────────────────────────────────────
  "logging": {
    "file": false,                                 // enable file logging
    "path": "~/.trace-mcp/run.log",                // log file location
    "level": "info",                               // "trace" | "debug" | "info" | "warn" | "error" | "fatal"
    "max_size_mb": 10                              // rotate when log exceeds this size
  },

  // ── File watcher ─────────────────────────────────────────────────
  "watch": {
    "enabled": true,
    "debounceMs": 2000
  },

  // ── Per-project overrides ────────────────────────────────────────
  // Keys are absolute paths; values override any top-level setting for that project.
  // Example:
  // "projects": {
  //   "/path/to/project": {
  //     "ai": { "enabled": true, "concurrency": 4 },
  //     "include": ["src/**/*.ts"],
  //     "exclude": ["dist/**"]
  //   }
  // }
  "projects": {}
}
`;

/** Ensure ~/.trace-mcp/ and ~/.trace-mcp/index/ exist. */
export function ensureGlobalDirs(): void {
  fs.mkdirSync(EPHEMERAL_INDEX_DIR, { recursive: true }); // also creates INDEX_DIR

  // Restrict the data dir + index dir to 0700 so DB sidecars (WAL/SHM that
  // come and go with write activity) are protected by the parent ACL even
  // when their per-file bit is briefly default-umask. No-op on Windows.
  // Inlined (rather than calling shared/db-perms.ts) so this module stays
  // free of cross-module imports — `tests/cli/env-overrides.test.ts` runs
  // global.ts under `node --experimental-strip-types` and can't resolve
  // `.js → .ts` imports of sibling modules.
  if (process.platform !== 'win32') {
    for (const dir of [TRACE_MCP_HOME, INDEX_DIR, EPHEMERAL_INDEX_DIR]) {
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        /* not ours / not yet present — best-effort */
      }
    }
  }

  // Seed default config on first run so users see all available parameters.
  // 'wx' = O_CREAT|O_EXCL: atomically create-only, no separate existsSync
  // check that could race with another process creating the file first
  // (TRA-256). Same cross-module-import constraint as above rules out the
  // shared src/utils/safe-fs.ts helper here.
  try {
    fs.writeFileSync(GLOBAL_CONFIG_PATH, DEFAULT_CONFIG_JSONC, { flag: 'wx' });
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(GLOBAL_CONFIG_PATH, 0o600);
      } catch {
        /* best-effort */
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

/** Stable 12-char hex hash of an absolute path. */
export function projectHash(absolutePath: string): string {
  return crypto.createHash('sha256').update(absolutePath).digest('hex').slice(0, 12);
}

/** Sanitized project name from path basename. */
export function projectName(absolutePath: string): string {
  return path.basename(absolutePath).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Path to the live session snapshot file (read by PreCompact hook). */
export function getSnapshotPath(projectRoot: string): string {
  const absRoot = path.resolve(projectRoot);
  return path.join(TRACE_MCP_HOME, 'sessions', `${projectHash(absRoot)}-snapshot.json`);
}

/**
 * Compute the default (path-based) global DB path for a project root.
 *
 * This is deliberately NOT identity-aware (see `getProjectRemoteIdentity`
 * below) — it stays a pure function of the absolute path so it keeps
 * producing the exact same value it always has for every project already
 * registered before TRA-38. Identity-based DB *reuse* (recognizing that two
 * different absolute paths are checkouts of the same git remote, e.g. two
 * Multica ephemeral checkouts of the same repo) is resolved one layer up, in
 * `registerProject` (registry.ts): a brand-new root whose remote matches an
 * already-registered different root inherits *that* entry's `dbPath` instead
 * of one computed here. Every read path in this codebase already prefers the
 * registry's stored `dbPath` over recomputing it (see the repeated
 * `resolveDbPath()` helper across `src/cli/*.ts`), so this function only ever
 * actually runs for a root that isn't registered yet — i.e. exactly the
 * "first checkout of this repo, or a non-git / remote-less project" case.
 */
export function getDbPath(projectRoot: string): string {
  const absRoot = path.resolve(projectRoot);
  return path.join(INDEX_DIR, `${projectName(absRoot)}-${projectHash(absRoot)}.db`);
}

/**
 * Same as {@link getDbPath} but under {@link EPHEMERAL_INDEX_DIR}. Used for
 * one-shot agent-run checkouts that couldn't share a canonical sibling's DB,
 * so the leftover is collectable by age instead of sitting in the main index
 * dir forever with no registry row to explain it (TRA-396).
 */
export function getEphemeralDbPath(projectRoot: string): string {
  const absRoot = path.resolve(projectRoot);
  return path.join(EPHEMERAL_INDEX_DIR, `${projectName(absRoot)}-${projectHash(absRoot)}.db`);
}

/**
 * Resolve the `.git` metadata directory for `root`, following worktree
 * indirection (a `.git` *file* containing `gitdir: <path>`, pointing at
 * `<main-repo>/.git/worktrees/<name>`) the same way `detectGitWorktree` in
 * project-root.ts does. Duplicated here rather than imported — this module
 * must stay free of sibling `.ts` imports (see the comment on
 * `ensureGlobalDirs` above: `tests/cli/env-overrides.test.ts` runs
 * `global.ts` directly under `node --experimental-strip-types`, which can't
 * resolve `.js → .ts` imports of sibling modules).
 */
function resolveGitMetadataDir(root: string): string | null {
  // Trust note (CodeQL js/path-injection): `root` is a project root — CLI
  // argument, cwd, or the `X-Trace-Project` hint on the daemon's loopback
  // `/mcp` endpoint. CodeQL traces that last one and calls it user-provided,
  // which is literally true, but it is the daemon's *own* project-selection
  // input: anyone who can reach the daemon can already ask it to index and
  // serve that whole tree, so reading `<root>/.git/config` grants nothing
  // extra. Reads below never leave `<root>/.git`, and every failure returns
  // null. Whether that loopback endpoint should be authenticated at all is a
  // separate, pre-existing question — see TRA-301.
  const gitEntry = path.join(root, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(gitEntry); // codeql[js/path-injection]: see trust note above
  } catch {
    return null;
  }
  if (stat.isDirectory()) return gitEntry;
  if (!stat.isFile()) return null;

  let content: string;
  try {
    // codeql[js/file-system-race]: the stat above discriminates dir-vs-file,
    // it is not an existence check — if the entry changes underneath us the
    // read simply throws and we fall back to "not a git repo" (null).
    // codeql[js/path-injection]: see trust note above
    content = fs.readFileSync(gitEntry, 'utf8').trim();
  } catch {
    return null;
  }
  const match = content.match(/^gitdir:\s*(.+)$/);
  if (!match) return null;
  const worktreeAdminDir = path.resolve(root, match[1].trim());
  try {
    // codeql[js/path-injection]: see trust note above
    const raw = fs.readFileSync(path.join(worktreeAdminDir, 'commondir'), 'utf8').trim();
    return path.resolve(worktreeAdminDir, raw);
  } catch {
    // Fallback: admin dir is .git/worktrees/<name>, so ../../ is .git
    return path.resolve(worktreeAdminDir, '../..');
  }
}

/**
 * Read the `origin` remote URL out of a `.git/config` file, falling back to
 * the first `[remote "..."]` section found when there is no `origin`. A
 * small hand-rolled INI reader (not a library, not a `git` subprocess) to
 * keep this module dependency-free and avoid a `git` binary requirement —
 * same rationale as `detectGitWorktree` reading `.git` files directly.
 */
function readGitRemoteUrl(gitDir: string): string | null {
  let configText: string;
  try {
    // codeql[js/path-injection]: `gitDir` comes from resolveGitMetadataDir,
    // which only ever returns a path under the trusted project root — see the
    // trust note there.
    configText = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
  } catch {
    return null;
  }

  let currentRemote: string | null = null;
  let originUrl: string | null = null;
  let firstUrl: string | null = null;

  for (const line of configText.split(/\r?\n/)) {
    const section = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*$/);
    if (section) {
      currentRemote = section[1];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      currentRemote = null; // left the remote section
      continue;
    }
    if (!currentRemote) continue;
    const urlMatch = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
    if (!urlMatch) continue;
    if (currentRemote === 'origin') originUrl = urlMatch[1];
    if (firstUrl === null) firstUrl = urlMatch[1];
  }

  return originUrl ?? firstUrl;
}

/**
 * Normalize a git remote URL to a canonical `host/org/repo` form so the same
 * repository is recognized regardless of protocol (`https://`, `ssh://`,
 * scp-like `git@host:org/repo`) or a trailing `.git`. Returns null for
 * anything that doesn't look like a `host` + `path` remote (e.g. a local
 * filesystem path used as a remote) — callers fall back to path-based
 * identity in that case, same as a repo with no remote at all.
 */
export function normalizeGitRemote(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let host: string;
  let rawPath: string;

  if (!trimmed.includes('://')) {
    // scp-like syntax: [user@]host:path
    const scpMatch = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (!scpMatch) return null;
    host = scpMatch[1];
    rawPath = scpMatch[2];
  } else {
    try {
      const parsed = new URL(trimmed);
      if (!parsed.hostname) return null;
      host = parsed.hostname;
      rawPath = parsed.pathname;
    } catch {
      return null;
    }
  }

  // Guard against misreading a local path (e.g. `C:\repo`) as an scp-like
  // `host:path` remote — a real git host looks like a DNS name.
  if (!/^[A-Za-z0-9.-]+$/.test(host) || host.length < 2) return null;

  const cleanedPath = rawPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  if (!cleanedPath) return null;

  return `${host.toLowerCase()}/${cleanedPath}`;
}

/**
 * Stable identity of the repo at `projectRoot`, derived from its `origin`
 * (or first configured) git remote and normalized so the same repo is
 * recognized across clones/checkouts regardless of which absolute path it
 * lives at (TRA-38) — e.g. Multica's `repo checkout` landing the same repo
 * under a fresh per-run ephemeral directory every time.
 *
 * Returns null for a non-git directory or a git repo with no remote
 * configured; callers fall back to path-based identity in that case, which
 * is exactly today's (pre-TRA-38) behavior — so a project with no
 * resolvable remote is completely unaffected by this function existing.
 */
export function getProjectRemoteIdentity(projectRoot: string): string | null {
  const absRoot = path.resolve(projectRoot);
  const gitDir = resolveGitMetadataDir(absRoot);
  if (!gitDir) return null;
  const url = readGitRemoteUrl(gitDir);
  if (!url) return null;
  return normalizeGitRemote(url);
}
