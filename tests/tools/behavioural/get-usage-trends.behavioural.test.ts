/**
 * Behavioural coverage for the `get_usage_trends` MCP tool.
 *
 * IMPL NOTE: `get_usage_trends` is inline-registered in
 * `src/tools/register/session.ts` (lines 440-485). The wrapper:
 *   1. opens an AnalyticsStore on ~/.trace-mcp/analytics.db
 *   2. calls `syncAnalytics()` (scans ~/.claude/projects on the FS)
 *   3. calls `analyticsStore.getUsageTrends(days)`
 *   4. reduces the daily rows into a `totals` object
 *
 * We isolate the AnalyticsStore by passing a temp dbPath into its
 * constructor (it accepts `dbPath?: string` for exactly this case), then
 * seed `sessions` directly via SQL and assert the contract.
 *
 * Contract under test:
 *   - empty DB → empty daily array (totals reducer in caller wraps to zeros)
 *   - rows aggregate by DATE(started_at) and are sorted ascending
 *   - the `days` window respects the cutoff (older rows are excluded)
 *   - every daily entry has shape { date, sessions, tokens, cost_usd, tool_calls }
 *   - rows OLDER than the window are dropped
 */
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnalyticsStore } from '../../../src/analytics/analytics-store.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

interface SessionSeed {
  id: string;
  started_at: string; // ISO timestamp
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_create_tokens?: number;
  tool_call_count?: number;
}

function seedSessions(dbPath: string, sessions: SessionSeed[]): void {
  const raw = new Database(dbPath);
  const insert = raw.prepare(`
    INSERT OR REPLACE INTO sessions
      (id, project_path, started_at, ended_at, model, input_tokens, output_tokens,
       cache_read_tokens, cache_create_tokens, tool_call_count, parsed_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  for (const s of sessions) {
    insert.run(
      s.id,
      '/tmp/fixture-project',
      s.started_at,
      s.started_at,
      'test-model',
      s.input_tokens ?? 100,
      s.output_tokens ?? 200,
      s.cache_read_tokens ?? 0,
      s.cache_create_tokens ?? 0,
      s.tool_call_count ?? 3,
      now,
    );
  }
  raw.close();
}

function isoDaysAgo(days: number, hour = 12): string {
  const d = new Date(Date.now() - days * 86400000);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

describe('get_usage_trends — AnalyticsStore.getUsageTrends() behavioural contract', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: AnalyticsStore;

  beforeEach(() => {
    tmpDir = createTmpDir('trace-mcp-usage-trends-');
    dbPath = path.join(tmpDir, 'analytics.db');
    store = new AnalyticsStore(dbPath);
  });

  afterEach(() => {
    store.close();
    removeTmpDir(tmpDir);
  });

  it('empty sessions table returns an empty trends array', () => {
    const trends = store.getUsageTrends(30);
    expect(trends).toEqual([]);
  });

  it('each daily entry has the documented { date, sessions, tokens, cost_usd, tool_calls } shape', () => {
    seedSessions(dbPath, [{ id: 's1', started_at: isoDaysAgo(1) }]);
    const trends = store.getUsageTrends(30);
    expect(trends.length).toBeGreaterThan(0);
    for (const day of trends) {
      expect(typeof day.date).toBe('string');
      expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof day.sessions).toBe('number');
      expect(typeof day.tokens).toBe('number');
      expect(typeof day.cost_usd).toBe('number');
      expect(typeof day.tool_calls).toBe('number');
    }
  });

  it('rows aggregate by DATE(started_at) and surface ascending', () => {
    seedSessions(dbPath, [
      { id: 's1', started_at: isoDaysAgo(3) },
      { id: 's2', started_at: isoDaysAgo(3, 18) }, // same day, later hour
      { id: 's3', started_at: isoDaysAgo(1) },
      { id: 's4', started_at: isoDaysAgo(2) },
    ]);
    const trends = store.getUsageTrends(30);
    // Three distinct calendar days.
    expect(trends.length).toBe(3);
    // Ascending date order.
    const dates = trends.map((d) => d.date);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
    // Day with two sessions surfaces sessions=2.
    const twoSessionDay = trends.find((d) => d.sessions === 2);
    expect(twoSessionDay).toBeDefined();
  });

  it('the `days` window excludes rows older than the cutoff', () => {
    seedSessions(dbPath, [
      { id: 'recent', started_at: isoDaysAgo(1) },
      { id: 'old', started_at: isoDaysAgo(60) },
    ]);
    const trendsTight = store.getUsageTrends(7);
    expect(trendsTight.length).toBe(1);
    const trendsWide = store.getUsageTrends(90);
    expect(trendsWide.length).toBe(2);
  });

  it('totals reducer in the MCP wrapper produces zeros for empty input', () => {
    // The wrapper does `trends.reduce(...)` with a zero seed — verify the
    // shape we hand to it is reducer-safe even when empty.
    const trends = store.getUsageTrends(30);
    const totals = trends.reduce(
      (s, d) => ({
        sessions: s.sessions + d.sessions,
        tokens: s.tokens + d.tokens,
        cost_usd: s.cost_usd + d.cost_usd,
        tool_calls: s.tool_calls + d.tool_calls,
      }),
      { sessions: 0, tokens: 0, cost_usd: 0, tool_calls: 0 },
    );
    expect(totals).toEqual({ sessions: 0, tokens: 0, cost_usd: 0, tool_calls: 0 });
  });
});
