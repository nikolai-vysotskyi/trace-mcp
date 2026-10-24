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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hardenStdio } from './server/transport-hardening.js';
import { installProcessSafetyNet } from './server/process-safety-net.js';

declare const PKG_VERSION_INJECTED: string;
export const PKG_VERSION =
  typeof PKG_VERSION_INJECTED !== 'undefined' ? PKG_VERSION_INJECTED : '0.0.0-dev';

export const PROXY_USAGE = `Usage: trace-mcp-proxy [options] [command]

Thin stdio proxy to the trace-mcp daemon.

Options:
  -v, --version    output the version number
  -h, --help       display help for command

Commands:
  serve [options]  Run stdio MCP proxy session
  help [command]   display help for command`;

export function isMainEntry(
  metaUrl: string = import.meta.url,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) return false;
  try {
    const resolvedArgv = path.resolve(argv1);
    const resolvedMeta = fileURLToPath(metaUrl);
    if (resolvedArgv === resolvedMeta) return true;
    if (process.platform === 'win32' && resolvedArgv.toLowerCase() === resolvedMeta.toLowerCase()) {
      return true;
    }
    const realArgv = fs.realpathSync(resolvedArgv);
    const realMeta = fs.realpathSync(resolvedMeta);
    if (realArgv === realMeta) return true;
    if (process.platform === 'win32' && realArgv.toLowerCase() === realMeta.toLowerCase()) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export type ProxyArgAction = 'help' | 'version' | 'error' | 'serve';

export interface ProxyArgClassification {
  action: ProxyArgAction;
  type: ProxyArgAction;
  exitCode: number;
  output?: string;
  error?: string;
}

export function extractProxyArgs(argv: string[]): string[] {
  if (argv.length < 2) {
    return argv;
  }
  const first = argv[0].split(/[/\\]/).pop()?.toLowerCase() ?? '';
  const second = argv[1].split(/[/\\]/).pop()?.toLowerCase() ?? '';

  const isRuntime = /^(node|tsx|bun)(\.exe|\.cmd|\.bat)?$/i.test(first);
  const isScript = /^(proxy|proxy-entry)(\.ts|\.js|\.mjs|\.cjs)?$/i.test(second);

  if ((isRuntime || isScript) && !argv[1].startsWith('-')) {
    return argv.slice(2);
  }
  return argv;
}

export function classifyProxyArgs(argv: string[]): ProxyArgClassification {
  const args = extractProxyArgs(argv);

  if (args.includes('-h') || args.includes('--help')) {
    return {
      action: 'help',
      type: 'help',
      exitCode: 0,
      output: PROXY_USAGE,
    };
  }

  if (args.includes('-v') || args.includes('-V') || args.includes('--version')) {
    return {
      action: 'version',
      type: 'version',
      exitCode: 0,
      output: PKG_VERSION,
    };
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === 'serve') {
      continue;
    }
    if (arg === 'help') {
      return {
        action: 'help',
        type: 'help',
        exitCode: 0,
        output: PROXY_USAGE,
      };
    }
    if (arg === '--preset') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        i++;
        continue;
      }
      const nextArg = args[i + 1];
      const errorMsg =
        nextArg && nextArg.startsWith('-')
          ? `error: unknown option '${nextArg}'`
          : "error: option '--preset <name>' argument missing";
      return {
        action: 'error',
        type: 'error',
        exitCode: 1,
        error: errorMsg,
        output: `${errorMsg}\n\n${PROXY_USAGE}`,
      };
    }
    if (arg.startsWith('--preset=')) {
      const val = arg.slice('--preset='.length);
      if (val.length > 0 && !val.startsWith('-')) {
        continue;
      }
      const errorMsg = "error: option '--preset <name>' argument missing";
      return {
        action: 'error',
        type: 'error',
        exitCode: 1,
        error: errorMsg,
        output: `${errorMsg}\n\n${PROXY_USAGE}`,
      };
    }
    if (arg.startsWith('-')) {
      const errorMsg = `error: unknown option '${arg}'`;
      return {
        action: 'error',
        type: 'error',
        exitCode: 1,
        error: errorMsg,
        output: `${errorMsg}\n\n${PROXY_USAGE}`,
      };
    }
    const errorMsg = `error: unknown command '${arg}'`;
    return {
      action: 'error',
      type: 'error',
      exitCode: 1,
      error: errorMsg,
      output: `${errorMsg}\n\n${PROXY_USAGE}`,
    };
  }

  return {
    action: 'serve',
    type: 'serve',
    exitCode: 0,
  };
}

export function handleProxyEarlyExit(argv: string[] = process.argv): boolean {
  const result = classifyProxyArgs(argv);
  if (result.action === 'serve') {
    return false;
  }

  process.exitCode = result.exitCode;
  const stream = result.action === 'error' ? process.stderr : process.stdout;
  const content = `${result.output}\n`;

  // Avoid stdout/stderr truncation when piped: flush the stream before exiting (Node.js GH#6456).
  stream.on('error', () => {
    process.exit(result.exitCode);
  });
  stream.write(content, () => {
    process.exit(result.exitCode);
  });
  return true;
}

import { loadConfig } from './config.js';
import { runStdioSession, StdioSession } from './daemon/router/session.js';
import { DEFAULT_DAEMON_PORT } from './global.js';
import { attachFileLogging, logger } from './logger.js';
import { resolveServeRoots } from './project-root.js';
import { resolveDbPath } from './registry.js';
import { parsePresetArg } from './server/tool-filter.js';

async function main(): Promise<void> {
  installProcessSafetyNet('serve');

  // Mirrors the `serve` command's `--preset <name>` option (src/cli.ts) — the
  // only flag this fast path needs to understand. Anything else and the
  // launcher shim would not have picked this file in the first place.
  const preset = parsePresetArg(process.argv);
  if (preset) process.env.TRACE_MCP_PRESET = preset;

  // GH#1371 edge 1 / TRA-1886, TRA-1915: honor TRACE_MCP_REPO_ROOT exactly
  // like `trace-mcp serve` (resolveServeRoots), instead of binding to cwd.
  // Linked git worktrees share the main repo's index rather than building a
  // redundant one (mirrors `trace-mcp serve`).
  const { projectRoot, indexRoot, worktreeMainRoot, envOverride } = resolveServeRoots();
  if (worktreeMainRoot) {
    logger.info(
      { worktreeRoot: projectRoot, mainRoot: worktreeMainRoot },
      'Git worktree detected — sharing main repo index',
    );
  }
  if (envOverride) {
    logger.info({ envOverride }, 'Serving TRACE_MCP_REPO_ROOT instead of cwd');
  }

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
  // Product default: daemon-backed sessions; see the recorded rationale at the
  // autoSpawnDaemon default in src/cli.ts (TRA-1832 / TRA-1836).
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

if (isMainEntry(import.meta.url, process.argv[1])) {
  if (!handleProxyEarlyExit(process.argv)) {
    hardenStdio();
    main().catch((err) => {
      logger.error({ err: String(err) }, 'trace-mcp proxy: fatal error');
      process.exit(1);
    });
  }
}
