import os from 'os';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

const PLIST_LABEL = 'com.trace-mcp.server';
const DEFAULT_PORT = 3741;

function getPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
}

/**
 * Ensure the daemon is running. Creates the launchd plist if missing,
 * then loads it. Safe to call repeatedly — launchctl load is a no-op
 * if the plist is already loaded.
 */
export function ensureDaemon(): { ok: boolean; error?: string } {
  const home = os.homedir();
  const traceMcpHome = path.join(home, '.trace-mcp');
  const daemonLogPath = path.join(traceMcpHome, 'daemon.log');
  const plistPath = getPlistPath();

  // Create plist if it doesn't exist
  if (!fs.existsSync(plistPath)) {
    let binaryPath: string;
    try {
      binaryPath = execSync('which trace-mcp', { encoding: 'utf-8' }).trim();
    } catch {
      return { ok: false, error: 'trace-mcp not found in PATH' };
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
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath}</string>
    <string>serve-http</string>
    <string>--port</string>
    <string>${DEFAULT_PORT}</string>
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

  try {
    execSync(`launchctl load "${plistPath}" 2>/dev/null`);
  } catch { /* already loaded — fine */ }
  return { ok: true };
}

export function restartDaemon(): { ok: boolean; error?: string } {
  const plistPath = getPlistPath();
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`);
  } catch { /* not loaded — fine */ }
  return ensureDaemon();
}
