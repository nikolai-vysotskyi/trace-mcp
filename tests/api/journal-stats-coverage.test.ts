/**
 * GET /api/projects/journal/stats — window parsing and honest coverage (TRA-1071).
 *
 *  - `window=24h` used to parse as 24 milliseconds and answer 200 with
 *    `window_ms: 24`. An external caller got a plausible answer to a question
 *    it never asked; now it gets a 400.
 *  - `recording_since` tells the tab how far back the data can possibly go, so
 *    a "24h" window over 12 minutes of history stops reading as a hard zero.
 */

import http from 'node:http';
import { describe, expect, it } from 'vitest';

import {
  handleJournalStatsRequest,
  type JournalEntryForStats,
  type JournalStatsContext,
} from '../../src/api/journal-stats-routes.js';

function call(
  query: string,
  ctx: JournalStatsContext,
): { status: number; body: Record<string, unknown> } {
  const url = new URL(`http://127.0.0.1:3741/api/projects/journal/stats?${query}`);
  const req = { method: 'GET' } as http.IncomingMessage;
  let status = 0;
  let chunk = '';
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(body?: string) {
      chunk = body ?? '';
    },
  } as unknown as http.ServerResponse;

  expect(handleJournalStatsRequest(req, res, url, ctx)).toBe(true);
  return { status, body: JSON.parse(chunk) };
}

const emptyCtx: JournalStatsContext = { listEntriesForProject: () => [] };

describe('journal stats route', () => {
  it('rejects a non-numeric window instead of reading it as milliseconds', () => {
    const { status, body } = call('project=/p&window=24h', emptyCtx);
    expect(status).toBe(400);
    expect(body.got).toBe('24h');
  });

  it('still accepts a plain millisecond window', () => {
    const { status, body } = call('project=/p&window=3600000', emptyCtx);
    expect(status).toBe(200);
    expect(body.window_ms).toBe(3_600_000);
  });

  it('passes the window bounds down to the store rather than filtering in JS', () => {
    const seen: Array<[string, number | undefined, number | undefined]> = [];
    const ctx: JournalStatsContext = {
      listEntriesForProject: (root, since, until) => {
        seen.push([root, since, until]);
        return [];
      },
    };
    call('project=/p&window=300000&before=1000000000', ctx);
    expect(seen).toEqual([['/p', 1000000000 - 300_000, 1000000000]]);
  });

  it('reports how far back recording actually goes', () => {
    const recordedFrom = Date.now() - 12 * 60_000;
    const entries: JournalEntryForStats[] = [];
    const ctx: JournalStatsContext = {
      listEntriesForProject: () => entries,
      recordingSince: () => recordedFrom,
    };
    const { body } = call('project=/p&window=86400000', ctx);
    expect(body.recording_since).toBe(recordedFrom);
  });

  it('omits recording_since when the daemon has no durable store', () => {
    const { body } = call('project=/p&window=86400000', emptyCtx);
    expect(body).not.toHaveProperty('recording_since');
  });
});
