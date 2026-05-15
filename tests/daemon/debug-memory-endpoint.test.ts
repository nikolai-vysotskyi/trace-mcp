/**
 * Tests for the GET /debug/memory endpoint surface.
 *
 * The cli.ts handler is a long-running HTTP server that's expensive to
 * spin up in a unit test. We exercise the helper `buildMemoryReport`
 * the route handler calls — same code path, just with stub maps in deps.
 */
import { describe, expect, it } from 'vitest';
import { buildMemoryReport } from '../../src/daemon/memory-report.js';
import {
  __recentReindexCacheStats,
  __resetRecentReindexCache,
} from '../../src/indexer/recent-reindex-cache.js';

function stubDeps(overrides: Partial<Parameters<typeof buildMemoryReport>[0]> = {}) {
  return {
    clients: new Map<string, unknown>(),
    sseConnections: new Set<unknown>(),
    rateBuckets: new Map<string, unknown>(),
    lastProgressEmittedAt: new Map<string, number>(),
    progressUnsubscribers: new Map<string, () => void>(),
    projectSessions: new Map<string, Set<string>>(),
    sessionTransports: new Map<string, unknown>(),
    sessionHandles: new Map<string, unknown>(),
    sessionClients: new Map<string, string>(),
    registeredProjects: 0,
    ...overrides,
  };
}

describe('GET /debug/memory endpoint surface', () => {
  it('returns positive process.rss and heapUsed', () => {
    const report = buildMemoryReport(stubDeps());
    expect(report.process.rss).toBeGreaterThan(0);
    expect(report.process.heapUsed).toBeGreaterThan(0);
    expect(report.process.heapTotal).toBeGreaterThan(0);
    // external/arrayBuffers can legitimately be 0 on a freshly-started node,
    // so just check the field is a non-negative number.
    expect(report.process.external).toBeGreaterThanOrEqual(0);
    expect(report.process.arrayBuffers).toBeGreaterThanOrEqual(0);
    expect(report.uptime_seconds).toBeGreaterThan(0);
  });

  it('every cache field is a non-negative integer', () => {
    const report = buildMemoryReport(stubDeps());
    for (const [key, value] of Object.entries(report.caches)) {
      expect(Number.isInteger(value), `${key} should be an integer`).toBe(true);
      expect(value, `${key} should be >= 0`).toBeGreaterThanOrEqual(0);
    }
  });

  it('reflects sizes passed via deps', () => {
    const clients = new Map<string, unknown>();
    clients.set('a', {});
    clients.set('b', {});
    const sseConnections = new Set<unknown>();
    sseConnections.add({});
    const rateBuckets = new Map<string, unknown>();
    rateBuckets.set('1.2.3.4', {});
    rateBuckets.set('5.6.7.8', {});
    rateBuckets.set('9.9.9.9', {});
    const lastProgressEmittedAt = new Map<string, number>([['k1', 1]]);
    const progressUnsubscribers = new Map<string, () => void>([['p', () => {}]]);
    const projectSessions = new Map<string, Set<string>>([['proj', new Set(['s'])]]);
    const sessionTransports = new Map<string, unknown>([['s1', {}]]);
    const sessionHandles = new Map<string, unknown>([
      ['s1', {}],
      ['s2', {}],
    ]);
    const sessionClients = new Map<string, string>([['s1', 'c1']]);

    const report = buildMemoryReport(
      stubDeps({
        clients,
        sseConnections,
        rateBuckets,
        lastProgressEmittedAt,
        progressUnsubscribers,
        projectSessions,
        sessionTransports,
        sessionHandles,
        sessionClients,
        registeredProjects: 7,
      }),
    );

    expect(report.caches.clients).toBe(2);
    expect(report.caches.sseConnections).toBe(1);
    expect(report.caches.rateBuckets).toBe(3);
    expect(report.caches.lastProgressEmittedAt).toBe(1);
    expect(report.caches.progressUnsubscribers).toBe(1);
    expect(report.caches.projectSessions).toBe(1);
    expect(report.caches.sessionTransports).toBe(1);
    expect(report.caches.sessionHandles).toBe(2);
    expect(report.caches.sessionClients).toBe(1);
    expect(report.caches.registered_projects).toBe(7);
  });

  it('registered_projects defaults to 0 when deps stubs are empty', () => {
    const report = buildMemoryReport(stubDeps());
    expect(report.caches.registered_projects).toBe(0);
  });

  it('exposes recent_reindex_total_entries from the shared cache helper', () => {
    __resetRecentReindexCache();
    const report = buildMemoryReport(stubDeps());
    // After reset, the recent-reindex cache is empty; the report must match
    // whatever the canonical stats helper currently reports.
    expect(report.caches.recent_reindex_total_entries).toBe(
      __recentReindexCacheStats().totalEntries,
    );
  });

  it('exposes project_stats_cache_entries as a non-negative number', () => {
    const report = buildMemoryReport(stubDeps());
    expect(typeof report.caches.project_stats_cache_entries).toBe('number');
    expect(report.caches.project_stats_cache_entries).toBeGreaterThanOrEqual(0);
  });

  it('omits the telemetry field when the global sink is Noop', () => {
    // Tests run with default config — the global sink is Noop, which does
    // not expose getBufferSize. The report must omit `telemetry` entirely.
    const report = buildMemoryReport(stubDeps());
    expect(report.telemetry).toBeUndefined();
  });
});
