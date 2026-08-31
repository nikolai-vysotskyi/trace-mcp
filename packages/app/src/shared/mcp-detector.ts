import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DetectedMcpClient } from './mcp-detector-types';

export * from './mcp-detector-types';

function readIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function vscodeUserDir(platform = os.platform(), home = os.homedir()): string {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User');
  }
  if (platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Code', 'User');
  }
  return path.join(home, '.config', 'Code', 'User');
}

/**
 * Single source of truth for detecting installed MCP clients and their configurations.
 * Reused across the CLI init command and Electron desktop app.
 */
export function detectMcpClients(projectRoot?: string, customHome?: string): DetectedMcpClient[] {
  const HOME = customHome ?? os.homedir();
  const platform = os.platform();
  const clients: DetectedMcpClient[] = [];

  const checkConfig = (name: DetectedMcpClient['name'], configPath: string) => {
    try {
      const raw = readIfExists(configPath);
      if (raw === null) return;
      const content = JSON.parse(raw);
      const hasTraceMcp = !!content?.mcpServers?.['trace-mcp'];
      clients.push({ name, configPath, hasTraceMcp });
    } catch {
      // Malformed JSON — still report as detected but without trace-mcp
      clients.push({ name, configPath, hasTraceMcp: false });
    }
  };

  // Claude Code: project-level .mcp.json (only if projectRoot given)
  if (projectRoot) {
    checkConfig('claude-code', path.join(projectRoot, '.mcp.json'));
  }
  // Claude Code: global — mcpServers can live in either file
  checkConfig('claude-code', path.join(HOME, '.claude.json'));
  checkConfig('claude-code', path.join(HOME, '.claude', 'settings.json'));

  // Claw Code: project-level .claw.json
  if (projectRoot) {
    checkConfig('claw-code', path.join(projectRoot, '.claw.json'));
  }
  // Claw Code: global settings
  checkConfig('claw-code', path.join(HOME, '.claw', 'settings.json'));

  // Claude Desktop
  if (platform === 'darwin') {
    checkConfig(
      'claude-desktop',
      path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    );
  } else if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming');
    checkConfig('claude-desktop', path.join(appData, 'Claude', 'claude_desktop_config.json'));
  }

  // Cursor: global first, then project-level
  checkConfig('cursor', path.join(HOME, '.cursor', 'mcp.json'));
  if (projectRoot && !clients.some((c) => c.name === 'cursor')) {
    checkConfig('cursor', path.join(projectRoot, '.cursor', 'mcp.json'));
  }

  // Windsurf: global first, then project-level
  checkConfig('windsurf', path.join(HOME, '.windsurf', 'mcp.json'));
  if (projectRoot && !clients.some((c) => c.name === 'windsurf')) {
    checkConfig('windsurf', path.join(projectRoot, '.windsurf', 'mcp.json'));
  }

  // Continue: global mcpServers dir first, then project-level
  checkConfig('continue', path.join(HOME, '.continue', 'mcpServers', 'mcp.json'));
  if (projectRoot && !clients.some((c) => c.name === 'continue')) {
    checkConfig('continue', path.join(projectRoot, '.continue', 'mcpServers', 'mcp.json'));
  }

  // Junie: global ~/.junie/mcp/mcp.json, project .junie/mcp/mcp.json
  checkConfig('junie', path.join(HOME, '.junie', 'mcp', 'mcp.json'));
  if (projectRoot && !clients.some((c) => c.name === 'junie')) {
    checkConfig('junie', path.join(projectRoot, '.junie', 'mcp', 'mcp.json'));
  }

  // JetBrains AI Assistant: detect via IDE mcpServer.xml in JetBrains config dirs
  {
    const jbConfigBase =
      platform === 'darwin'
        ? path.join(HOME, 'Library', 'Application Support', 'JetBrains')
        : platform === 'win32'
          ? path.join(process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming'), 'JetBrains')
          : path.join(HOME, '.config', 'JetBrains');

    if (fs.existsSync(jbConfigBase)) {
      try {
        const dirs = fs.readdirSync(jbConfigBase);
        for (const dir of dirs) {
          const mcpXml = path.join(jbConfigBase, dir, 'options', 'mcpServer.xml');
          if (fs.existsSync(mcpXml)) {
            // Found at least one JetBrains IDE with MCP support
            clients.push({ name: 'jetbrains-ai', configPath: mcpXml, hasTraceMcp: false });
            break;
          }
        }
      } catch {
        /* can't read dir */
      }
    }
  }

  // Codex: global ~/.codex/config.toml, project .codex/config.toml
  {
    const checkToml = (name: DetectedMcpClient['name'], tomlPath: string) => {
      try {
        const content = readIfExists(tomlPath);
        if (content === null) return;
        const hasTraceMcp = /\[mcp_servers\s*\.\s*["']?trace-mcp["']?\s*\]/.test(content);
        clients.push({ name, configPath: tomlPath, hasTraceMcp });
      } catch {
        clients.push({ name, configPath: tomlPath, hasTraceMcp: false });
      }
    };

    checkToml('codex', path.join(HOME, '.codex', 'config.toml'));
    if (projectRoot && !clients.some((c) => c.name === 'codex')) {
      checkToml('codex', path.join(projectRoot, '.codex', 'config.toml'));
    }
  }

  // AMP (Sourcegraph): JSON/JSONC at ~/.config/amp/settings.json[c],
  // workspace at .amp/settings.json[c]. Top-level key is `amp.mcpServers`
  {
    const checkAmp = (configPath: string) => {
      try {
        const content = readIfExists(configPath);
        if (content === null) return;
        const hasTraceMcp = /["'](?:amp\.)?mcpServers["'][\s\S]*?["']trace-mcp["']/.test(content);
        clients.push({ name: 'amp', configPath, hasTraceMcp });
      } catch {
        clients.push({ name: 'amp', configPath, hasTraceMcp: false });
      }
    };
    const ampUserBase = path.join(HOME, '.config', 'amp');
    for (const file of ['settings.jsonc', 'settings.json']) {
      const p = path.join(ampUserBase, file);
      if (fs.existsSync(p)) {
        checkAmp(p);
        break;
      }
    }
    if (projectRoot && !clients.some((c) => c.name === 'amp')) {
      const ampProjectBase = path.join(projectRoot, '.amp');
      for (const file of ['settings.jsonc', 'settings.json']) {
        const p = path.join(ampProjectBase, file);
        if (fs.existsSync(p)) {
          checkAmp(p);
          break;
        }
      }
    }
  }

  // Factory Droid: JSON at ~/.factory/mcp.json (user) or .factory/mcp.json (project).
  checkConfig('factory-droid', path.join(HOME, '.factory', 'mcp.json'));
  if (projectRoot && !clients.some((c) => c.name === 'factory-droid')) {
    checkConfig('factory-droid', path.join(projectRoot, '.factory', 'mcp.json'));
  }

  // Warp: detection via app presence
  {
    const warpPaths =
      platform === 'darwin'
        ? ['/Applications/Warp.app', path.join(HOME, 'Applications', 'Warp.app')]
        : platform === 'win32'
          ? [
              path.join(
                process.env.LOCALAPPDATA ?? path.join(HOME, 'AppData', 'Local'),
                'Programs',
                'Warp',
              ),
            ]
          : [path.join(HOME, '.local', 'share', 'warp-terminal'), '/usr/bin/warp-terminal'];
    const installed = warpPaths.some((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    if (installed) {
      clients.push({
        name: 'warp',
        configPath: '<Warp Settings → Agents → MCP servers>',
        hasTraceMcp: false,
      });
    }
  }

  // Hermes Agent: always-global YAML config at ~/.hermes/config.yaml (or $HERMES_HOME).
  {
    const hermesHome = process.env.HERMES_HOME ?? path.join(HOME, '.hermes');
    const yamlPath = path.join(hermesHome, 'config.yaml');
    try {
      const content = readIfExists(yamlPath);
      if (content !== null) {
        const hasTraceMcp = /^mcp_servers\s*:\s*$[\s\S]*?^\s+trace-mcp\s*:/m.test(content);
        clients.push({ name: 'hermes', configPath: yamlPath, hasTraceMcp });
      }
    } catch {
      clients.push({ name: 'hermes', configPath: yamlPath, hasTraceMcp: false });
    }
  }

  const vscUser = vscodeUserDir(platform, HOME);

  // Cline
  {
    const clineDir = path.join(
      vscUser,
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
    );
    if (fs.existsSync(clineDir)) {
      checkConfig('cline', path.join(clineDir, 'cline_mcp_settings.json'));
    }
  }

  // KiloCode
  {
    const kiloDir = path.join(vscUser, 'globalStorage', 'kilocode.kilo-code', 'settings');
    if (fs.existsSync(kiloDir)) {
      checkConfig('kilocode', path.join(kiloDir, 'mcp_settings.json'));
    }
  }

  // Antigravity
  checkConfig('antigravity', path.join(HOME, '.gemini', 'config', 'mcp_config.json'));

  // Kimi Code CLI
  checkConfig('kimi', path.join(HOME, '.kimi', 'mcp.json'));

  return clients;
}
