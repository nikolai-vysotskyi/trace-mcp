import { describe, expect, it } from 'vitest';
import { selectEagerLoadRoots } from '../eager-load.js';
import type { RegistryEntry } from '../../registry.js';

function entry(
  root: string,
  lastIndexed: string | null,
  addedAt = '2020-01-01T00:00:00.000Z',
  extra?: Partial<RegistryEntry>,
): RegistryEntry {
  return { name: root, root, dbPath: `${root}.db`, lastIndexed, addedAt, ...extra };
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

  it('TRA-1863: an eager multi-root parent pulls its deferred registered children along', () => {
    const entries = [
      entry('/ws/parent', '2026-09-23T00:00:00.000Z', undefined, {
        type: 'multi-root',
        children: ['/ws/parent/front', '/ws/parent/laravel'],
      }),
      entry('/ws/parent/front', '2026-09-21T00:00:00.000Z'),
      entry('/ws/parent/laravel', '2026-09-23T12:00:00.000Z'),
      entry('/other-fresh', '2026-09-24T00:00:00.000Z'),
    ];
    // Cap 3 takes /other-fresh + /ws/parent/laravel + /ws/parent on recency;
    // the stale child /ws/parent/front would starve — but the parent
    // intentionally watches its declared children, so the family stays
    // co-resident instead (cap overflows by the family size).
    const { eager, deferred } = selectEagerLoadRoots(entries, 3);
    expect(eager.map((e) => e.root).sort()).toEqual(
      ['/other-fresh', '/ws/parent', '/ws/parent/front', '/ws/parent/laravel'].sort(),
    );
    expect(deferred).toHaveLength(0);
  });

  it('TRA-1863: promotion is family-scoped — unrelated deferred entries stay deferred', () => {
    const entries = [
      entry('/ws/parent', '2026-09-23T00:00:00.000Z', undefined, {
        type: 'multi-root',
        children: ['/ws/parent/front'],
      }),
      entry('/ws/parent/front', '2026-09-21T00:00:00.000Z'),
      entry('/other-fresh', '2026-09-24T00:00:00.000Z'),
      entry('/unrelated-old', '2026-09-20T00:00:00.000Z'),
    ];
    const { eager, deferred } = selectEagerLoadRoots(entries, 2);
    expect(eager.map((e) => e.root).sort()).toEqual(
      ['/other-fresh', '/ws/parent', '/ws/parent/front'].sort(),
    );
    expect(deferred.map((e) => e.root)).toEqual(['/unrelated-old']);
  });

  it('TRA-1863: unregistered declared children are not promoted', () => {
    const entries = [
      entry('/ws/parent', '2026-09-23T00:00:00.000Z', undefined, {
        type: 'multi-root',
        children: ['/ws/parent/ghost'],
      }),
      entry('/other', '2026-09-24T00:00:00.000Z'),
      entry('/old', '2026-01-01T00:00:00.000Z'),
    ];
    const { eager, deferred } = selectEagerLoadRoots(entries, 2);
    expect(eager.map((e) => e.root)).toEqual(['/other', '/ws/parent']);
    expect(deferred.map((e) => e.root)).toEqual(['/old']);
  });

  it('TRA-1863: a deferred multi-root parent does not pull its children', () => {
    const entries = [
      entry('/fresh-a', '2026-09-24T00:00:00.000Z'),
      entry('/fresh-b', '2026-09-23T12:00:00.000Z'),
      entry('/ws/parent', '2026-09-20T00:00:00.000Z', undefined, {
        type: 'multi-root',
        children: ['/ws/parent/front'],
      }),
      entry('/ws/parent/front', '2026-09-21T00:00:00.000Z'),
    ];
    const { eager, deferred } = selectEagerLoadRoots(entries, 2);
    expect(eager.map((e) => e.root)).toEqual(['/fresh-a', '/fresh-b']);
    expect(deferred.map((e) => e.root).sort()).toEqual(['/ws/parent', '/ws/parent/front'].sort());
  });
});
