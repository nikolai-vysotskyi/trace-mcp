import { describe, expect, it } from 'vitest';
import { isDaemonAlive, type DaemonHealthResponse } from '../client.js';

// Issue #237: every client-side "daemon dead → respawn" decision must treat an
// HTTP 200 with status "starting" as ALIVE. A live-but-indexing daemon returns
// "starting"; concluding it is dead and respawning it is exactly what fed the
// restart war. Only a genuinely unreachable /health (null) means dead.

describe('isDaemonAlive', () => {
  it('treats a "starting" daemon as alive', () => {
    const health: DaemonHealthResponse = {
      status: 'starting',
      transport: 'http',
      phase: 'startup_index',
      progress: { projectsReady: 1, projectsTotal: 8 },
    };
    expect(isDaemonAlive(health)).toBe(true);
  });

  it('treats an "ok" daemon as alive', () => {
    const health: DaemonHealthResponse = { status: 'ok', transport: 'http' };
    expect(isDaemonAlive(health)).toBe(true);
  });

  it('treats an unreachable daemon (null) as not alive', () => {
    expect(isDaemonAlive(null)).toBe(false);
  });
});
