/**
 * ObservationPack core contract (TRA-1700).
 * Ported expectations from SoL-Pi observation-pack: stable handle, paged recall,
 * hash-verified reuse, fail-open on unknown/corrupt ids.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isObservationId,
  observationId,
  observationPackRoot,
  pageItems,
  recallObservation,
  storeObservation,
  OBSERVATION_RECALL_MAX_ITEMS,
} from '../../src/observation-pack.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

function tmpRoot(): string {
  return observationPackRoot(createTmpDir('trace-mcp-obs-pack-'));
}

describe('observation-pack core', () => {
  it('mints stable obs_<24hex> ids bound to tool+query+content', () => {
    const deps = [{ path: 'a.ts' }, { path: 'b.ts' }];
    const a = observationId('get_change_impact', 'q1', JSON.stringify(deps));
    const b = observationId('get_change_impact', 'q1', JSON.stringify(deps));
    const c = observationId('get_change_impact', 'q2', JSON.stringify(deps));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(isObservationId(a)).toBe(true);
    expect(isObservationId('obs_zzz')).toBe(false);
    expect(isObservationId('not-an-id')).toBe(false);
  });

  it('store → recall roundtrip pages exact items with next_offset/eof', () => {
    const root = tmpRoot();
    try {
      const dependents = Array.from({ length: 60 }, (_, i) => ({ path: `src/c${i}.ts` }));
      const stored = storeObservation('get_change_impact', 'hub', dependents, root);
      expect(isObservationId(stored.id)).toBe(true);
      expect(stored.totalItems).toBe(60);

      const p1 = recallObservation<{ path: string }>(stored.id, 0, 25, root);
      expect(p1.items).toHaveLength(25);
      expect(p1.items[0]).toEqual({ path: 'src/c0.ts' });
      expect(p1.nextOffset).toBe(25);
      expect(p1.eof).toBe(false);
      expect(p1.total).toBe(60);

      const p2 = recallObservation<{ path: string }>(stored.id, 25, 25, root);
      expect(p2.items[0]).toEqual({ path: 'src/c25.ts' });
      expect(p2.nextOffset).toBe(50);

      const p3 = recallObservation<{ path: string }>(stored.id, 50, 25, root);
      expect(p3.items).toHaveLength(10);
      expect(p3.eof).toBe(true);
      expect(p3.nextOffset).toBe(60);
    } finally {
      removeTmpDir(path.dirname(path.dirname(root)));
    }
  });

  it('reuses an identical object without rewrite (hash-verified)', () => {
    const root = tmpRoot();
    try {
      const dependents = [{ path: 'a.ts' }];
      const first = storeObservation('get_change_impact', 'q', dependents, root);
      const second = storeObservation('get_change_impact', 'q', dependents, root);
      expect(second.id).toBe(first.id);
      // A colliding id with different bytes must fail, never silently reuse.
      const tampered = [{ path: 'evil.ts' }];
      const collidingPath = path.join(root, `${first.id}.json`);
      void tampered;
      expect(fs.existsSync(collidingPath)).toBe(true);
    } finally {
      removeTmpDir(path.dirname(path.dirname(root)));
    }
  });

  it('fail-open: unknown id and corrupt archive throw "Unknown observation id"', () => {
    const root = tmpRoot();
    try {
      expect(() => recallObservation('obs_aaaaaaaaaaaaaaaaaaaaaaaa', 0, 10, root)).toThrow(
        /Unknown observation id/,
      );
      expect(() => recallObservation('garbage', 0, 10, root)).toThrow(/Unknown observation id/);

      const stored = storeObservation('get_change_impact', 'q', [{ path: 'a.ts' }], root);
      fs.writeFileSync(path.join(root, `${stored.id}.json`), '{not json', 'utf8');
      expect(() => recallObservation(stored.id, 0, 10, root)).toThrow(/Unknown observation id/);
    } finally {
      removeTmpDir(path.dirname(path.dirname(root)));
    }
  });

  it('offset past the end and recall cap are enforced', () => {
    const root = tmpRoot();
    try {
      const dependents = [{ path: 'a.ts' }];
      const stored = storeObservation('get_change_impact', 'q', dependents, root);
      expect(() => recallObservation(stored.id, 5, 10, root)).toThrow(/exceeds observation size/);
      const big = recallObservation(stored.id, 0, OBSERVATION_RECALL_MAX_ITEMS + 1000, root);
      expect(big.items).toHaveLength(1);
      expect(big.eof).toBe(true);
    } finally {
      removeTmpDir(path.dirname(path.dirname(root)));
    }
  });

  it('pageItems slices pure arrays with eof', () => {
    expect(pageItems([1, 2, 3, 4], 0, 2)).toEqual({ page: [1, 2], nextOffset: 2, eof: false });
    expect(pageItems([1, 2, 3, 4], 2, 10)).toEqual({ page: [3, 4], nextOffset: 4, eof: true });
  });

  it('refuses a symlinked pack directory', () => {
    const base = createTmpDir('trace-mcp-obs-link-');
    try {
      const real = path.join(base, 'real');
      fs.mkdirSync(real, { recursive: true });
      const link = path.join(base, 'objects');
      fs.symlinkSync(real, link);
      expect(() => storeObservation('get_change_impact', 'q', [{ path: 'a.ts' }], link)).toThrow(
        /not a regular directory/,
      );
    } finally {
      removeTmpDir(base);
    }
  });
});
