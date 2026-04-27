import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { Command } from 'commander';
import { getDaemonHealth } from '../daemon/client.js';
import { ensureDaemon, restartDaemon, stopDaemon, waitForDaemonUp } from '../daemon/lifecycle.js';
import { DAEMON_LOG_PATH, DEFAULT_DAEMON_PORT, LAUNCHD_PLIST_PATH } from '../global.js';

const PLIST_LABEL = 'com.trace-mcp.server';

function isPlistLoaded(): boolean {
  try {
    const output = execSync(`launchctl list ${PLIST_LABEL} 2>&1`, { encoding: 'utf-8' });
    return !output.includes('Could not find service');
  } catch {
    return false;
  }
}

/**
 * Ensure the daemon is running. Cross-platform wrapper over
 * `src/daemon/lifecycle.ensureDaemon`. Returns true if daemon is (or was
 * already) reachable via /health — false on spawn failure.
 */
export async function ensureDaemonRunning(port = DEFAULT_DAEMON_PORT): Promise<boolean> {
  const result = await ensureDaemon({ port });
  return result.ok;
}

export const daemonCommand = new Command('daemon').description(
  'Manage the trace-mcp background daemon',
);

daemonCommand
  .command('start')
  .description('Start the daemon (launchd on macOS, detached process on Win/Linux)')
  .option('-p, --port <port>', 'Port to listen on', String(DEFAULT_DAEMON_PORT))
  .action(async (opts: { port: string }) => {
    const port = parseInt(opts.port, 10);

    const health = await getDaemonHealth(port);
    if (health) {
      console.log(`Daemon is already running on port ${port}.`);
      return;
    }

    const result = await ensureDaemon({ port });
    if (!result.ok) {
      console.error(`Failed to start daemon: ${result.error ?? 'unknown'}`);
      process.exit(1);
    }
    const up = await waitForDaemonUp(port, 10_000);
    if (!up) {
      console.error(`Daemon start issued but /health did not respond on port ${port} within 10s.`);
      console.error(`Check logs: trace-mcp daemon logs`);
      process.exit(1);
    }
    console.log(`Daemon started on port ${port} (strategy: ${result.strategy ?? 'unknown'}).`);
    if (process.platform === 'darwin') {
      console.log(`  Plist: ${LAUNCHD_PLIST_PATH}`);
    }
    console.log(`  Logs:  ${DAEMON_LOG_PATH}`);
  });

daemonCommand
  .command('stop')
  .description('Stop the daemon')
  .action(async () => {
    stopDaemon();
    console.log('Daemon stopped.');
  });

daemonCommand
  .command('restart')
  .description('Restart the daemon')
  .option('-p, --port <port>', 'Port to listen on', String(DEFAULT_DAEMON_PORT))
  .action(async (opts: { port: string }) => {
    const port = parseInt(opts.port, 10);
    const result = restartDaemon({ port });
    if (!result.ok) {
      console.error(`Failed to restart daemon: ${result.error ?? 'unknown'}`);
      process.exit(1);
    }
    // Block until /health responds — callers (the menu bar app's "Restart
    // Daemon" button, scripts, humans) need to know the daemon is actually
    // reachable, not just that launchd accepted the kickstart.
    const up = await waitForDaemonUp(port, 10_000);
    if (!up) {
      console.error(
        `Daemon restart issued but /health did not respond on port ${port} within 10s.`,
      );
      console.error(`Check logs: trace-mcp daemon logs`);
      process.exit(1);
    }
    console.log(`Daemon restarted on port ${port} (strategy: ${result.strategy ?? 'unknown'}).`);
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
