/**
 * Unit coverage for the TRA-76 "unreachable data source" signal:
 * `attachNoSessionDataWarning()` / `buildNoSessionDataWarning()` in
 * src/analytics/sync.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  attachIngestionStatus,
  attachNoSessionDataWarning,
  buildIngestionStatus,
  buildNoSessionDataWarning,
} from '../../src/analytics/sync.js';

describe('buildNoSessionDataWarning()', () => {
  it('mentions the resolved project path when provided', () => {
    const [warning] = buildNoSessionDataWarning('/Users/me/project');
    expect(warning).toContain('/Users/me/project');
    expect(warning).toContain('~/.claude/projects');
  });

  it('falls back to a generic scope description when no project path is given', () => {
    const [warning] = buildNoSessionDataWarning(undefined);
    expect(warning).toContain('any registered project');
  });
});

describe('attachNoSessionDataWarning()', () => {
  it('attaches _warnings only when the aggregation is empty AND no files were found on disk', () => {
    const report = attachNoSessionDataWarning({}, true, true, '/proj');
    expect(report._warnings).toBeDefined();
    expect(report._warnings?.[0]).toContain('/proj');
  });

  it('does not warn when the aggregation is empty but files exist on disk (genuinely nothing for this period)', () => {
    const report = attachNoSessionDataWarning({}, true, false, '/proj');
    expect(report._warnings).toBeUndefined();
  });

  it('does not warn when the aggregation has data even if no files were found on disk this run', () => {
    const report = attachNoSessionDataWarning({}, false, true, '/proj');
    expect(report._warnings).toBeUndefined();
  });

  it('does not warn when both signals indicate real data', () => {
    const report = attachNoSessionDataWarning({}, false, false, '/proj');
    expect(report._warnings).toBeUndefined();
  });
});

/**
 * TRA-695: the analytics DB served a seven-day-old snapshot as if it were
 * current. These cover the watermark signal that makes that visible.
 */
describe('buildIngestionStatus()', () => {
  const HOUR = 3_600_000;
  const parsedAt = '2026-09-02T12:00:00.000Z';
  const parsedAtMs = Date.parse(parsedAt);

  it('is fresh when the watermark is newer than every log on disk', () => {
    const status = buildIngestionStatus(
      { parsed_at: parsedAt, files_tracked: 10 },
      parsedAtMs - HOUR,
    );
    expect(status.stale).toBe(false);
    expect(status.behind_hours).toBeNull();
    expect(status.ingested_through).toBe(parsedAt);
  });

  it('is stale, with the gap in hours, when a log on disk is newer', () => {
    const status = buildIngestionStatus(
      { parsed_at: parsedAt, files_tracked: 10 },
      parsedAtMs + 7 * 24 * HOUR,
    );
    expect(status.stale).toBe(true);
    expect(status.behind_hours).toBe(168);
  });

  it('is stale when nothing was ever ingested but logs exist', () => {
    const status = buildIngestionStatus({ parsed_at: null, files_tracked: 0 }, parsedAtMs);
    expect(status.stale).toBe(true);
    expect(status.behind_hours).toBeNull();
  });

  it('is not stale when there are no logs on disk at all', () => {
    const status = buildIngestionStatus({ parsed_at: null, files_tracked: 0 }, null);
    expect(status.stale).toBe(false);
  });
});

describe('attachIngestionStatus()', () => {
  const store = (parsedAt: string | null) => ({
    getIngestionWatermark: () => ({ parsed_at: parsedAt, files_tracked: 3 }),
  });
  const syncResult = (newest: number | null) => ({
    files_scanned: 0,
    files_parsed: 0,
    files_skipped: 0,
    sessions_stored: 0,
    tool_calls_stored: 0,
    errors: 0,
    duration_ms: 0,
    newest_log_mtime: newest,
  });

  it('attaches the watermark and no warning when fresh', () => {
    const report = attachIngestionStatus(
      {},
      store('2026-09-02T12:00:00.000Z'),
      syncResult(Date.parse('2026-09-02T11:00:00.000Z')),
    );
    expect(report._ingestion?.stale).toBe(false);
    expect(report._warnings).toBeUndefined();
  });

  it('states the staleness in _warnings rather than leaving it to be inferred', () => {
    const report = attachIngestionStatus(
      { _warnings: ['pre-existing'] },
      store('2026-08-26T05:03:12.638Z'),
      syncResult(Date.parse('2026-09-02T18:00:00.000Z')),
    );
    expect(report._ingestion?.stale).toBe(true);
    expect(report._warnings?.[0]).toBe('pre-existing');
    expect(report._warnings?.[1]).toContain('STALE');
    expect(report._warnings?.[1]).toContain('trace-mcp analytics sync');
  });
});
