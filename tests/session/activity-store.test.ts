/**
 * ActivityStore — the durable half of the session journal (TRA-1071).
 *
 * What must hold:
 *   - an entry written by one session is still there after that session's
 *     store instance is closed and a new one opens (this is the whole point:
 *     the in-memory journal died with the client and Activity always read 0);
 *   - entries from several sessions of the same project all come back;
 *   - a project only sees its own entries;
 *   - the window bounds are applied in SQL, not by the caller;
 *   - `recordingSince` never claims coverage older than the retention horizon.
 *
 * The last test is the perf guard: reading a 24h window out of a week of
 * entries must stay well under the frame budget of the tab that calls it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ActivityStore, RETENTION_MS } from '../../src/session/activity-store.js';

let dir: string;
let dbPath: string;
const stores: ActivityStore[] = [];

function open(): ActivityStore {
  const s = new ActivityStore(dbPath);
  stores.push(s);
  return s;
}

function entry(over: Partial<Parameters<ActivityStore['record']>[0]> = {}) {
  return {
    ts: Date.now(),
    project: '/proj/a',
    session_id: 's1',
    tool: 'search',
    params_summary: 'query=foo src/bar.ts',
    result_count: 3,
    result_tokens: 120,
    latency_ms: 42,
    is_error: false,
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-store-'));
  dbPath = path.join(dir, 'activity.db');
});

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ActivityStore', () => {
  it('survives the session that wrote it', () => {
    const now = Date.now();
    const first = open();
    first.record(entry({ ts: now - 1000 }));
    first.close();

    const second = open();
    const rows = second.listForProject('/proj/a', now - 60_000, now);
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe('search');
    expect(rows[0].latency_ms).toBe(42);
    expect(rows[0].is_error).toBe(0);
  });

  it('keeps every session of a project, not just the newest', () => {
    const now = Date.now();
    const s = open();
    s.record(entry({ ts: now - 3000, session_id: 'old' }));
    s.record(entry({ ts: now - 1000, session_id: 'new' }));

    const rows = s.listForProject('/proj/a', now - 60_000, now);
    expect(rows.map((r) => r.session_id)).toEqual(['old', 'new']);
  });

  it('scopes reads to one project', () => {
    const now = Date.now();
    const s = open();
    s.record(entry({ ts: now - 1000, project: '/proj/a' }));
    s.record(entry({ ts: now - 1000, project: '/proj/b' }));

    expect(s.listForProject('/proj/a', now - 60_000, now)).toHaveLength(1);
    expect(s.listForProject('/proj/b', now - 60_000, now)).toHaveLength(1);
    expect(s.listForProject('/proj/c', now - 60_000, now)).toHaveLength(0);
  });

  it('applies the requested window', () => {
    const now = Date.now();
    const s = open();
    s.record(entry({ ts: now - 7_200_000 })); // 2h ago
    s.record(entry({ ts: now - 60_000 })); // 1 min ago

    expect(s.listForProject('/proj/a', now - 300_000, now)).toHaveLength(1);
    expect(s.listForProject('/proj/a', now - 86_400_000, now)).toHaveLength(2);
  });

  it('reads back an entry written a moment ago, before the flush timer fires', () => {
    const now = Date.now();
    const s = open();
    s.record(entry({ ts: now }));
    // No flush() call — listForProject must not miss the buffer.
    expect(s.listForProject('/proj/a', now - 1000, now + 1000)).toHaveLength(1);
  });

  it('never claims coverage older than the retention horizon', () => {
    const s = open();
    const since = s.recordingSince();
    expect(since).toBeGreaterThanOrEqual(Date.now() - RETENTION_MS);
    expect(since).toBeLessThanOrEqual(Date.now());
  });

  it('remembers when recording started across restarts', () => {
    const first = open();
    const started = first.recordingSince();
    first.close();
    expect(open().recordingSince()).toBe(started);
  });

  it('reads a 24h window out of a week of entries in well under a frame', () => {
    const now = Date.now();
    const s = open();
    // A week at ~50k calls/week — the rate measured on this machine's
    // analytics.db (47 866 trace tool calls in the last 7 days).
    const WEEK = 7 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 50_000; i++) {
      s.record(
        entry({
          ts: now - Math.floor((i / 50_000) * WEEK),
          project: i % 5 === 0 ? '/proj/a' : `/proj/other-${i % 7}`,
        }),
      );
    }
    s.flush();

    const t0 = performance.now();
    const rows = s.listForProject('/proj/a', now - 86_400_000, now);
    const elapsed = performance.now() - t0;

    expect(rows.length).toBeGreaterThan(0);
    // Measured ~2 ms locally. The ceiling is generous on purpose — it is here
    // to catch a dropped index or a full-table scan, not to police jitter.
    expect(elapsed).toBeLessThan(150);
  });
});
