/**
 * TRA-371: Project Overview showed "Last indexed" four hours off while the
 * Workspace table showed the same instant correctly. The Workspace table reads
 * the registry (`new Date().toISOString()`); Overview reads `MAX(indexed_at)`
 * from SQLite, which `datetime('now')` writes as naive-UTC — a shape `new Date()`
 * treats as local. These assertions are timezone-independent because they only
 * ever compare ISO output.
 */
import { describe, expect, it } from 'vitest';
import { sqliteUtcToIso } from '../sqlite-time.js';

describe('sqliteUtcToIso', () => {
  it("reads SQLite's datetime('now') shape as UTC, not local", () => {
    // The reported instant: indexed at 13:23 in UTC+4, stored as 09:23 UTC.
    expect(sqliteUtcToIso('2026-08-29 09:23:45')).toBe('2026-08-29T09:23:45.000Z');
  });

  it('agrees with the registry for the same instant', () => {
    const registry = new Date('2026-08-29T09:23:45.000Z').toISOString();
    expect(sqliteUtcToIso('2026-08-29 09:23:45')).toBe(registry);
  });

  it('leaves already-zoned values alone', () => {
    expect(sqliteUtcToIso('2026-08-29T09:23:45.000Z')).toBe('2026-08-29T09:23:45.000Z');
    expect(sqliteUtcToIso('2026-08-29T13:23:45+04:00')).toBe('2026-08-29T09:23:45.000Z');
  });

  it('keeps sub-second precision when SQLite has it', () => {
    expect(sqliteUtcToIso('2026-08-29 09:23:45.500')).toBe('2026-08-29T09:23:45.500Z');
  });

  it('returns null for absent or unparseable values', () => {
    expect(sqliteUtcToIso(null)).toBeNull();
    expect(sqliteUtcToIso(undefined)).toBeNull();
    expect(sqliteUtcToIso('')).toBeNull();
    expect(sqliteUtcToIso('not a date')).toBeNull();
  });
});
