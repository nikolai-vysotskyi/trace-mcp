/**
 * MCP client configuration: detect and write trace-mcp server entries.
 * Supports both project-scoped and global installation.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import type { DetectedMcpClient, InitStepResult } from './types.js';

const HOME = os.homedir();

/**
 * Detect whether Claude Desktop (the unified Claude.app on macOS, or the
 * Claude Desktop binary on Windows/Linux) is currently running.
 *
 * Why this matters: Claude.app owns `claude_desktop_config.json` at runtime
 * and rewrites the whole file whenever its `preferences` change, WITHOUT
 * preserving foreign top-level keys like `mcpServers`. So if we write an
 * mcpServers entry while the app is open, the next preferences update
 * silently drops it.
 */
function isClaudeDesktopRunning(): boolean {
  try {
    if (process.platform === 'darwin') {
      // Can't use `pgrep -x Claude` — on macOS ps reports the full bundle path
      // as the comm, and `-x` needs an exact match. Can't use `pgrep Claude`
      // either — it would also match the Claude Code CLI (lowercase `claude`
      // binary in ~/.cursor/... or ~/Library/.../claude.app). Match the
      // unified-app bundle path explicitly.
      const out = execSync('ps -A -o command=', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return /\/Applications\/Claude\.app\/Contents\/MacOS\/Claude(?:\s|$)/m.test(out);
    }
    if (process.platform === 'linux') {
      // Linux Claude Desktop binary is `claude-desktop` — distinct from Code CLI.
      execSync('pgrep -x claude-desktop', { stdio: 'ignore' });
      return true;
    }
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq Claude.exe" /FO CSV /NH', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return /Claude\.exe/i.test(out);
    }
  } catch {
    // Non-zero exit or missing tool — treat as not running.
  }
  return false;
}

interface McpServerEntry {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** Clients that launch as GUI apps and don't inherit the user's shell PATH */
const GUI_CLIENTS: ReadonlySet<string> = new Set([
  'claude-desktop', 'cursor', 'windsurf', 'continue', 'junie', 'codex', 'jetbrains-ai',
]);

/**
 * Resolve absolute path to the trace-mcp binary + minimal PATH env
 * so GUI apps (which don't source ~/.zshrc) can find both the binary and node.
 *
 * Returns bare 'trace-mcp' for terminal clients that inherit shell PATH.
 */
function resolveGuiCommand(): { command: string; env: Record<string, string> } {
  const SYSTEM_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  const nodeBinDir = path.dirname(process.execPath);

  // process.argv[1] is the trace-mcp script path — absolute for global installs
  const scriptPath = process.argv[1];
  if (scriptPath && path.isAbsolute(scriptPath) && fs.existsSync(scriptPath)) {
    const scriptBinDir = path.dirname(scriptPath);
    const dirs = new Set([scriptBinDir, nodeBinDir]);
    return {
      command: scriptPath,
      env: { PATH: [...dirs].join(':') + ':' + SYSTEM_PATH },
    };
  }

  // Fallback: check if trace-mcp lives next to node (common for npm -g)
  const candidate = path.join(nodeBinDir, 'trace-mcp');
  if (fs.existsSync(candidate)) {
    return {
      command: candidate,
      env: { PATH: nodeBinDir + ':' + SYSTEM_PATH },
    };
  }

  // Last resort: bare command with current PATH snapshot
  return {
    command: 'trace-mcp',
    env: { PATH: process.env.PATH ?? SYSTEM_PATH },
  };
}

type McpScope = 'global' | 'project';

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
    // JetBrains AI Assistant: config stored in IDE XML (llm.mcpServers.xml), not editable as JSON.
    // If Claude Desktop is also selected, user can "Import from Claude" in the IDE.
    if (name === 'jetbrains-ai') {
      const hasClaudeDesktop = clientNames.includes('claude-desktop');
      results.push({
        target: 'JetBrains AI Assistant',
        action: 'skipped',
        detail: hasClaudeDesktop
          ? 'Use "Import from Claude" in Settings → Tools → AI Assistant → MCP'
          : 'Add via Settings → Tools → AI Assistant → MCP → Add → Command: trace-mcp, Args: serve',
      });
      continue;
    }

    // Codex: TOML format
    if (name === 'codex') {
      const configPath = getConfigPath(name, projectRoot, opts.scope);
      if (!configPath) {
        results.push({ target: name, action: 'skipped', detail: 'Unknown client' });
        continue;
      }

      // Check if already configured
      if (fs.existsSync(configPath)) {
        try {
          const content = fs.readFileSync(configPath, 'utf-8');
          if (/\[mcp_servers\s*\.\s*["']?trace-mcp["']?\s*\]/.test(content)) {
            results.push({ target: configPath, action: 'already_configured', detail: name });
            continue;
          }
        } catch { /* malformed — will append */ }
      }

      if (opts.dryRun) {
        results.push({ target: configPath, action: 'skipped', detail: `Would configure ${name} (${opts.scope})` });
        continue;
      }

      try {
        const resolved = resolveGuiCommand();
        const action = writeCodexTomlEntry(configPath, { ...resolved, args: ['serve'], cwd: projectRoot });
        results.push({ target: configPath, action, detail: `${name} (${opts.scope})` });
      } catch (err) {
        results.push({ target: configPath, action: 'skipped', detail: `Error: ${(err as Error).message}` });
      }
      continue;
    }

    // All other clients: JSON format with mcpServers key
    const configPath = getConfigPath(name, projectRoot, opts.scope);
    if (!configPath) {
      results.push({ target: name, action: 'skipped', detail: 'Unknown client' });
      continue;
    }

    // Claude Desktop (the unified Claude.app) rewrites claude_desktop_config.json
    // whenever its own preferences change, dropping any foreign top-level keys.
    // If it's running during init, our write wins briefly and then gets clobbered
    // on the next preferences flush. Refuse to write and tell the user to quit.
    if (name === 'claude-desktop' && !opts.dryRun && isClaudeDesktopRunning()) {
      results.push({
        target: configPath,
        action: 'skipped',
        detail:
          'Claude.app is running — it will overwrite mcpServers. Quit Claude.app completely (Cmd+Q on macOS), then re-run `trace-mcp init`.',
      });
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

    // GUI clients need absolute path + env.PATH because they don't inherit shell PATH.
    // Terminal clients (claude-code, claw-code) work fine with bare 'trace-mcp'.
    const isGui = GUI_CLIENTS.has(name);
    const entry: McpServerEntry = isGui
      ? { ...resolveGuiCommand(), args: ['serve'] }
      : { command: 'trace-mcp', args: ['serve'] };

    // Global scope always needs cwd since server starts from anywhere.
    // Project scope for claude-code doesn't need cwd (.mcp.json is in project root).
    if (opts.scope === 'global' || (name !== 'claude-code' && name !== 'claw-code')) {
      entry.cwd = projectRoot;
    }

    try {
      const action = writeJsonEntry(configPath, entry);

      // For Claude Desktop specifically, verify the write survived. The app
      // may have been launched between our isClaudeDesktopRunning() check
      // and now; if it flushed preferences, our entry is already gone.
      if (name === 'claude-desktop' && !verifyTraceMcpEntry(configPath)) {
        results.push({
          target: configPath,
          action: 'skipped',
          detail:
            'Write was overwritten by Claude.app. Quit Claude.app completely (Cmd+Q on macOS), then re-run `trace-mcp init`.',
        });
        continue;
      }

      results.push({ target: configPath, action, detail: `${name} (${opts.scope})` });
    } catch (err) {
      results.push({ target: configPath, action: 'skipped', detail: `Error: ${(err as Error).message}` });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// JSON writers (Claude Code, Claw, Claude Desktop, Cursor, Windsurf, Continue, Junie)
// ---------------------------------------------------------------------------

/**
 * Verify that `mcpServers['trace-mcp']` is present on disk. Used after writing
 * Claude Desktop's config to detect the Claude.app overwrite race.
 */
function verifyTraceMcpEntry(configPath: string): boolean {
  try {
    const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return Boolean(content?.mcpServers?.['trace-mcp']);
  } catch {
    return false;
  }
}

function writeJsonEntry(configPath: string, entry: McpServerEntry): 'created' | 'updated' {
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

// ---------------------------------------------------------------------------
// TOML writer (Codex)
// ---------------------------------------------------------------------------

function writeCodexTomlEntry(configPath: string, entry: McpServerEntry): 'created' | 'updated' {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const argsToml = entry.args.map((a) => `"${a}"`).join(', ');
  const section = [
    '',
    '[mcp_servers.trace-mcp]',
    `command = "${entry.command}"`,
    `args = [${argsToml}]`,
  ];
  if (entry.cwd) {
    section.push(`cwd = "${entry.cwd}"`);
  }
  if (entry.env) {
    section.push('[mcp_servers.trace-mcp.env]');
    for (const [k, v] of Object.entries(entry.env)) {
      section.push(`${k} = "${v}"`);
    }
  }
  const block = section.join('\n') + '\n';

  let isNew = true;
  if (fs.existsSync(configPath)) {
    const existing = fs.readFileSync(configPath, 'utf-8');
    isNew = false;
    fs.writeFileSync(configPath, existing.trimEnd() + '\n' + block);
  } else {
    fs.writeFileSync(configPath, block.trimStart());
  }

  return isNew ? 'created' : 'updated';
}

// ---------------------------------------------------------------------------
// Config path resolution
// ---------------------------------------------------------------------------

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
    case 'junie':
      return scope === 'global'
        ? path.join(HOME, '.junie', 'mcp', 'mcp.json')
        : path.join(projectRoot, '.junie', 'mcp', 'mcp.json');
    case 'codex':
      return scope === 'global'
        ? path.join(HOME, '.codex', 'config.toml')
        : path.join(projectRoot, '.codex', 'config.toml');
    case 'jetbrains-ai':
      return null; // Configured through IDE Settings UI, not a file we can write
    default:
      return null;
  }
}
