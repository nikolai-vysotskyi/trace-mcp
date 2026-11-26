import fs from 'node:fs';
import path from 'node:path';

/** Find the Multica task owning either the CLI entry or its working directory. */
export function findMulticaTaskRoot(entryPath: string, cwd: string): string | null {
  for (const start of [entryPath ? path.dirname(path.resolve(entryPath)) : '', cwd]) {
    if (!start) continue;
    let dir = path.resolve(start);
    while (true) {
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(dir, '.task_owner'), 'utf8')) as {
          task_id?: unknown;
        };
        if (typeof owner.task_id === 'string' && owner.task_id) return dir;
      } catch {
        // Not a task root.
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** Refuse an unsupervised daemon before it binds a port or claims daemon.pid. */
export function multicaTaskDaemonRefusal(
  entryPath: string,
  cwd: string,
  explicitlyAllowed: boolean,
): string | null {
  if (explicitlyAllowed || !findMulticaTaskRoot(entryPath, cwd)) return null;
  return (
    'trace serve-http cannot run directly inside a Multica task: the process can outlive the task.\n' +
    'Use a supervised `multica env start` service with TRACE_MCP_ALLOW_EPHEMERAL_DAEMON=1. ' +
    'For a short test with the same override, stop the exact child PID before the task ends.'
  );
}
