/**
 * Durable activity journal (TRA-1071, TRA-1868).
 *
 * TRA-1868: journal_entries went silently blind for 2+ hours across healthy
 * daemon restarts — no warn anywhere — while tool traffic kept flowing. These
 * pin the store half of the contract: buffered records land on disk, the
 * stall watchdog fires when they cannot, and the params summarizer shared
 * with the batch/relay emitters keeps one shape.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityStore, type ActivityEntry } from '../activity-store.js';
import { SessionJournal, summarizeToolParams } from '../journal.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { logger } = await import('../../logger.js');
const warn = logger.warn as unknown as ReturnType<typeof vi.fn>;

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'activity-test-')), 'activity.db');
}

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    ts: Date.now(),
    project: '/proj',
    session_id: 'sess-1',
    tool: 'search',
    params_summary: 'search foo',
    result_count: 3,
    result_tokens: 100,
    latency_ms: 12,
    is_error: false,
    ...overrides,
  };
}

afterEach(() => {
  warn.mockClear();
  vi.useRealTimers();
});

describe('ActivityStore', () => {
  it('round-trips buffered records oldest-first with their fields', () => {
    const store = new ActivityStore(tmpDb());
    try {
      store.record(entry({ tool: 'search', params_summary: 'search foo' }));
      store.record(entry({ tool: 'get_symbol', params_summary: 'get_symbol bar', is_error: true }));
      const rows = store.listForProject('/proj', 0, Date.now() + 1000);
      expect(rows).toHaveLength(2);
      expect(rows[0].tool).toBe('search');
      expect(rows[1].tool).toBe('get_symbol');
      expect(rows[1].is_error).toBe(1);
      expect(rows[0].params_summary).toBe('search foo');
    } finally {
      store.close();
    }
  });

  it('flushes the buffer on close so the last ~2 s of calls are not lost', () => {
    const dbPath = tmpDb();
    const store = new ActivityStore(dbPath);
    store.record(entry());
    store.close();
    const reopened = new ActivityStore(dbPath);
    try {
      expect(reopened.listForProject('/proj', 0, Date.now() + 1000)).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it('prunes rows past the retention horizon', () => {
    const store = new ActivityStore(tmpDb());
    try {
      store.record(entry({ ts: Date.now() - 8 * 24 * 60 * 60 * 1000 }));
      store.record(entry());
      expect(store.listForProject('/proj', 0, Date.now() + 1000)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('warns when buffered entries cannot reach disk (stalled flush)', async () => {
    vi.useFakeTimers();
    const store = new ActivityStore(tmpDb());
    try {
      // The 2 s flush timer cannot fire under fake timers; the watchdog at
      // 20 ms cadence must notice the stuck buffer instead of staying silent.
      const stop = store.startWatchdog({ intervalMs: 20, maxStuckMs: 10 });
      try {
        store.record(entry());
        await vi.advanceTimersByTimeAsync(100);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ buffered: 1 }),
          expect.stringContaining('stalling'),
        );
      } finally {
        stop();
      }
    } finally {
      store.close();
    }
  });

  it('stays quiet when idle — no traffic, no watchdog noise', async () => {
    vi.useFakeTimers();
    const store = new ActivityStore(tmpDb());
    try {
      const stop = store.startWatchdog({ intervalMs: 20, maxStuckMs: 10 });
      try {
        await vi.advanceTimersByTimeAsync(200);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    } finally {
      store.close();
    }
  });
});

describe('summarizeToolParams', () => {
  it('prefers the query-ish param and caps its length', () => {
    expect(summarizeToolParams('search', { query: 'foo' })).toBe('search foo');
    expect(summarizeToolParams('get_symbol', { symbol_id: 'a'.repeat(200) })).toBe(
      `get_symbol ${'a'.repeat(80)}`,
    );
    expect(summarizeToolParams('get_index_health', {})).toBe('get_index_health');
  });
});

describe('SessionJournal.latestTimestamp', () => {
  it('is 0 when empty and tracks the newest record', () => {
    const journal = new SessionJournal();
    expect(journal.latestTimestamp()).toBe(0);
    journal.record('search', { query: 'x' }, 1);
    expect(journal.latestTimestamp()).toBeGreaterThan(0);
  });
});
