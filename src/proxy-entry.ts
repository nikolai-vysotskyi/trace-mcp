#!/usr/bin/env node
// Thin proxy entry point (TRA-970).
//
// The launcher shim (hooks/trace-mcp-launcher.sh) execs this file directly —
// instead of dist/cli.js — when it can already see a trace-mcp daemon
// listening. Its whole reason to exist is to keep Commander, PluginRegistry,
// better-sqlite3 and web-tree-sitter out of this process's module graph: an
// MCP client measures RSS on THIS pid, and dist/cli.js pays a ~160 MB V8
// parse/compile floor just by being loaded, no matter which subcommand runs.
//
// If the daemon turns out to be gone (or dies mid-session) StdioSession
// dynamically imports LocalBackend and degrades to local mode in place —
// the JSON-RPC session never drops. That fallback is this file's only path
// to the heavy dependency tree, and it is bounded by whatever forced the
// daemon out of the picture, not by anything reachable from this file's
// static imports.
import { hardenStdio } from './server/transport-hardening.js';
import { installProcessSafetyNet } from './server/process-safety-net.js';

hardenStdio();

import { loadConfig } from './config.js';
import { runStdioSession, StdioSession } from './daemon/router/session.js';
import { DEFAULT_DAEMON_PORT } from './global.js';
import { attachFileLogging, logger } from './logger.js';
import { detectGitWorktree } from './project-root.js';
import { resolveDbPath } from './registry.js';

async function main(): Promise<void> {
  installProcessSafetyNet('serve');

  // Mirrors the `serve` command's `--preset <name>` option (src/cli.ts) — the
  // only flag this fast path needs to understand. Anything else and the
  // launcher shim would not have picked this file in the first place.
  const presetIdx = process.argv.indexOf('--preset');
  const preset = presetIdx !== -1 ? process.argv[presetIdx + 1] : undefined;
  if (preset) process.env.TRACE_MCP_PRESET = preset;

  const projectRoot = process.cwd();

  // Share the main repo's index instead of building a redundant one when
  // launched from a linked git worktree (mirrors `trace-mcp serve`).
  const worktreeInfo = detectGitWorktree(projectRoot);
  const indexRoot = worktreeInfo?.mainRoot ?? projectRoot;

  // ponytail: no auto-register here (unlike `trace-mcp serve`) — the daemon
  // registers the project itself on the proxy's first request
  // (ProxyBackend.registerWithDaemon), and this path only runs when a daemon
  // is already up. Also no scheduleBackgroundUpdate: `serve-http` already
  // runs that check for every live daemon, so a proxy session doing it too
  // would just be a duplicate.
  const configResult = await loadConfig(projectRoot);
  if (configResult.isErr()) {
    logger.error({ error: configResult.error }, 'Failed to load config');
    process.exit(1);
  }
  const config = configResult.value;
  if (config.logging) attachFileLogging(config.logging);

  const sharedDbPath = resolveDbPath(indexRoot);
  const idleTimeoutMs = (config.idle_timeout_minutes ?? 30) * 60_000;
  const daemonStabilityMs = (config.daemon_stability_seconds ?? 30) * 1_000;
  const drainTimeoutMs = config.backend_swap_drain_ms ?? 5_000;
  const autoSpawnDaemon =
    process.env.TRACE_MCP_NO_DAEMON === '1' ? false : (config.auto_spawn_daemon ?? true);
  const autoSpawnTimeoutMs = (config.daemon_spawn_timeout_seconds ?? 20) * 1_000;

  const session = new StdioSession({
    projectRoot,
    indexRoot,
    config,
    sharedDbPath,
    daemonPort: DEFAULT_DAEMON_PORT,
    idleTimeoutMs,
    daemonStabilityMs,
    drainTimeoutMs,
    autoSpawnDaemon,
    autoSpawnTimeoutMs,
    // The launcher shim only execs this file after its own liveness check
    // saw the daemon reachable (TRA-970), so there's no uncertain daemon
    // state for SnapshotBackend's instant answer (TRA-948) to cover here —
    // and building it would load the same heavy tree this whole file exists
    // to avoid (it's a dynamic import kept out of proxy.js, so taking that
    // path would mean a slow first load instead of a fast one).
    trySnapshotFastPath: false,
  });

  logger.info({ projectRoot, indexRoot }, 'trace-mcp proxy: starting stdio session');
  // Shared with `trace-mcp serve` (src/cli.ts) so both processes wire
  // signals/shutdown and exit identically.
  await runStdioSession(session);
}

main().catch((err) => {
  logger.error({ err: String(err) }, 'trace-mcp proxy: fatal error');
  process.exit(1);
});
