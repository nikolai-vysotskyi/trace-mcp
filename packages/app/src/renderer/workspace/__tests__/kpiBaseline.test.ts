import { describe, expect, it } from 'vitest';
import { BASELINE_MAX_AGE_MS, rollBaseline } from '../kpiBaseline';
import { relativeTime } from '../../i18n/format';
import type { WorkspaceKpis } from '../types';

const kpis = (totalProjects: number): WorkspaceKpis => ({
  totalProjects,
  totalFiles: totalProjects * 10,
  totalSymbols: totalProjects * 100,
  healthy: 1,
  needsAttention: 1,
  indexing: 0,
});

const NOW = Date.parse('2026-08-28T12:00:00Z');
const at = (ms: number) => new Date(ms).toISOString();

describe('rollBaseline', () => {
  it('starts tracking when nothing is stored, and shows no delta yet', () => {
    const { previous, next } = rollBaseline(NOW, null, kpis(10));
    expect(previous).toBeNull();
    expect(next?.kpis.totalProjects).toBe(10);
  });

  it("keeps today's snapshot and compares against it", () => {
    const stored = { at: at(NOW - 60_000), kpis: kpis(8) };
    const { previous, next } = rollBaseline(NOW, stored, kpis(10));
    expect(previous).toBe(stored);
    expect(next).toBeNull();
  });

  it('rolls a snapshot older than a day forward after comparing', () => {
    const stored = { at: at(NOW - BASELINE_MAX_AGE_MS - 1), kpis: kpis(8) };
    const { previous, next } = rollBaseline(NOW, stored, kpis(10));
    expect(previous).toBe(stored);
    expect(next?.kpis.totalProjects).toBe(10);
  });

  it('discards a corrupt or future-dated snapshot instead of inventing a delta', () => {
    for (const bad of [{ at: 'not-a-date', kpis: kpis(8) }, { at: at(NOW + 60_000), kpis: kpis(8) }]) {
      const { previous, next } = rollBaseline(NOW, bad, kpis(10));
      expect(previous).toBeNull();
      expect(next?.kpis.totalProjects).toBe(10);
    }
  });

  /* A launch against a daemon that never answered leaves zeros behind. Comparing
     against them reports the whole workspace as this afternoon's growth (TRA-458). */
  it('never compares against an empty workspace, and replaces that snapshot', () => {
    const { previous, next } = rollBaseline(NOW, { at: at(NOW - 60_000), kpis: kpis(0) }, kpis(10));
    expect(previous).toBeNull();
    expect(next?.kpis.totalProjects).toBe(10);
  });

  it('never writes an empty workspace as a baseline', () => {
    expect(rollBaseline(NOW, null, kpis(0)).next).toBeNull();
    const kept = rollBaseline(NOW, { at: at(NOW - BASELINE_MAX_AGE_MS - 1), kpis: kpis(8) }, kpis(0));
    expect(kept.previous?.kpis.totalProjects).toBe(8);
    expect(kept.next).toBeNull();
  });
});

/* The baseline's age is the caption on a delta chip; it comes from Intl now
   rather than from a hand-rolled helper with its own thresholds (TRA-387). */
describe('the age of a baseline', () => {
  it('reads as a date a person would say out loud', () => {
    expect(relativeTime(NOW - 60_000, NOW)).toBe('1 minute ago');
    expect(relativeTime(NOW - BASELINE_MAX_AGE_MS, NOW)).toBe('1 day ago');
    expect(relativeTime(NOW - 3 * BASELINE_MAX_AGE_MS, NOW)).toBe('3 days ago');
  });
});
