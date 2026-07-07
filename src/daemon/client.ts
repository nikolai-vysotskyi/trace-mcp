import { DEFAULT_DAEMON_PORT } from '../global.js';

export interface DaemonHealthResponse {
  /**
   * `"starting"` means the daemon has bound its listener and is answering
   * /health but is still running startup indexing (#237). It is ALIVE — a
   * "starting" response must never be interpreted as a dead daemon.
   */
  status: 'ok' | 'starting';
  transport: 'http';
  /** Daemon version (PKG_VERSION of the running serve-http process). */
  version?: string;
  /** OS process id of the running daemon. */
  pid?: number;
  uptime?: number;
  projects?: { root: string; status: string }[];
  /** Present only while `status === "starting"`. */
  phase?: 'startup_index';
  /** Present only while `status === "starting"`: cheap per-project progress. */
  progress?: { projectsReady: number; projectsTotal: number };
}

/**
 * A daemon that responds to /health at all is alive — whether it reports "ok"
 * or "starting". Every "is the daemon dead → respawn" decision must go through
 * this so a live-but-indexing daemon is never respawned (#237 restart war).
 */
export function isDaemonAlive(health: DaemonHealthResponse | null): boolean {
  return health !== null;
}

/**
 * Check if the daemon is running by pinging its health endpoint.
 * Returns the health response if reachable, null otherwise.
 */
export async function getDaemonHealth(
  port = DEFAULT_DAEMON_PORT,
): Promise<DaemonHealthResponse | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    return (await res.json()) as DaemonHealthResponse;
  } catch {
    return null;
  }
}

/** Returns true if the daemon is reachable on the given port. */
export async function isDaemonRunning(port = DEFAULT_DAEMON_PORT): Promise<boolean> {
  const health = await getDaemonHealth(port);
  return health !== null;
}
