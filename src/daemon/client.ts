import { DEFAULT_DAEMON_PORT } from '../global.js';

export interface DaemonHealthResponse {
  status: 'ok';
  transport: 'http';
  uptime?: number;
  projects?: { root: string; status: string }[];
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
