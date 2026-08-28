import { describe, expect, it } from 'vitest';
import { BASELINE_MAX_AGE_MS, describeAge, rollBaseline } from '../kpiBaseline';
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
});

describe('describeAge', () => {
  it('reads as a date a person would say out loud', () => {
    expect(describeAge(at(NOW - 60_000), NOW)).toBe('today');
    expect(describeAge(at(NOW - BASELINE_MAX_AGE_MS), NOW)).toBe('yesterday');
    expect(describeAge(at(NOW - 3 * BASELINE_MAX_AGE_MS), NOW)).toBe('3 days ago');
  });
});
