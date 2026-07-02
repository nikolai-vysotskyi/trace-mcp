/**
 * Guards the per-project-connection SQLite pragma defaults and the
 * idle-unload sweep default. A per-project daemon connection opens
 * `PRAGMA cache_size` + `PRAGMA mmap_size` (src/db/schema.ts initializeDatabase),
 * so their cost scales linearly with the number of registered projects
 * loaded by the daemon — a 10-project daemon at the old 64 MB cache /
 * 256 MB mmap defaults resident-mapped ~770 MB just for these two pragmas.
 * Pins the lowered defaults and that `project_idle_unload_minutes` is on by
 * default so idle projects get reclaimed without user opt-in.
 */
import { describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../config.js';

describe('per-project memory config defaults', () => {
  const cfg = TraceMcpConfigSchema.parse({});

  it('index_cache_mb defaults to 16 (down from the old hardcoded 64 MB)', () => {
    expect(cfg.index_cache_mb).toBe(16);
  });

  it('index_mmap_mb defaults to 64 (down from the old hardcoded 256 MB)', () => {
    expect(cfg.index_mmap_mb).toBe(64);
  });

  it('index_mmap_mb accepts 0 to disable mmap entirely', () => {
    const parsed = TraceMcpConfigSchema.parse({ index_mmap_mb: 0 });
    expect(parsed.index_mmap_mb).toBe(0);
  });

  it('project_idle_unload_minutes defaults to 30 (enabled out of the box)', () => {
    expect(cfg.project_idle_unload_minutes).toBe(30);
  });

  it('project_idle_unload_minutes accepts 0 to disable the sweep', () => {
    const parsed = TraceMcpConfigSchema.parse({ project_idle_unload_minutes: 0 });
    expect(parsed.project_idle_unload_minutes).toBe(0);
  });

  it('rejects negative values for the memory-sizing knobs', () => {
    expect(() => TraceMcpConfigSchema.parse({ index_cache_mb: -1 })).toThrow();
    expect(() => TraceMcpConfigSchema.parse({ index_mmap_mb: -1 })).toThrow();
    expect(() => TraceMcpConfigSchema.parse({ project_idle_unload_minutes: -1 })).toThrow();
  });
});
