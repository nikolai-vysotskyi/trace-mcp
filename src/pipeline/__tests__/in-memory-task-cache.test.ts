/**
 * Behavioural coverage for the LRU cap added to `InMemoryTaskCache`.
 *
 * The class previously had no size cap — a long-running daemon that registered
 * a task with an unbounded `key()` domain (e.g. one entry per indexed file)
 * could grow the Map without bound. These tests pin the new behaviour:
 *
 *   - capacity guards `set` so the Map never exceeds the cap.
 *   - LRU bookkeeping: `get` / `has`-then-`get` and `set` of an existing key
 *     move the entry to the tail; eviction always pops the head.
 *   - constructor rejects invalid capacities.
 *
 * The cap is intentionally enforced in `set` only — `has`/`get` are read-only
 * paths so they cannot trigger eviction.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_IN_MEMORY_TASK_CACHE_CAPACITY, InMemoryTaskCache } from '../cache.js';

describe('InMemoryTaskCache', () => {
  it('exposes the default capacity constant', () => {
    expect(DEFAULT_IN_MEMORY_TASK_CACHE_CAPACITY).toBe(1000);
  });

  it('uses the default capacity when none is supplied', () => {
    const cache = new InMemoryTaskCache();
    expect(cache.getCapacity()).toBe(DEFAULT_IN_MEMORY_TASK_CACHE_CAPACITY);
  });

  it('respects a custom capacity', () => {
    const cache = new InMemoryTaskCache(3);
    expect(cache.getCapacity()).toBe(3);
  });

  it('rejects non-positive capacities at construction time', () => {
    expect(() => new InMemoryTaskCache(0)).toThrow(/positive integer/);
    expect(() => new InMemoryTaskCache(-5)).toThrow(/positive integer/);
    expect(() => new InMemoryTaskCache(Number.NaN)).toThrow(/positive integer/);
    expect(() => new InMemoryTaskCache(Number.POSITIVE_INFINITY)).toThrow(/positive integer/);
  });

  it('floors fractional capacities', () => {
    const cache = new InMemoryTaskCache(2.7);
    expect(cache.getCapacity()).toBe(2);
  });

  it('stores and retrieves values below the cap', () => {
    const cache = new InMemoryTaskCache(3);
    cache.set('t', 'a', 1);
    cache.set('t', 'b', 2);
    expect(cache.has('t', 'a')).toBe(true);
    expect(cache.get('t', 'b')).toBe(2);
    expect(cache.size()).toBe(2);
  });

  it('evicts the least-recently-used entry when the cap is exceeded', () => {
    const cache = new InMemoryTaskCache(2);
    cache.set('t', 'a', 1);
    cache.set('t', 'b', 2);
    cache.set('t', 'c', 3); // forces eviction of 'a'

    expect(cache.size()).toBe(2);
    expect(cache.has('t', 'a')).toBe(false);
    expect(cache.has('t', 'b')).toBe(true);
    expect(cache.has('t', 'c')).toBe(true);
  });

  it('bumps recently-read entries to the tail (so they survive eviction)', () => {
    const cache = new InMemoryTaskCache(2);
    cache.set('t', 'a', 1);
    cache.set('t', 'b', 2);
    // Touching 'a' marks it as recently used, so 'b' is now the LRU victim.
    expect(cache.get('t', 'a')).toBe(1);
    cache.set('t', 'c', 3);

    expect(cache.has('t', 'a')).toBe(true);
    expect(cache.has('t', 'b')).toBe(false);
    expect(cache.has('t', 'c')).toBe(true);
  });

  it('treats re-setting an existing key as a touch (does not double-count)', () => {
    const cache = new InMemoryTaskCache(2);
    cache.set('t', 'a', 1);
    cache.set('t', 'b', 2);
    cache.set('t', 'a', 99); // size stays at 2, 'a' moves to tail

    expect(cache.size()).toBe(2);
    expect(cache.get('t', 'a')).toBe(99);

    cache.set('t', 'c', 3);
    // 'b' should be evicted (it was LRU after the re-set of 'a'); 'a' survives.
    expect(cache.has('t', 'a')).toBe(true);
    expect(cache.has('t', 'b')).toBe(false);
    expect(cache.has('t', 'c')).toBe(true);
  });

  it('survives a flood without exceeding the cap', () => {
    const cache = new InMemoryTaskCache(50);
    for (let i = 0; i < 10_000; i++) {
      cache.set('flood', String(i), i);
    }
    expect(cache.size()).toBe(50);
    // The last 50 inserts should be retained.
    expect(cache.has('flood', '9999')).toBe(true);
    expect(cache.has('flood', '9950')).toBe(true);
    expect(cache.has('flood', '9949')).toBe(false);
  });

  it('clear() empties the cache', () => {
    const cache = new InMemoryTaskCache(5);
    cache.set('t', 'a', 1);
    cache.set('t', 'b', 2);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.has('t', 'a')).toBe(false);
  });

  it('clear(taskName) only drops entries for that task', () => {
    const cache = new InMemoryTaskCache(5);
    cache.set('alpha', 'k', 1);
    cache.set('beta', 'k', 2);
    cache.clear('alpha');
    expect(cache.has('alpha', 'k')).toBe(false);
    expect(cache.has('beta', 'k')).toBe(true);
  });

  it('delete drops a single entry without affecting others', () => {
    const cache = new InMemoryTaskCache(5);
    cache.set('t', 'a', 1);
    cache.set('t', 'b', 2);
    cache.delete('t', 'a');
    expect(cache.has('t', 'a')).toBe(false);
    expect(cache.has('t', 'b')).toBe(true);
    expect(cache.size()).toBe(1);
  });

  it('get() returns undefined for a missing key without mutating the map', () => {
    const cache = new InMemoryTaskCache(2);
    cache.set('t', 'a', 1);
    expect(cache.get('t', 'missing')).toBeUndefined();
    expect(cache.size()).toBe(1);
  });
});
