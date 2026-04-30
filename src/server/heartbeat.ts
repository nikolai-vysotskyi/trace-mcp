/**
 * Heartbeat sentinel — bridge between trace-mcp server and guard hook.
 *
 * The server periodically touches $TMPDIR/trace-mcp-alive-{projectHash}.
 * The PreToolUse guard hook checks this file's mtime: if it is missing
 * or stale (>STALE_THRESHOLD_SEC), the server is considered unavailable
 * and the hook allows fallback Read on code files instead of hard-blocking.
 *
 * This closes the legitimate fallback case ("session not found", crashed
 * server, server not running) without re-introducing the retry-bypass
 * loophole that allowed agents to ignore trace-mcp entirely.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectHash } from '../global.js';

const HEARTBEAT_INTERVAL_MS = 10_000;

export interface HeartbeatHandle {
  /** Stop the heartbeat timer and remove the sentinel file. */
  stop(): void;
  /** Path of the sentinel file (for tests). */
  readonly path: string;
}

function sentinelPath(projectRoot: string): string {
  return path.join(os.tmpdir(), `trace-mcp-alive-${projectHash(path.resolve(projectRoot))}`);
}

/**
 * Start writing a heartbeat sentinel for the given project.
 * Best-effort: any I/O error is swallowed — heartbeat is a hint to the
 * guard hook, never a hard requirement for tool execution.
 */
export function startHeartbeat(projectRoot: string): HeartbeatHandle {
  const file = sentinelPath(projectRoot);

  const touch = () => {
    try {
      fs.writeFileSync(file, String(Date.now()), { flag: 'w' });
    } catch {
      /* best-effort */
    }
  };

  touch();
  const timer = setInterval(touch, HEARTBEAT_INTERVAL_MS);
  // Don't keep the event loop alive just for the heartbeat.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    path: file,
    stop() {
      clearInterval(timer);
      try {
        fs.unlinkSync(file);
      } catch {
        /* best-effort */
      }
    },
  };
}
