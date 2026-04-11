import { app, ipcMain, dialog, shell, nativeImage } from 'electron';
import { execSync, exec } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createTray } from './tray';

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.name = 'trace-mcp';

const dockIconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');

// IPC: folder picker
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select project root',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// IPC: open file in default editor
ipcMain.handle('open-in-editor', async (_event, filePath: string) => {
  await shell.openPath(filePath);
});

// IPC: restart daemon (kill old, create plist if needed, start new via launchd)
ipcMain.handle('restart-daemon', async () => {
  const home = os.homedir();
  const traceMcpHome = path.join(home, '.trace-mcp');
  const daemonLogPath = path.join(traceMcpHome, 'daemon.log');
  const plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.trace-mcp.server.plist');
  const port = 3741;

  // Unload existing plist if loaded
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`);
  } catch { /* not loaded — fine */ }

  // Create plist if it doesn't exist (same as `trace-mcp daemon start`)
  if (!fs.existsSync(plistPath)) {
    // Find the trace-mcp binary
    let binaryPath: string;
    try {
      binaryPath = execSync('which trace-mcp', { encoding: 'utf-8' }).trim();
    } catch {
      throw new Error('trace-mcp not found in PATH. Install it first: npm i -g trace-mcp');
    }

    const plistDir = path.dirname(plistPath);
    if (!fs.existsSync(plistDir)) {
      fs.mkdirSync(plistDir, { recursive: true });
    }

    fs.writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.trace-mcp.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath}</string>
    <string>serve-http</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${daemonLogPath}</string>
  <key>StandardErrorPath</key>
  <string>${daemonLogPath}</string>
  <key>WorkingDirectory</key>
  <string>${traceMcpHome}</string>
</dict>
</plist>
`, 'utf-8');
  }

  execSync(`launchctl load "${plistPath}"`);
  return { ok: true };
});

// IPC: detect which MCP clients have trace-mcp configured
ipcMain.handle('detect-mcp-clients', async () => {
  const home = os.homedir();
  const platform = process.platform;

  type ClientName = 'claude-code' | 'claw-code' | 'claude-desktop' | 'cursor' | 'windsurf' | 'continue' | 'junie' | 'jetbrains-ai' | 'codex';
  interface DetectedClient { name: ClientName; configPath: string; hasTraceMcp: boolean }
  const clients: DetectedClient[] = [];

  const checkJson = (name: ClientName, configPath: string) => {
    if (!fs.existsSync(configPath)) return;
    try {
      const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const hasTraceMcp = !!content?.mcpServers?.['trace-mcp'];
      clients.push({ name, configPath, hasTraceMcp });
    } catch {
      clients.push({ name, configPath, hasTraceMcp: false });
    }
  };

  // Claude Code
  checkJson('claude-code', path.join(home, '.claude.json'));
  checkJson('claude-code', path.join(home, '.claude', 'settings.json'));

  // Claw Code
  checkJson('claw-code', path.join(home, '.claw', 'settings.json'));

  // Claude Desktop
  if (platform === 'darwin') {
    checkJson('claude-desktop', path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  } else if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    checkJson('claude-desktop', path.join(appData, 'Claude', 'claude_desktop_config.json'));
  }

  // Cursor
  checkJson('cursor', path.join(home, '.cursor', 'mcp.json'));

  // Windsurf
  checkJson('windsurf', path.join(home, '.windsurf', 'mcp.json'));

  // Continue
  checkJson('continue', path.join(home, '.continue', 'mcpServers', 'mcp.json'));

  // Junie
  checkJson('junie', path.join(home, '.junie', 'mcp', 'mcp.json'));

  // JetBrains AI Assistant
  {
    const jbConfigBase = platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'JetBrains')
      : platform === 'win32'
        ? path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'JetBrains')
        : path.join(home, '.config', 'JetBrains');
    if (fs.existsSync(jbConfigBase)) {
      try {
        const dirs = fs.readdirSync(jbConfigBase);
        for (const dir of dirs) {
          const mcpXml = path.join(jbConfigBase, dir, 'options', 'mcpServer.xml');
          if (fs.existsSync(mcpXml)) {
            clients.push({ name: 'jetbrains-ai', configPath: mcpXml, hasTraceMcp: false });
            break;
          }
        }
      } catch { /* ignore */ }
    }
  }

  // Codex
  {
    const checkToml = (name: ClientName, tomlPath: string) => {
      if (!fs.existsSync(tomlPath)) return;
      try {
        const content = fs.readFileSync(tomlPath, 'utf-8');
        const hasTraceMcp = /\[mcp_servers\s*\.\s*["']?trace-mcp["']?\s*\]/.test(content);
        clients.push({ name, configPath: tomlPath, hasTraceMcp });
      } catch {
        clients.push({ name, configPath: tomlPath, hasTraceMcp: false });
      }
    };
    checkToml('codex', path.join(home, '.codex', 'config.toml'));
  }

  return clients;
});

// IPC: configure trace-mcp for a specific MCP client
// level: 'base' (CLAUDE.md only), 'standard' (+ hooks), 'max' (+ hooks + tweakcc)
ipcMain.handle('configure-mcp-client', async (_event, clientName: string, level: string = 'base') => {
  // JetBrains AI uses IDE-internal XML config — cannot be configured from CLI
  if (clientName === 'jetbrains-ai') {
    return { ok: false, error: 'JetBrains AI Assistant must be configured manually in the IDE.' };
  }

  // Compose CLI flags based on enforcement level
  const flags = [`--mcp-client ${clientName}`, '--yes'];

  if (level === 'base') {
    flags.push('--skip-hooks');
  }
  // 'standard' and 'max' both install hooks (no --skip-hooks)
  // 'max' also installs tweakcc, but that's handled automatically by init
  // when no --skip-hooks is passed and tweakcc prompts are available

  // Non-Claude clients don't use hooks/tweakcc, always skip
  const claudeClients = new Set(['claude-code', 'claw-code', 'claude-desktop']);
  if (!claudeClients.has(clientName)) {
    flags.push('--skip-hooks');
  }

  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    exec(`trace-mcp init ${flags.join(' ')}`, {
      timeout: 30_000,
    }, (error) => {
      if (error) {
        resolve({ ok: false, error: error.message });
      } else {
        resolve({ ok: true });
      }
    });
  });
});

app.whenReady().then(() => {
  // Set custom dock icon BEFORE hiding — macOS caches it for later show()
  if (fs.existsSync(dockIconPath)) {
    app.dock?.setIcon(nativeImage.createFromPath(dockIconPath));
  }
  app.dock?.hide();
  createTray();
});

app.on('window-all-closed', () => {
  // Keep running in tray even if all windows are closed
});
