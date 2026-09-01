import { describe, expect, it } from 'vitest';
import { applyJsonMergePatch } from '../merge-patch.js';

describe('RFC 7396 JSON Merge Patch', () => {
  // Test cases from RFC 7396 Section 3
  it('replaces primitive values', () => {
    expect(applyJsonMergePatch({ a: 'b' }, { a: 'c' })).toEqual({ a: 'c' });
  });

  it('adds new keys', () => {
    expect(applyJsonMergePatch({ a: 'b' }, { b: 'c' })).toEqual({ a: 'b', b: 'c' });
  });

  it('removes keys with null value', () => {
    expect(applyJsonMergePatch({ a: 'b' }, { a: null })).toEqual({});
  });

  it('removes keys in nested objects with null value', () => {
    expect(
      applyJsonMergePatch({ a: 'b', b: { c: 'd', e: 'f' } }, { a: 'z', b: { c: null } }),
    ).toEqual({ a: 'z', b: { e: 'f' } });
  });

  it('replaces arrays entirely', () => {
    expect(applyJsonMergePatch({ a: ['b'] }, { a: 'c' })).toEqual({ a: 'c' });
    expect(applyJsonMergePatch({ a: 'c' }, { a: ['b'] })).toEqual({ a: ['b'] });
    expect(applyJsonMergePatch({ a: { b: 'c' } }, { a: [1] })).toEqual({ a: [1] });
    expect(applyJsonMergePatch(['a', 'b'], ['c', 'd'])).toEqual(['c', 'd']);
  });

  it('handles non-object patches', () => {
    expect(applyJsonMergePatch({ a: 'b' }, ['c'])).toEqual(['c']);
    expect(applyJsonMergePatch({ a: 'b' }, 'primitive')).toEqual('primitive');
    expect(applyJsonMergePatch({ a: 'b' }, 123)).toEqual(123);
  });

  it('handles null target', () => {
    expect(applyJsonMergePatch(null, { a: 'b' })).toEqual({ a: 'b' });
  });

  it('does not mutate original target or patch objects', () => {
    const target = { a: { b: 1, c: 2 }, d: [1, 2] };
    const patch = { a: { b: 10, c: null } };
    const result = applyJsonMergePatch(target, patch);

    expect(result).toEqual({ a: { b: 10 }, d: [1, 2] });
    expect(target).toEqual({ a: { b: 1, c: 2 }, d: [1, 2] });
    expect(patch).toEqual({ a: { b: 10, c: null } });
  });
});
