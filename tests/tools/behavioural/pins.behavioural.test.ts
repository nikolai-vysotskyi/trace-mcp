/**
 * Behavioural coverage for `pin_file` / `unpin` / `list_pins` (all backed by
 * src/scoring/pins.ts). The existing tests/scoring/pins.test.ts covers most
 * of the CRUD invariants — this file complements it by asserting the
 * tool-level contract behaviour: cap rejection messaging, demotion weights,
 * created_at DESC ordering for list_pins, and the default getFilePinWeight
 * fallback for unpinned files.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  PIN_MAX_ACTIVE,
  countActivePins,
  deletePin,
  getFilePinWeight,
  invalidatePinsCache,
  listPins,
  upsertPin,
} from '../../../src/scoring/pins.js';
import { createTestStore } from '../../test-utils.js';

describe('pins — behavioural tool-level contract', () => {
  let store = createTestStore();

  beforeEach(() => {
    store = createTestStore();
    invalidatePinsCache();
  });

  it('pin_file then list_pins shows the pinned file', () => {
    const res = upsertPin(store.db, {
      scope: 'file',
      target_id: 'src/canonical.ts',
      weight: 2.0,
    });
    expect(res.ok).toBe(true);

    const pins = listPins(store.db);
    expect(pins.length).toBe(1);
    expect(pins[0].scope).toBe('file');
    expect(pins[0].target_id).toBe('src/canonical.ts');
    expect(pins[0].weight).toBe(2.0);
  });

  it('pin_file with weight=0.5 records a demotion weight', () => {
    const res = upsertPin(store.db, {
      scope: 'file',
      target_id: 'src/demoted.ts',
      weight: 0.5,
    });
    expect(res.ok).toBe(true);
    expect(res.row?.weight).toBe(0.5);
    // Weight under 1 means demotion — verify retrieval matches.
    expect(getFilePinWeight(store.db, 'src/demoted.ts')).toBe(0.5);
  });

  it('pin_file at the cap (50 active pins) rejects with a "cap reached" reason', () => {
    for (let i = 0; i < PIN_MAX_ACTIVE; i++) {
      const r = upsertPin(store.db, { scope: 'file', target_id: `src/f${i}.ts` });
      expect(r.ok).toBe(true);
    }
    const overflow = upsertPin(store.db, { scope: 'file', target_id: 'src/overflow.ts' });
    expect(overflow.ok).toBe(false);
    expect(overflow.reason).toMatch(/cap reached/i);
    expect(countActivePins(store.db)).toBe(PIN_MAX_ACTIVE);
  });

  it('unpin removes the pin and list_pins no longer reports it', () => {
    upsertPin(store.db, { scope: 'file', target_id: 'src/temp.ts', weight: 1.5 });
    expect(listPins(store.db).length).toBe(1);
    const del = deletePin(store.db, { scope: 'file', target_id: 'src/temp.ts' });
    expect(del.ok).toBe(true);
    expect(del.deleted).toBe(1);
    expect(listPins(store.db).length).toBe(0);
  });

  it('list_pins returns multiple pins in created_at DESC order', () => {
    upsertPin(store.db, { scope: 'file', target_id: 'src/first.ts' });
    // Insert with a small backoff so created_at values differ on systems
    // with millisecond-only timestamp resolution.
    const start = Date.now();
    while (Date.now() === start) {
      /* spin for at most 1ms */
    }
    upsertPin(store.db, { scope: 'file', target_id: 'src/second.ts' });
    while (Date.now() === start + 1) {
      /* one more tick */
    }
    upsertPin(store.db, { scope: 'file', target_id: 'src/third.ts' });

    const pins = listPins(store.db);
    expect(pins.length).toBe(3);
    for (let i = 1; i < pins.length; i++) {
      expect(pins[i - 1].created_at).toBeGreaterThanOrEqual(pins[i].created_at);
    }
  });

  it('getFilePinWeight returns 1.0 for an unpinned file (neutral default)', () => {
    expect(getFilePinWeight(store.db, 'src/never-pinned.ts')).toBe(1.0);
  });
});
