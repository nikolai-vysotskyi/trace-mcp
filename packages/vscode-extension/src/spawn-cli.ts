/**
 * Run `trace-mcp register-edit <relPath>` against a workspace folder.
 *
 * Pure I/O glue. Kept independent of the vscode runtime so unit tests can
 * drive it with a fake `child_process` shim. Failures are logged by the
 * caller — the extension never surfaces a modal or a notification toast
 * for a routine reindex error, since users save files dozens of times an
 * hour and we'd be unbearable.
 */

import { spawn } from 'node:child_process';

export interface SpawnReindexOptions {
  /** Absolute path to the trace-mcp binary (or just "trace-mcp" if on PATH). */
  commandPath: string;
  /** Workspace root — `cwd` for the child process. */
  cwd: string;
  /** Workspace-relative file path passed as the CLI argument. */
  relativePath: string;
  /** Wall-clock budget. We send SIGTERM after this elapses. */
  timeoutMs: number;
  /** Optional log sink — called once on success, once on failure. */
  log?: (msg: string) => void;
}

export interface SpawnReindexResult {
  ok: boolean;
  exitCode: number | null;
  /** When the call timed out and we killed the child. */
  timedOut: boolean;
  /** stderr capture (truncated to 4KB) for diagnostic surfacing. */
  stderr: string;
}

const STDERR_CAP = 4 * 1024;

export function spawnReindex(opts: SpawnReindexOptions): Promise<SpawnReindexResult> {
  return new Promise((resolve) => {
    const child = spawn(opts.commandPath, ['register-edit', opts.relativePath], {
      cwd: opts.cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      // No shell — the path is passed verbatim, args are a fixed array.
      shell: false,
    });

    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs);

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP) {
        stderr += chunk.toString('utf-8');
        if (stderr.length > STDERR_CAP) stderr = stderr.slice(0, STDERR_CAP);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      // ENOENT / EPERM / spawn failures land here. We surface a clear
      // message to the log sink so operators can fix `commandPath`.
      opts.log?.(`trace-mcp spawn failed: ${err.message}`);
      resolve({ ok: false, exitCode: null, timedOut: false, stderr: err.message });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const ok = code === 0 && !timedOut;
      if (!ok) {
        opts.log?.(
          `trace-mcp register-edit ${opts.relativePath} exited code=${code} timedOut=${timedOut}` +
            (stderr ? ` stderr=${stderr.slice(0, 200)}` : ''),
        );
      }
      resolve({ ok, exitCode: code, timedOut, stderr });
    });
  });
}
