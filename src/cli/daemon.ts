import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { TRACE_MCP_HOME, DEFAULT_DAEMON_PORT, DAEMON_LOG_PATH, LAUNCHD_PLIST_PATH } from '../global.js';
import { getDaemonHealth } from '../daemon/client.js';

const PLIST_LABEL = 'com.trace-mcp.server';

function getTraceMcpBinary(): string {
  // Prefer the resolved path of the currently running binary
  const argv1 = process.argv[1];
  if (argv1 && fs.existsSync(argv1)) {
    return path.resolve(argv1);
  }
  // Fallback: look up in PATH
  try {
    return execSync('which trace-mcp', { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('Could not find trace-mcp binary. Ensure it is installed and in PATH.');
  }
}

function resolveNodePath(): string {
  // launchd doesn't inherit shell PATH, so we must embed it in the plist.
  // Derive from the node binary running right now.
  const nodeDir = path.dirname(process.execPath);
  // Merge with a minimal fallback PATH so basic unix tools work too.
  const fallback = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  return `${nodeDir}:${fallback}`;
}

function generatePlist(binaryPath: string, port: number): string {
  const envPath = resolveNodePath();
  return `<?xml version="1.0" encoding="UTF-8"?>
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
  <string>${DAEMON_LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${DAEMON_LOG_PATH}</string>
  <key>WorkingDirectory</key>
  <string>${TRACE_MCP_HOME}</string>
</dict>
</plist>
`;
}

function installPlist(port: number): void {
  const binaryPath = getTraceMcpBinary();
  const plistContent = generatePlist(binaryPath, port);

  // Ensure LaunchAgents directory exists
  const plistDir = path.dirname(LAUNCHD_PLIST_PATH);
  if (!fs.existsSync(plistDir)) {
    fs.mkdirSync(plistDir, { recursive: true });
  }

  fs.writeFileSync(LAUNCHD_PLIST_PATH, plistContent, 'utf-8');
}

function isPlistLoaded(): boolean {
  try {
    const output = execSync(`launchctl list ${PLIST_LABEL} 2>&1`, { encoding: 'utf-8' });
    return !output.includes('Could not find service');
  } catch {
    return false;
  }
}

export const daemonCommand = new Command('daemon')
  .description('Manage the trace-mcp background daemon');

daemonCommand
  .command('start')
  .description('Start the daemon (installs launchd plist and loads it)')
  .option('-p, --port <port>', 'Port to listen on', String(DEFAULT_DAEMON_PORT))
  .action(async (opts: { port: string }) => {
    const port = parseInt(opts.port, 10);

    if (process.platform !== 'darwin') {
      console.error('Daemon management via launchd is only supported on macOS.');
      console.log(`Run manually: trace-mcp serve-http --port ${port}`);
      process.exit(1);
    }

    // Check if already running
    const health = await getDaemonHealth(port);
    if (health) {
      console.log(`Daemon is already running on port ${port}.`);
      return;
    }

    // Stop any existing loaded plist first
    if (isPlistLoaded()) {
      try {
        execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}" 2>/dev/null`);
      } catch { /* ignore */ }
    }

    installPlist(port);
    execSync(`launchctl load "${LAUNCHD_PLIST_PATH}"`);
    console.log(`Daemon started on port ${port}.`);
    console.log(`  Plist: ${LAUNCHD_PLIST_PATH}`);
    console.log(`  Logs:  ${DAEMON_LOG_PATH}`);
  });

daemonCommand
  .command('stop')
  .description('Stop the daemon (unloads launchd plist)')
  .action(async () => {
    if (process.platform !== 'darwin') {
      console.error('Daemon management via launchd is only supported on macOS.');
      process.exit(1);
    }

    if (!isPlistLoaded()) {
      console.log('Daemon is not running.');
      return;
    }

    try {
      execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}"`);
      console.log('Daemon stopped.');
    } catch (e: any) {
      console.error(`Failed to stop daemon: ${e.message}`);
      process.exit(1);
    }
  });

daemonCommand
  .command('restart')
  .description('Restart the daemon')
  .option('-p, --port <port>', 'Port to listen on', String(DEFAULT_DAEMON_PORT))
  .action(async (opts: { port: string }) => {
    if (process.platform !== 'darwin') {
      console.error('Daemon management via launchd is only supported on macOS.');
      process.exit(1);
    }

    const port = parseInt(opts.port, 10);

    // Stop
    if (isPlistLoaded()) {
      try {
        execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}"`);
      } catch { /* ignore */ }
    }

    // Start
    installPlist(port);
    execSync(`launchctl load "${LAUNCHD_PLIST_PATH}"`);
    console.log(`Daemon restarted on port ${port}.`);
  });

daemonCommand
  .command('status')
  .description('Show daemon status')
  .option('-p, --port <port>', 'Port to check', String(DEFAULT_DAEMON_PORT))
  .action(async (opts: { port: string }) => {
    const port = parseInt(opts.port, 10);
    const health = await getDaemonHealth(port);

    if (!health) {
      console.log(`Daemon is not reachable on port ${port}.`);
      if (process.platform === 'darwin') {
        const loaded = isPlistLoaded();
        console.log(`  launchd plist: ${loaded ? 'loaded' : 'not loaded'}`);
        console.log(`  Plist path: ${LAUNCHD_PLIST_PATH}`);
      }
      process.exit(1);
    }

    console.log(`Daemon is running on port ${port}.`);
    if (health.uptime != null) {
      const h = Math.floor(health.uptime / 3600);
      const m = Math.floor((health.uptime % 3600) / 60);
      console.log(`  Uptime: ${h}h ${m}m`);
    }
    if (health.projects) {
      console.log(`  Projects: ${health.projects.length}`);
      for (const p of health.projects) {
        console.log(`    ${p.root} [${p.status}]`);
      }
    }
  });

daemonCommand
  .command('logs')
  .description('Tail the daemon log file')
  .option('-n, --lines <n>', 'Number of lines to show', '50')
  .option('-f, --follow', 'Follow log output')
  .action((opts: { lines: string; follow?: boolean }) => {
    const logPath = DAEMON_LOG_PATH;
    if (!fs.existsSync(logPath)) {
      console.log(`No log file found at ${logPath}`);
      process.exit(1);
    }

    const args = ['-n', opts.lines];
    if (opts.follow) args.push('-f');
    args.push(logPath);

    const tail = spawn('tail', args, { stdio: 'inherit' });
    tail.on('exit', (code) => process.exit(code ?? 0));
  });
