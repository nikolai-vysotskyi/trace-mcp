import { app, ipcMain, dialog, shell, nativeImage } from 'electron';
import { execSync, exec } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createTray } from './tray';

// GPU stability — use software fallback if GPU process keeps crashing
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
app.commandLine.appendSwitch('disable-features', 'UseSkiaRenderer');

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

    // launchd doesn't inherit shell PATH — embed node's directory so #!/usr/bin/env node works
    const nodeDir = path.dirname(process.execPath);
    const envPath = `${nodeDir}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

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
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${envPath}</string>
  </dict>
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

// IPC: check for CLI update (compares installed npm version vs latest GitHub release)
ipcMain.handle('check-for-update', async () => {
  try {
    // Get currently installed CLI version
    let currentVersion: string;
    try {
      currentVersion = execSync('trace-mcp --version', { encoding: 'utf-8', timeout: 5000 }).trim();
      // Strip leading 'v' if present
      currentVersion = currentVersion.replace(/^v/, '');
    } catch {
      return { available: false, error: 'Could not determine current version' };
    }

    // Fetch latest release from GitHub
    const body = await new Promise<string>((resolve, reject) => {
      const https = require('https');
      https.get('https://api.github.com/repos/nikolai-vysotskyi/trace-mcp/releases/latest', {
        timeout: 10000,
        headers: { 'User-Agent': 'trace-mcp', Accept: 'application/vnd.github.v3+json' },
      }, (res: any) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const loc = res.headers.location;
          if (!loc) { reject(new Error('Redirect without location')); return; }
          https.get(loc, { timeout: 10000, headers: { 'User-Agent': 'trace-mcp', Accept: 'application/vnd.github.v3+json' } }, (res2: any) => {
            let d = ''; res2.on('data', (c: string) => { d += c; }); res2.on('end', () => resolve(d));
          }).on('error', reject);
          return;
        }
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });

    const release = JSON.parse(body);
    if (!release.tag_name) return { available: false };

    const latestVersion = release.tag_name.replace(/^v/, '');
    if (latestVersion === currentVersion) return { available: false, current: currentVersion, latest: latestVersion };

    // Simple semver comparison: split, compare numerically
    const cur = currentVersion.split('.').map(Number);
    const lat = latestVersion.split('.').map(Number);
    let isNewer = false;
    for (let i = 0; i < 3; i++) {
      if ((lat[i] || 0) > (cur[i] || 0)) { isNewer = true; break; }
      if ((lat[i] || 0) < (cur[i] || 0)) break;
    }

    return { available: isNewer, current: currentVersion, latest: latestVersion };
  } catch (err) {
    return { available: false, error: (err as Error).message };
  }
});

// IPC: apply update (runs npm update -g trace-mcp, which triggers postinstall → app update)
ipcMain.handle('apply-update', async () => {
  try {
    execSync('npm update -g trace-mcp', { encoding: 'utf-8', timeout: 120000, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

// IPC: restart the app after update
ipcMain.handle('restart-app', () => {
  app.relaunch();
  app.exit(0);
});

app.whenReady().then(() => {
  // Set custom dock icon BEFORE hiding — macOS caches it for later show()
  if (fs.existsSync(dockIconPath)) {
    app.dock?.setIcon(nativeImage.createFromPath(dockIconPath));
  }
  app.dock?.hide();
  createTray();
});

// GPU process crash recovery — log and continue (Chromium auto-restarts GPU process)
app.on('child-process-gone', (_event, details) => {
  console.error(`[trace-mcp] child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
  // GPU process crashes are recoverable — Chromium restarts it automatically.
  // Only quit if it's a repeated crash (reason=crashed means it was killed, not clean exit).
  // For utility/network service crashes, Chromium also handles restart internally.
});

app.on('render-process-gone', (_event, _webContents, details) => {
  console.error(`[trace-mcp] renderer gone: reason=${details.reason} exitCode=${details.exitCode}`);
  // Don't quit — windows handle their own recovery via webContents.reload()
});

app.on('window-all-closed', () => {
  // Keep running in tray even if all windows are closed
});
