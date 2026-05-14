/**
 * Regression test for N1: the previous revision of `src/scoring/pins.ts`
 * kept a 30s module-level cache of the `ranking_pins` table that was only
 * invalidated by the sanctioned helpers (`upsertPin` / `deletePin`). Any
 * code path that wrote to the table directly — bulk migrations, importers,
 * test fixtures, raw SQL — silently saw stale weights for up to 30 seconds.
 *
 * These tests exercise the bug class by mutating `ranking_pins` via raw
 * SQL and asserting the very next pin read reflects the change immediately,
 * with NO call to `invalidatePinsCache()` between the write and the read.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import {
  getFilePinWeight,
  getFilePinWeightExplicit,
  getSymbolPinWeight,
  getSymbolPinWeightsByFile,
  listPins,
} from '../../src/scoring/pins.js';
import { createTestStore } from '../test-utils.js';

function rawInsertPin(
  store: Store,
  scope: 'file' | 'symbol',
  targetId: string,
  weight: number,
): void {
  store.db
    .prepare(
      `INSERT INTO ranking_pins (scope, target_id, weight, expires_at, created_by, created_at)
       VALUES (?, ?, ?, NULL, 'user', ?)`,
    )
    .run(scope, targetId, weight, Date.now());
}

describe('ranking pins — cache staleness regression (N1)', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('direct INSERT into ranking_pins is visible to getFilePinWeight immediately', () => {
    // No prior read — but a previous test in the same process may have
    // populated the old module-level cache. We deliberately do NOT call
    // invalidatePinsCache to prove the helper-bypass path is now safe.
    expect(getFilePinWeight(store.db, 'src/foo.ts')).toBe(1.0);

    rawInsertPin(store, 'file', 'src/foo.ts', 2.5);

    // The previous implementation would have cached the "1.0 / unpinned"
    // result above for 30s and returned 1.0 here. With the cache removed,
    // the very next read sees the freshly-inserted weight.
    expect(getFilePinWeight(store.db, 'src/foo.ts')).toBe(2.5);
    expect(getFilePinWeightExplicit(store.db, 'src/foo.ts')).toBe(2.5);
  });

  it('direct DELETE from ranking_pins is visible to getFilePinWeight immediately', () => {
    rawInsertPin(store, 'file', 'src/foo.ts', 2.5);
    // Prime the read so the (old) cache would have held the 2.5 weight.
    expect(getFilePinWeight(store.db, 'src/foo.ts')).toBe(2.5);

    store.db.prepare('DELETE FROM ranking_pins WHERE target_id = ?').run('src/foo.ts');

    // Old cache would have served the stale 2.5 for up to 30s. New code
    // hits SQLite every time, so the deletion is immediately visible.
    expect(getFilePinWeight(store.db, 'src/foo.ts')).toBe(1.0);
    expect(getFilePinWeightExplicit(store.db, 'src/foo.ts')).toBeUndefined();
  });

  it('direct UPDATE of the weight column is visible immediately', () => {
    rawInsertPin(store, 'file', 'src/foo.ts', 1.5);
    expect(getFilePinWeight(store.db, 'src/foo.ts')).toBe(1.5);

    store.db
      .prepare("UPDATE ranking_pins SET weight = ? WHERE scope = 'file' AND target_id = ?")
      .run(2.75, 'src/foo.ts');

    // Old cache would have continued returning 1.5 until TTL expired.
    expect(getFilePinWeight(store.db, 'src/foo.ts')).toBe(2.75);
  });

  it('symbol-scope direct writes are visible to getSymbolPinWeight and the per-file propagation map', () => {
    // Set up a file + symbol so the JOIN in getSymbolPinWeightsByFile resolves.
    const fileId = store.insertFile('src/svc.ts', 'typescript', 'hash_svc', 100);
    store.insertSymbol(fileId, {
      symbolId: 'sym:Service',
      name: 'Service',
      kind: 'class',
      fqn: 'Service',
      byteStart: 0,
      byteEnd: 100,
      lineStart: 1,
      lineEnd: 10,
    });

    expect(getSymbolPinWeight(store.db, 'sym:Service')).toBe(1.0);
    expect(getSymbolPinWeightsByFile(store.db).size).toBe(0);

    rawInsertPin(store, 'symbol', 'sym:Service', 2.0);

    // Both reads must reflect the direct write without invalidatePinsCache.
    expect(getSymbolPinWeight(store.db, 'sym:Service')).toBe(2.0);
    const propagated = getSymbolPinWeightsByFile(store.db);
    expect(propagated.get('src/svc.ts')).toBe(2.0);
  });

  it('listPins reflects raw inserts immediately (no helper invocation between write and read)', () => {
    expect(listPins(store.db)).toHaveLength(0);
    rawInsertPin(store, 'file', 'src/a.ts', 2.0);
    rawInsertPin(store, 'file', 'src/b.ts', 1.5);
    const rows = listPins(store.db);
    expect(rows.map((r) => r.target_id).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
