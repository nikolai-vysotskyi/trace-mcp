import { describe, expect, it } from 'vitest';
import { buildHealthPayload } from '../health-payload.js';

// Issue #237: the daemon binds /health BEFORE startup indexing, so it answers
// from the first millisecond — but while the initial reindex runs it must
// report status "starting" (not "ok") so clients treat it as alive-and-warming
// instead of dead-and-respawn. After startup completes it reports "ok".

describe('buildHealthPayload', () => {
  const base = {
    version: '1.2.3',
    uptimeSeconds: 42,
    pid: 5555,
    projects: [
      { root: '/a', status: 'ready' },
      { root: '/b', status: 'indexing' },
      { root: '/c', status: 'ready' },
    ],
  };

  it('reports "starting" with startup_index phase while startup is incomplete', () => {
    const payload = buildHealthPayload({ ...base, startupComplete: false });
    expect(payload.status).toBe('starting');
    expect(payload.phase).toBe('startup_index');
    expect(payload.transport).toBe('http');
    expect(payload.pid).toBe(5555);
    expect(payload.version).toBe('1.2.3');
  });

  it('surfaces cheap per-project progress while starting', () => {
    const payload = buildHealthPayload({ ...base, startupComplete: false });
    expect(payload.progress).toEqual({ projectsReady: 2, projectsTotal: 3 });
  });

  it('reports "ok" with no phase/progress once startup completes', () => {
    const payload = buildHealthPayload({ ...base, startupComplete: true });
    expect(payload.status).toBe('ok');
    expect(payload.phase).toBeUndefined();
    expect(payload.progress).toBeUndefined();
  });

  it('carries the project list through in both states', () => {
    const starting = buildHealthPayload({ ...base, startupComplete: false });
    const ready = buildHealthPayload({ ...base, startupComplete: true });
    expect(starting.projects).toHaveLength(3);
    expect(ready.projects).toHaveLength(3);
  });
});
