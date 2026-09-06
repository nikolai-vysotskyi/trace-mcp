/**
 * Validate the launcher path an MCP client is actually registered at.
 *
 * `launcher.log` is written *by* the shim, so every failure that happens before
 * the shim executes — path missing, dangling symlink, lost `+x`, a directory
 * where a file should be — leaves the log at zero errors while every client
 * reports `Failed to connect`. A health check that reads only the log reports
 * "all green" during a total outage (TRA-910). This module checks the file the
 * client spawns instead.
 */

import { getMcpConfigPaths } from './conflict-detector.js';
import { checkLauncherFile, getLauncherPath } from './launcher.js';
import type { LauncherPathCheck } from './launcher.js';
import { readIfExists } from '../utils/safe-fs.js';
import { MCP_KEY, LEGACY_MCP_KEY } from './mcp-client.js';

export interface RegisteredLauncherCheck extends LauncherPathCheck {
  client: string;
  configPath: string;
}

/** Every `command` registered for us across the MCP client configs we scan. */
function registeredCommands(
  configs: { clientName: string; configPath: string }[],
): { client: string; configPath: string; command: string }[] {
  const out: { client: string; configPath: string; command: string }[] = [];
  for (const { clientName, configPath } of configs) {
    const raw = readIfExists(configPath);
    if (raw === null) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // malformed JSON is a separate problem, reported elsewhere
    }
    // `~/.claude.json` keeps a second copy of the entry under every project it
    // has seen, and those are the ones an already-running client spawns.
    const buckets = [parsed.mcpServers, parsed.servers];
    const projects = parsed.projects as Record<string, { mcpServers?: unknown }> | undefined;
    if (projects && typeof projects === 'object') {
      for (const proj of Object.values(projects)) buckets.push(proj?.mcpServers);
    }
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== 'object') continue;
      const servers = bucket as Record<string, { command?: unknown }>;
      for (const key of [MCP_KEY, LEGACY_MCP_KEY]) {
        const cmd = servers[key]?.command;
        if (typeof cmd === 'string' && cmd.trim()) {
          out.push({ client: clientName, configPath, command: cmd.trim() });
        }
      }
    }
  }
  return out;
}

/**
 * Check every launcher path a client is registered at, plus the path we install
 * to — the latter so a fresh machine with no client configured still gets told
 * its shim is broken. Deduplicated by path so one bad shim is one finding.
 */
export function checkRegisteredLaunchers(
  configs: { clientName: string; configPath: string }[] = getMcpConfigPaths(process.cwd()),
): RegisteredLauncherCheck[] {
  const entries = registeredCommands(configs);
  entries.push({
    client: 'trace-mcp',
    configPath: '(installed launcher)',
    command: getLauncherPath(),
  });

  const seen = new Set<string>();
  const checks: RegisteredLauncherCheck[] = [];
  for (const e of entries) {
    if (seen.has(e.command)) continue;
    seen.add(e.command);
    checks.push({ client: e.client, configPath: e.configPath, ...checkLauncherFile(e.command) });
  }
  return checks;
}
