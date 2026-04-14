import os from 'os';
import path from 'path';
import fs from 'fs';
import { execSync, spawn } from 'child_process';

const PLIST_LABEL = 'com.trace-mcp.server';
const DEFAULT_PORT = 3741;

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

// ── macOS: launchd plist ──────────────────────────────────────

function getPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
}

function ensureDaemonMac(): { ok: boolean; error?: string } {
  const home = os.homedir();
  const traceMcpHome = path.join(home, '.trace-mcp');
  const daemonLogPath = path.join(traceMcpHome, 'daemon.log');
  const plistPath = getPlistPath();

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

function restartDaemonMac(): { ok: boolean; error?: string } {
  const plistPath = getPlistPath();
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`);
  } catch { /* not loaded — fine */ }
  return ensureDaemonMac();
}

// ── Windows / Linux: detached process with PID file ───────────

function getPidFilePath(): string {
  return path.join(os.homedir(), '.trace-mcp', 'daemon.pid');
}

function getLogFilePath(): string {
  return path.join(os.homedir(), '.trace-mcp', 'daemon.log');
}

function readDaemonPid(): number | null {
  const pidFile = getPidFilePath();
  if (!fs.existsSync(pidFile)) return null;
  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
  if (isNaN(pid)) return null;
  // Check if process is still running
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    // Process is dead — clean up stale PID file
    try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
    return null;
  }
}

function stopDaemonByPid(): void {
  const pid = readDaemonPid();
  if (pid === null) return;
  try {
    if (isWin) {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'pipe' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch { /* already dead */ }
  const pidFile = getPidFilePath();
  try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
}

function ensureDaemonGeneric(): { ok: boolean; error?: string } {
  // Already running?
  if (readDaemonPid() !== null) {
    return { ok: true };
  }

  const traceMcpHome = path.join(os.homedir(), '.trace-mcp');
  if (!fs.existsSync(traceMcpHome)) {
    fs.mkdirSync(traceMcpHome, { recursive: true });
  }

  let binaryPath: string;
  try {
    if (isWin) {
      binaryPath = execSync('where trace-mcp', { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
    } else {
      binaryPath = execSync('which trace-mcp', { encoding: 'utf-8' }).trim();
    }
  } catch {
    return { ok: false, error: 'trace-mcp not found in PATH' };
  }

  const logPath = getLogFilePath();
  const logFd = fs.openSync(logPath, 'a');

  const child = spawn(binaryPath, ['serve-http', '--port', String(DEFAULT_PORT)], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: traceMcpHome,
    env: { ...process.env },
    // On Windows, use shell to resolve .cmd/.bat wrappers (npm global installs)
    shell: isWin,
    windowsHide: true,
  });

  child.unref();
  fs.closeSync(logFd);

  if (child.pid) {
    fs.writeFileSync(getPidFilePath(), String(child.pid), 'utf-8');
  }

  return { ok: true };
}

function restartDaemonGeneric(): { ok: boolean; error?: string } {
  stopDaemonByPid();
  return ensureDaemonGeneric();
}

// ── Public API ────────────────────────────────────────────────

export function ensureDaemon(): { ok: boolean; error?: string } {
  return isMac ? ensureDaemonMac() : ensureDaemonGeneric();
}

export function restartDaemon(): { ok: boolean; error?: string } {
  return isMac ? restartDaemonMac() : restartDaemonGeneric();
}
