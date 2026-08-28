import { describe, expect, it } from 'vitest';
import { selectEagerLoadRoots } from '../eager-load.js';
import type { RegistryEntry } from '../../registry.js';

function entry(
  root: string,
  lastIndexed: string | null,
  addedAt = '2020-01-01T00:00:00.000Z',
): RegistryEntry {
  return { name: root, root, dbPath: `${root}.db`, lastIndexed, addedAt };
}

describe('selectEagerLoadRoots', () => {
  it('loads everything when the registry fits under the cap', () => {
    const entries = [entry('/a', null), entry('/b', null)];
    const { eager, deferred } = selectEagerLoadRoots(entries, 8);
    expect(eager).toHaveLength(2);
    expect(deferred).toHaveLength(0);
  });

  it('keeps the most recently indexed projects and defers the rest', () => {
    const entries = [
      entry('/old', '2026-01-01T00:00:00.000Z'),
      entry('/newest', '2026-08-28T00:00:00.000Z'),
      entry('/middle', '2026-06-01T00:00:00.000Z'),
    ];
    const { eager, deferred } = selectEagerLoadRoots(entries, 2);
    expect(eager.map((e) => e.root)).toEqual(['/newest', '/middle']);
    expect(deferred.map((e) => e.root)).toEqual(['/old']);
  });

  it('falls back to addedAt for never-indexed projects', () => {
    const entries = [
      entry('/never-old', null, '2020-01-01T00:00:00.000Z'),
      entry('/never-new', null, '2026-08-01T00:00:00.000Z'),
    ];
    const { eager } = selectEagerLoadRoots(entries, 1);
    expect(eager.map((e) => e.root)).toEqual(['/never-new']);
  });

  it('cap 0 opts out of the cap entirely', () => {
    const entries = Array.from({ length: 50 }, (_, i) => entry(`/p${i}`, null));
    const { eager, deferred } = selectEagerLoadRoots(entries, 0);
    expect(eager).toHaveLength(50);
    expect(deferred).toHaveLength(0);
  });

  it('does not mutate the caller array', () => {
    const entries = [
      entry('/a', '2026-01-01T00:00:00.000Z'),
      entry('/b', '2026-08-01T00:00:00.000Z'),
    ];
    selectEagerLoadRoots(entries, 1);
    expect(entries.map((e) => e.root)).toEqual(['/a', '/b']);
  });
});
