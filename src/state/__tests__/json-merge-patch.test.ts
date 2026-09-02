import { describe, expect, it } from 'vitest';
import { applyJsonMergePatch } from '../json-merge-patch.js';

describe('JSON Merge Patch (RFC 7396)', () => {
  it('applies basic property changes and additions', () => {
    const target = { a: 'b', c: 'd' };
    const patch = { a: 'z', e: 'f' };
    const result = applyJsonMergePatch(target, patch);
    expect(result).toEqual({ a: 'z', c: 'd', e: 'f' });
  });

  it('deletes properties when value is null', () => {
    const target = { a: 'b', c: 'd' };
    const patch = { a: null };
    const result = applyJsonMergePatch(target, patch);
    expect(result).toEqual({ c: 'd' });
    expect('a' in (result as Record<string, unknown>)).toBe(false);
  });

  it('handles nested objects recursively', () => {
    const target = {
      plan: {
        active_step_id: 'step_1',
        steps: [{ id: 'step_1', status: 'pending' }],
      },
      facts: {
        key_symbols: ['Foo'],
        architecture_notes: [] as string[],
      },
    };
    const patch = {
      plan: {
        active_step_id: 'step_2',
      },
      facts: {
        architecture_notes: ['Use SQLite WAL mode'],
      },
    };
    const result = applyJsonMergePatch<typeof target>(target, patch);
    expect(result.plan.active_step_id).toBe('step_2');
    expect(result.plan.steps).toEqual([{ id: 'step_1', status: 'pending' }]);
    expect(result.facts.key_symbols).toEqual(['Foo']);
    expect(result.facts.architecture_notes).toEqual(['Use SQLite WAL mode']);
  });

  it('replaces arrays entirely per RFC 7396', () => {
    const target = { a: [1, 2, 3] };
    const patch = { a: [4, 5] };
    const result = applyJsonMergePatch(target, patch);
    expect(result).toEqual({ a: [4, 5] });
  });

  it('replaces primitives and non-objects directly', () => {
    expect(applyJsonMergePatch('old', 'new')).toBe('new');
    expect(applyJsonMergePatch({ a: 1 }, 'string')).toBe('string');
    expect(applyJsonMergePatch(null, { a: 1 })).toEqual({ a: 1 });
  });

  it('does not mutate original target or patch objects', () => {
    const target = { a: { b: 1 }, list: [1, 2] };
    const patch = { a: { c: 2 }, list: [3] };
    const result = applyJsonMergePatch(target, patch);

    expect(target).toEqual({ a: { b: 1 }, list: [1, 2] });
    expect(result).toEqual({ a: { b: 1, c: 2 }, list: [3] });
  });
});
