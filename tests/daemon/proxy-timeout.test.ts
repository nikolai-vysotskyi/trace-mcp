import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeProxyTimeoutMs,
  DEFAULT_PROXY_INITIALIZE_TIMEOUT_MS,
  DEFAULT_PROXY_WARMUP_GRACE_MS,
  hasStartupProgressChanged,
  PROXY_ABSOLUTE_MAX_MS,
  probeProxyReadiness,
  resolveProxyInitializeTimeout,
  resolveProxyWarmupGrace,
  WARMUP_PROGRESS_SLICE_MS,
} from '../../src/daemon/router/proxy-timeout.js';

/**
 * Adaptive proxy-initialize timeout (TRA-1605, PROC-1).
 *
 * A fixed 1 s watchdog stamps N sessions into local mode at the same instant
 * on a loaded box. The budget below only ever grows past the base when
 * /health proves the daemon is alive-but-slow or still warming up — a silent
 * daemon keeps the base, and the healthy-daemon handshake timing is unchanged.
 */

describe('resolveProxyInitializeTimeout', () => {
  it('defaults to 1s', () => {
    expect(resolveProxyInitializeTimeout(undefined, undefined)).toBe(
      DEFAULT_PROXY_INITIALIZE_TIMEOUT_MS,
    );
    expect(DEFAULT_PROXY_INITIALIZE_TIMEOUT_MS).toBe(1_000);
  });

  it('explicit opts win over env', () => {
    expect(resolveProxyInitializeTimeout(2_500, '9999')).toBe(2_500);
  });

  it('env tunes without rebuilding; garbage env is ignored', () => {
    expect(resolveProxyInitializeTimeout(undefined, '2500')).toBe(2_500);
    expect(resolveProxyInitializeTimeout(undefined, 'garbage')).toBe(1_000);
    expect(resolveProxyInitializeTimeout(undefined, '-5')).toBe(1_000);
    expect(resolveProxyInitializeTimeout(undefined, '')).toBe(1_000);
  });

  it('0 disables (no floor)', () => {
    expect(resolveProxyInitializeTimeout(0, undefined)).toBe(0);
  });
});

describe('resolveProxyWarmupGrace', () => {
  it('defaults to 20s (base + grace stays under client startup timeouts, TRA-1844)', () => {
    expect(resolveProxyWarmupGrace(undefined, undefined)).toBe(DEFAULT_PROXY_WARMUP_GRACE_MS);
    expect(DEFAULT_PROXY_WARMUP_GRACE_MS).toBe(20_000);
  });

  it('explicit opts win over env; garbage env is ignored', () => {
    expect(resolveProxyWarmupGrace(5_000, '9999')).toBe(5_000);
    expect(resolveProxyWarmupGrace(undefined, '8000')).toBe(8_000);
    expect(resolveProxyWarmupGrace(undefined, 'nope')).toBe(20_000);
  });
});

describe('hasStartupProgressChanged', () => {
  it('same tuple twice means stalled', () => {
    expect(
      hasStartupProgressChanged(
        { projectsReady: 0, projectsTotal: 46 },
        { projectsReady: 0, projectsTotal: 46 },
      ),
    ).toBe(false);
  });

  it('either counter moving means converging', () => {
    expect(
      hasStartupProgressChanged(
        { projectsReady: 0, projectsTotal: 46 },
        { projectsReady: 3, projectsTotal: 46 },
      ),
    ).toBe(true);
    expect(
      hasStartupProgressChanged(
        { projectsReady: 3, projectsTotal: 46 },
        { projectsReady: 3, projectsTotal: 47 },
      ),
    ).toBe(true);
  });

  it('absent signal is not evidence of a stall (legacy health payloads keep the grace)', () => {
    expect(hasStartupProgressChanged(undefined, { projectsReady: 0, projectsTotal: 1 })).toBe(true);
    expect(hasStartupProgressChanged({ projectsReady: 0, projectsTotal: 1 }, undefined)).toBe(true);
    expect(hasStartupProgressChanged(undefined, undefined)).toBe(true);
  });

  it('slice length is a short fraction of the grace', () => {
    expect(WARMUP_PROGRESS_SLICE_MS).toBe(2_000);
    expect(WARMUP_PROGRESS_SLICE_MS).toBeLessThan(DEFAULT_PROXY_WARMUP_GRACE_MS);
  });
});

describe('computeProxyTimeoutMs', () => {
  const BASE = 1_000;
  const GRACE = 30_000;

  it('silent daemon (null readiness) keeps the base — dead stays fast', () => {
    expect(computeProxyTimeoutMs(BASE, null, GRACE)).toBe(BASE);
  });

  it('warming daemon gets base + full grace', () => {
    expect(computeProxyTimeoutMs(BASE, { reachable: true, starting: true, rttMs: 5 }, GRACE)).toBe(
      BASE + GRACE,
    );
  });

  it('load scales with /health RTT (4x) and caps the extra', () => {
    expect(
      computeProxyTimeoutMs(BASE, { reachable: true, starting: false, rttMs: 50 }, GRACE),
    ).toBe(BASE + 200);
    // 10 s RTT would grant 40 s — capped at +9 s.
    expect(
      computeProxyTimeoutMs(BASE, { reachable: true, starting: false, rttMs: 10_000 }, GRACE),
    ).toBe(BASE + 9_000);
  });

  it('fast healthy daemon barely moves the deadline', () => {
    const total = computeProxyTimeoutMs(
      BASE,
      { reachable: true, starting: false, rttMs: 2 },
      GRACE,
    );
    expect(total).toBeLessThanOrEqual(BASE + 50);
  });

  it('absolute cap bounds a huge base + grace', () => {
    expect(
      computeProxyTimeoutMs(100_000, { reachable: true, starting: true, rttMs: 0 }, 100_000),
    ).toBe(PROXY_ABSOLUTE_MAX_MS);
  });
});

describe('probeProxyReadiness', () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  async function startHealthServer(payload: unknown, statusCode = 200): Promise<number> {
    const server = http.createServer((_req, res) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    close = () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    return (server.address() as AddressInfo).port;
  }

  it('reports reachable + starting for a warming daemon', async () => {
    const port = await startHealthServer({
      status: 'starting',
      phase: 'startup_index',
      transport: 'http',
    });
    const r = await probeProxyReadiness(port);
    expect(r).toMatchObject({ reachable: true, starting: true });
    expect(r!.rttMs).toBeGreaterThanOrEqual(0);
  });

  it('maps the startup progress tuple through (TRA-1844)', async () => {
    const port = await startHealthServer({
      status: 'starting',
      phase: 'startup_index',
      transport: 'http',
      progress: { projectsReady: 0, projectsTotal: 46 },
    });
    const r = await probeProxyReadiness(port);
    expect(r).toMatchObject({
      reachable: true,
      starting: true,
      progress: { projectsReady: 0, projectsTotal: 46 },
    });
  });

  it('treats a malformed progress payload as absent, not stalled', async () => {
    const port = await startHealthServer({
      status: 'starting',
      transport: 'http',
      progress: { projectsReady: 'many', projectsTotal: -1 },
    });
    const r = await probeProxyReadiness(port);
    expect(r).toMatchObject({ reachable: true, starting: true });
    expect(r!.progress).toBeUndefined();
  });

  it('reports reachable + not-starting for a live daemon (any status shape)', async () => {
    // Legacy/fake health payloads without a `status` field count as alive —
    // only an explicit "starting" extends the deadline.
    const port = await startHealthServer({ ok: true, status: 'healthy' });
    const r = await probeProxyReadiness(port);
    expect(r).toMatchObject({ reachable: true, starting: false });
  });

  it('returns null when nothing answers (dead daemon)', async () => {
    // Port 1 is unroutable for binding — nothing listens there.
    await expect(probeProxyReadiness(1)).resolves.toBeNull();
  });

  it('returns null on non-200 health', async () => {
    const port = await startHealthServer({ error: 'bad' }, 500);
    await expect(probeProxyReadiness(port)).resolves.toBeNull();
  });
});
