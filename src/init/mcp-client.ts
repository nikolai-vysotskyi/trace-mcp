/**
 * MCP client configuration: detect and write trace-mcp server entries.
 * Supports both project-scoped and global installation.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DetectedMcpClient, InitStepResult } from './types.js';

const HOME = os.homedir();

interface McpServerEntry {
  command: string;
  args: string[];
  cwd?: string;
}

export type McpScope = 'global' | 'project';

/**
 * Configure selected MCP clients to use trace-mcp.
 * Global scope: writes to user-level config (works in any project).
 * Project scope: writes to project-local config.
 */
export function configureMcpClients(
  clientNames: DetectedMcpClient['name'][],
  projectRoot: string,
  opts: { scope: McpScope; dryRun?: boolean },
): InitStepResult[] {
  const results: InitStepResult[] = [];

  for (const name of clientNames) {
    const configPath = getConfigPath(name, projectRoot, opts.scope);
    if (!configPath) {
      results.push({ target: name, action: 'skipped', detail: 'Unknown client' });
      continue;
    }

    // Check if already configured
    if (fs.existsSync(configPath)) {
      try {
        const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (content?.mcpServers?.['trace-mcp']) {
          results.push({ target: configPath, action: 'already_configured', detail: name });
          continue;
        }
      } catch { /* malformed JSON — will overwrite */ }
    }

    if (opts.dryRun) {
      results.push({ target: configPath, action: 'skipped', detail: `Would configure ${name} (${opts.scope})` });
      continue;
    }

    // Global scope always needs cwd since server starts from anywhere.
    // Project scope for claude-code doesn't need cwd (.mcp.json is in project root).
    const entry: McpServerEntry = { command: 'trace-mcp', args: ['serve'] };
    if (opts.scope === 'global' || (name !== 'claude-code' && name !== 'claw-code')) {
      entry.cwd = projectRoot;
    }

    try {
      const action = writeTraceMcpEntry(configPath, entry);
      results.push({ target: configPath, action, detail: `${name} (${opts.scope})` });
    } catch (err) {
      results.push({ target: configPath, action: 'skipped', detail: `Error: ${(err as Error).message}` });
    }
  }

  return results;
}

function writeTraceMcpEntry(configPath: string, entry: McpServerEntry): 'created' | 'updated' {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let config: Record<string, unknown> = {};
  let isNew = true;
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      isNew = false;
    } catch { /* malformed — overwrite */ }
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  (config.mcpServers as Record<string, unknown>)['trace-mcp'] = entry;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return isNew ? 'created' : 'updated';
}

/** Get config file path for a client, given scope. */
function getConfigPath(name: DetectedMcpClient['name'], projectRoot: string, scope: McpScope): string | null {
  switch (name) {
    case 'claude-code':
      return scope === 'global'
        ? path.join(HOME, '.claude.json')  // user-level MCP in Claude Code
        : path.join(projectRoot, '.mcp.json');
    case 'claw-code':
      return scope === 'global'
        ? path.join(HOME, '.claw', 'settings.json')
        : path.join(projectRoot, '.claw.json');
    case 'claude-desktop':
      // Claude Desktop is always global
      return process.platform === 'darwin'
        ? path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
    case 'cursor':
      return scope === 'global'
        ? path.join(HOME, '.cursor', 'mcp.json')
        : path.join(projectRoot, '.cursor', 'mcp.json');
    case 'windsurf':
      return scope === 'global'
        ? path.join(HOME, '.windsurf', 'mcp.json')
        : path.join(projectRoot, '.windsurf', 'mcp.json');
    case 'continue':
      return scope === 'global'
        ? path.join(HOME, '.continue', 'mcpServers', 'mcp.json')
        : path.join(projectRoot, '.continue', 'mcpServers', 'mcp.json');
    default:
      return null;
  }
}
