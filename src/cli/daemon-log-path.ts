import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Find the log currently held open by the daemon, without trusting the CLI's profile. */
export function findProcessDaemonLog(pid: number, platform = process.platform): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;

  try {
    if (platform === 'darwin') {
      const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', '1,2', '-Fn'], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of output.split(/\r?\n/)) {
        if (line.startsWith('n') && isDaemonLog(line.slice(1))) return line.slice(1);
      }
    } else if (platform === 'linux') {
      for (const fd of [1, 2]) {
        try {
          const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
          if (isDaemonLog(target)) return target;
        } catch {
          // A descriptor can be closed or inaccessible; try the other one.
        }
      }
    }
  } catch {
    // lsof may be unavailable or the process may have exited.
  }
  return null;
}

function isDaemonLog(file: string): boolean {
  return path.isAbsolute(file) && path.basename(file) === 'daemon.log';
}
