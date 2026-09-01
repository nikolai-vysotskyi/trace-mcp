import { describe, expect, it } from 'vitest';
import {
  applyMergePatch,
  cloneValue,
  createMergePatch,
  isPlainObject,
} from '../../src/state/merge-patch.js';

describe('RFC 7396 JSON Merge Patch', () => {
  describe('applyMergePatch', () => {
    it('replaces target when patch is a primitive or array', () => {
      expect(applyMergePatch({ a: 'b' }, 'scalar')).toBe('scalar');
      expect(applyMergePatch({ a: 'b' }, 42)).toBe(42);
      expect(applyMergePatch({ a: 'b' }, true)).toBe(true);
      expect(applyMergePatch({ a: 'b' }, null)).toBe(null);
      expect(applyMergePatch({ a: 'b' }, [1, 2, 3])).toEqual([1, 2, 3]);
    });

    it('treats target as {} when target is not a plain object', () => {
      expect(applyMergePatch(null, { a: 'b' })).toEqual({ a: 'b' });
      expect(applyMergePatch('primitive', { a: 'b' })).toEqual({ a: 'b' });
      expect(applyMergePatch([1, 2], { a: 'b' })).toEqual({ a: 'b' });
    });

    it('adds new fields to target object', () => {
      const target = { a: '1' };
      const patch = { b: '2', c: 3 };
      const result = applyMergePatch(target, patch);
      expect(result).toEqual({ a: '1', b: '2', c: 3 });
    });

    it('updates existing fields in target object', () => {
      const target = { a: 'old', b: 'keep' };
      const patch = { a: 'new' };
      const result = applyMergePatch(target, patch);
      expect(result).toEqual({ a: 'new', b: 'keep' });
    });

    it('deletes fields when patch value is null', () => {
      const target = { a: 'remove', b: 'keep', c: 'also_remove' };
      const patch = { a: null, c: null };
      const result = applyMergePatch(target, patch);
      expect(result).toEqual({ b: 'keep' });
      expect('a' in (result as object)).toBe(false);
      expect('c' in (result as object)).toBe(false);
    });

    it('recursively merges nested objects', () => {
      const target = {
        title: 'Task',
        nested: {
          sub1: 'val1',
          sub2: 'val2',
          deep: {
            d1: 'keep',
            d2: 'modify',
          },
        },
      };
      const patch = {
        nested: {
          sub2: 'val2_updated',
          sub3: 'new_val',
          deep: {
            d2: 'modified',
            d3: 'added',
          },
        },
      };
      const result = applyMergePatch(target, patch);
      expect(result).toEqual({
        title: 'Task',
        nested: {
          sub1: 'val1',
          sub2: 'val2_updated',
          sub3: 'new_val',
          deep: {
            d1: 'keep',
            d2: 'modified',
            d3: 'added',
          },
        },
      });
    });

    it('deletes nested fields when nested patch value is null', () => {
      const target = {
        nested: {
          keep: 'ok',
          remove_me: 'bye',
        },
      };
      const patch = {
        nested: {
          remove_me: null,
        },
      };
      const result = applyMergePatch(target, patch);
      expect(result).toEqual({
        nested: {
          keep: 'ok',
        },
      });
    });

    it('replaces arrays entirely instead of merging elements', () => {
      const target = {
        tags: ['alpha', 'beta', 'gamma'],
        list: [{ id: 1 }, { id: 2 }],
      };
      const patch = {
        tags: ['delta'],
        list: [{ id: 3 }],
      };
      const result = applyMergePatch(target, patch);
      expect(result).toEqual({
        tags: ['delta'],
        list: [{ id: 3 }],
      });
    });

    it('does not mutate original target object in place', () => {
      const target = {
        a: 'original',
        nested: {
          b: 'original_nested',
        },
      };
      const patch = {
        a: 'changed',
        nested: {
          b: 'changed_nested',
          c: 'new',
        },
      };

      const result = applyMergePatch(target, patch);
      expect(target.a).toBe('original');
      expect(target.nested.b).toBe('original_nested');
      expect('c' in target.nested).toBe(false);
      expect(result).toEqual({
        a: 'changed',
        nested: {
          b: 'changed_nested',
          c: 'new',
        },
      });
    });

    it('handles official RFC 7396 Section 3 test cases', () => {
      // RFC 7396 Section 3 Examples:
      // Target: {"a":"b","c":{"d":"e","f":"g"}}
      // Patch: {"a":"z","c":{"f":null}}
      // Result: {"a":"z","c":{"d":"e"}}
      const target1 = { a: 'b', c: { d: 'e', f: 'g' } };
      const patch1 = { a: 'z', c: { f: null } };
      expect(applyMergePatch(target1, patch1)).toEqual({ a: 'z', c: { d: 'e' } });

      // Target: {"a":"b"}
      // Patch: {"a":null}
      // Result: {}
      expect(applyMergePatch({ a: 'b' }, { a: null })).toEqual({});

      // Target: {"a":"b"}
      // Patch: {"a":"c"}
      // Result: {"a":"c"}
      expect(applyMergePatch({ a: 'b' }, { a: 'c' })).toEqual({ a: 'c' });

      // Target: {"a":"b"}
      // Patch: {"b":"c"}
      // Result: {"a":"b","b":"c"}
      expect(applyMergePatch({ a: 'b' }, { b: 'c' })).toEqual({ a: 'b', b: 'c' });

      // Target: {"a":"b"}
      // Patch: "c"
      // Result: "c"
      expect(applyMergePatch({ a: 'b' }, 'c')).toBe('c');

      // Target: {"a":["b"]}
      // Patch: {"a":"c"}
      // Result: {"a":"c"}
      expect(applyMergePatch({ a: ['b'] }, { a: 'c' })).toEqual({ a: 'c' });

      // Target: {"a":"c"}
      // Patch: {"a":["b"]}
      // Result: {"a":["b"]}
      expect(applyMergePatch({ a: 'c' }, { a: ['b'] })).toEqual({ a: ['b'] });

      // Target: {"a":{"b":"c"}}
      // Patch: {"a":{}}
      // Result: {"a":{"b":"c"}}
      expect(applyMergePatch({ a: { b: 'c' } }, { a: {} })).toEqual({
        a: { b: 'c' },
      });
    });
  });

  describe('createMergePatch', () => {
    it('returns undefined when source and target are equal', () => {
      const obj = { a: '1', b: { c: 2 } };
      expect(createMergePatch(obj, obj)).toBeUndefined();
      expect(createMergePatch({ a: 1 }, { a: 1 })).toBeUndefined();
    });

    it('creates diff with null for deleted keys and new values for added keys', () => {
      const source = { a: '1', b: '2', c: { d: '3', e: '4' } };
      const target = { a: '1', b: 'changed', c: { d: '3' }, f: 'added' };

      const patch = createMergePatch(source, target);
      expect(patch).toEqual({
        b: 'changed',
        c: {
          e: null,
        },
        f: 'added',
      });

      // Applying this patch to source must produce target
      expect(applyMergePatch(source, patch)).toEqual(target);
    });
  });

  describe('helpers', () => {
    it('isPlainObject correctly distinguishes plain objects', () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject({ a: 1 })).toBe(true);
      expect(isPlainObject(Object.create(null))).toBe(true);

      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject(undefined)).toBe(false);
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject('str')).toBe(false);
      expect(isPlainObject(123)).toBe(false);
      expect(isPlainObject(new Date())).toBe(false);
      expect(isPlainObject(/abc/)).toBe(false);
      expect(isPlainObject(new Uint8Array())).toBe(false);
    });

    it('cloneValue handles primitives and objects safely', () => {
      expect(cloneValue(42)).toBe(42);
      expect(cloneValue('hello')).toBe('hello');
      expect(cloneValue(null)).toBe(null);
      const original = { a: [1, 2], b: { c: 'd' } };
      const cloned = cloneValue(original);
      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.a).not.toBe(original.a);
      expect(cloned.b).not.toBe(original.b);
    });
  });
});
