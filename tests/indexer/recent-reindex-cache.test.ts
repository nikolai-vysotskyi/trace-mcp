import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetRecentReindexCache,
  clearProjectReindexCache,
  shouldSkipRecentReindex,
  TTL_MS,
} from '../../src/indexer/recent-reindex-cache.js';

describe('recent-reindex-cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    __resetRecentReindexCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetRecentReindexCache();
  });

  it('first call returns false; immediate second call returns true', () => {
    const project = '/tmp/proj-a';
    const file = 'src/foo.ts';
    expect(shouldSkipRecentReindex(project, file, 100)).toBe(false);
    expect(shouldSkipRecentReindex(project, file, 200)).toBe(true);
  });

  it('different files in the same project do not dedup each other', () => {
    const project = '/tmp/proj-a';
    expect(shouldSkipRecentReindex(project, 'src/a.ts', 100)).toBe(false);
    expect(shouldSkipRecentReindex(project, 'src/b.ts', 110)).toBe(false);
    expect(shouldSkipRecentReindex(project, 'src/a.ts', 120)).toBe(true);
    expect(shouldSkipRecentReindex(project, 'src/b.ts', 130)).toBe(true);
  });

  it('same path in different projects does not dedup across projects', () => {
    const file = 'src/foo.ts';
    expect(shouldSkipRecentReindex('/tmp/proj-a', file, 100)).toBe(false);
    expect(shouldSkipRecentReindex('/tmp/proj-b', file, 110)).toBe(false);
    expect(shouldSkipRecentReindex('/tmp/proj-a', file, 120)).toBe(true);
    expect(shouldSkipRecentReindex('/tmp/proj-b', file, 130)).toBe(true);
  });

  it('after TTL expires the call is no longer deduped', () => {
    // TTL was widened from 500ms to 2000ms to cover the latency skew
    // between parcel-watcher, the PostToolUse HTTP hook, and the
    // register_edit MCP tool — a single Edit can fire all three within
    // ~1-1.5s, so 500ms missed the duplicates.
    const project = '/tmp/proj-a';
    const file = 'src/foo.ts';
    expect(shouldSkipRecentReindex(project, file, 0)).toBe(false);
    // boundary: exactly TTL_MS later should NOT be skipped
    expect(shouldSkipRecentReindex(project, file, TTL_MS)).toBe(false);
  });

  it('within TTL boundary stays deduped', () => {
    const project = '/tmp/proj-a';
    const file = 'src/foo.ts';
    expect(shouldSkipRecentReindex(project, file, 0)).toBe(false);
    expect(shouldSkipRecentReindex(project, file, TTL_MS - 1)).toBe(true);
  });

  it('clearProjectReindexCache drops the bucket so next call returns false', () => {
    const project = '/tmp/proj-a';
    const file = 'src/foo.ts';
    expect(shouldSkipRecentReindex(project, file, 100)).toBe(false);
    expect(shouldSkipRecentReindex(project, file, 200)).toBe(true);
    clearProjectReindexCache(project);
    expect(shouldSkipRecentReindex(project, file, 250)).toBe(false);
  });

  it('clearProjectReindexCache only affects the named project', () => {
    expect(shouldSkipRecentReindex('/tmp/proj-a', 'src/x.ts', 100)).toBe(false);
    expect(shouldSkipRecentReindex('/tmp/proj-b', 'src/x.ts', 100)).toBe(false);
    clearProjectReindexCache('/tmp/proj-a');
    expect(shouldSkipRecentReindex('/tmp/proj-b', 'src/x.ts', 200)).toBe(true);
    expect(shouldSkipRecentReindex('/tmp/proj-a', 'src/x.ts', 200)).toBe(false);
  });

  it('uses Date.now() default when now is omitted', () => {
    vi.setSystemTime(1_000);
    expect(shouldSkipRecentReindex('/tmp/proj-a', 'src/foo.ts')).toBe(false);
    vi.setSystemTime(1_100);
    expect(shouldSkipRecentReindex('/tmp/proj-a', 'src/foo.ts')).toBe(true);
    // Advance past TTL_MS from the first call (t=1_000 + TTL_MS).
    vi.setSystemTime(1_000 + TTL_MS + 100);
    expect(shouldSkipRecentReindex('/tmp/proj-a', 'src/foo.ts')).toBe(false);
  });

  it('garbage-collects expired entries when bucket exceeds 256', () => {
    const project = '/tmp/proj-a';
    // Seed 256 expired entries at t=0.
    for (let i = 0; i < 256; i++) {
      shouldSkipRecentReindex(project, `src/file-${i}.ts`, 0);
    }
    // Add one fresh entry well after TTL — triggers the > 256 GC sweep.
    expect(shouldSkipRecentReindex(project, 'src/fresh.ts', 10_000)).toBe(false);
    // Old entries should now be gone — re-adding them returns false again.
    expect(shouldSkipRecentReindex(project, 'src/file-0.ts', 10_001)).toBe(false);
  });
});
