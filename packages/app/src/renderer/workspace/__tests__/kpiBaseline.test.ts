import { describe, expect, it } from 'vitest';
import { BASELINE_MAX_AGE_MS, BASELINE_MIN_AGE_MS, rollBaseline } from '../kpiBaseline';
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
    const stored = { at: at(NOW - BASELINE_MIN_AGE_MS - 1), kpis: kpis(8) };
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

  /* The first launch stores a baseline and would otherwise compare against it
     on the next frame: "No change vs 2 seconds ago" is a caption about when the
     app was opened, not about the workspace (TRA-958). */
  it('shows no delta against a snapshot taken minutes ago, and does not re-stamp it', () => {
    const stored = { at: at(NOW - 2_000), kpis: kpis(8) };
    const { previous, next } = rollBaseline(NOW, stored, kpis(10));
    expect(previous).toBeNull();
    expect(next).toBeNull();
  });

  it('discards a corrupt or future-dated snapshot instead of inventing a delta', () => {
    for (const bad of [{ at: 'not-a-date', kpis: kpis(8) }, { at: at(NOW + 60_000), kpis: kpis(8) }]) {
      const { previous, next } = rollBaseline(NOW, bad, kpis(10));
      expect(previous).toBeNull();
      expect(next?.kpis.totalProjects).toBe(10);
    }
  });

  /* An empty snapshot is what a failed reading leaves behind, and the two are
     indistinguishable once stored. It is also useless when it is genuine: the
     only delta it can produce is the value itself (TRA-458). */
  it('never compares against an empty snapshot', () => {
    const stored = { at: at(NOW - BASELINE_MIN_AGE_MS - 1), kpis: kpis(0) };
    const { previous, next } = rollBaseline(NOW, stored, kpis(53));
    expect(previous).toBeNull();
    expect(next?.kpis.totalProjects).toBe(53);
  });

  it('never stores an empty snapshot', () => {
    const { previous, next } = rollBaseline(NOW, null, kpis(0));
    expect(previous).toBeNull();
    expect(next).toBeNull();
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
