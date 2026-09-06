/**
 * Validate the launcher path an MCP client is actually registered at.
 *
 * `launcher.log` is written *by* the shim, so every failure that happens before
 * the shim executes — path missing, dangling symlink, lost `+x`, a directory, a
 * gone interpreter — leaves the log at zero errors while every client reports
 * `Failed to connect`. A health check that reads only the log reports "all
 * green" during a total outage (TRA-910). This module checks the file the
 * client spawns instead.
 */

import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import YAML from 'yaml';
import { checkLauncherFile, getLauncherPath } from './launcher.js';
import type { LauncherPathCheck } from './launcher.js';
import { readIfExists } from '../utils/safe-fs.js';
import {
  ALL_MCP_CLIENT_NAMES,
  codexSectionHeaderPattern,
  getConfigPath,
  LEGACY_MCP_KEY,
  MCP_KEY,
} from './mcp-client.js';
import type { DetectedMcpClient } from './types.js';

export interface RegisteredLauncherCheck extends LauncherPathCheck {
  client: string;
  configPath: string;
}

export interface ClientConfigLocation {
  clientName: string;
  configPath: string;
}

/**
 * Every config file a client could have registered us in — both scopes, every
 * client we know how to write. Deliberately not the conflict detector's list:
 * that one covers only the formats it can conflict-scan, so a Codex- or
 * Hermes-only user would keep the exact blind spot this module closes.
 */
export function launcherConfigLocations(projectRoot = process.cwd()): ClientConfigLocation[] {
  const out: ClientConfigLocation[] = [];
  const seen = new Set<string>();
  for (const name of ALL_MCP_CLIENT_NAMES) {
    for (const scope of ['global', 'project'] as const) {
      const configPath = getConfigPath(name as DetectedMcpClient['name'], projectRoot, scope);
      if (!configPath || seen.has(configPath)) continue;
      seen.add(configPath);
      out.push({ clientName: name, configPath });
    }
  }
  return out;
}

/** Our `command` in a TOML config — Codex's `[mcp_servers.trace]` section. */
function commandsFromToml(raw: string): string[] {
  const out: string[] = [];
  for (const key of [MCP_KEY, LEGACY_MCP_KEY]) {
    const header = codexSectionHeaderPattern(key);
    let inSection = false;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (header.test(trimmed)) {
        inSection = true;
        continue;
      }
      if (inSection && trimmed.startsWith('[')) break;
      if (!inSection) continue;
      const m = trimmed.match(/^command\s*=\s*["']([^"']+)["']/);
      if (m?.[1]) out.push(m[1]);
    }
  }
  return out;
}

/** Our `command` in Hermes' `mcp_servers:` YAML block. */
function commandsFromYaml(raw: string): string[] {
  const doc = YAML.parse(raw) as Record<string, unknown> | null;
  const servers = doc?.mcp_servers as Record<string, { command?: unknown }> | undefined;
  return collectCommands([servers]);
}

/**
 * Our `command` from any JSON-shaped config. Parsed as JSONC so AMP's
 * `settings.jsonc` and a hand-commented config both survive. Buckets cover the
 * three shapes clients use: `mcpServers`, `servers`, AMP's literal-dot
 * `amp.mcpServers` key, and the per-project copies inside `~/.claude.json`
 * (which is what an already-running Claude Code actually spawns).
 */
function commandsFromJson(raw: string): string[] {
  const parsed = parseJsonc(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') return [];
  const buckets: unknown[] = [parsed.mcpServers, parsed.servers, parsed['amp.mcpServers']];
  const projects = parsed.projects as Record<string, { mcpServers?: unknown }> | undefined;
  if (projects && typeof projects === 'object') {
    for (const proj of Object.values(projects)) buckets.push(proj?.mcpServers);
  }
  return collectCommands(buckets);
}

function collectCommands(buckets: unknown[]): string[] {
  const out: string[] = [];
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== 'object') continue;
    const servers = bucket as Record<string, { command?: unknown }>;
    for (const key of [MCP_KEY, LEGACY_MCP_KEY]) {
      const cmd = servers[key]?.command;
      if (typeof cmd === 'string' && cmd.trim()) out.push(cmd.trim());
    }
  }
  return out;
}

/** Every launcher command registered for us across the given config files. */
function registeredCommands(
  configs: ClientConfigLocation[],
): { client: string; configPath: string; command: string }[] {
  const out: { client: string; configPath: string; command: string }[] = [];
  for (const { clientName, configPath } of configs) {
    const raw = readIfExists(configPath);
    if (raw === null) continue;
    const ext = path.extname(configPath).toLowerCase();
    let commands: string[] = [];
    try {
      if (ext === '.toml') commands = commandsFromToml(raw);
      else if (ext === '.yaml' || ext === '.yml') commands = commandsFromYaml(raw);
      else commands = commandsFromJson(raw);
    } catch {
      continue; // malformed config is a separate problem, reported elsewhere
    }
    for (const command of commands) out.push({ client: clientName, configPath, command });
  }
  return out;
}

/**
 * Check every launcher path a client is registered at, plus the path we install
 * to — the latter so a fresh machine with no client configured still gets told
 * its shim is broken. Deduplicated by path so one bad shim is one finding.
 */
export function checkRegisteredLaunchers(
  configs: ClientConfigLocation[] = launcherConfigLocations(),
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
