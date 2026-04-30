import { describe, expect, it } from 'vitest';
import { decodeWire, encodeWire, stringifyCompactJson } from '../../src/server/wire-format.js';

describe('wire-format', () => {
  const sampleResponse = {
    items: [
      { file: 'src/a.ts', line: 10, name: 'foo', score: 1.5 },
      { file: 'src/a.ts', line: 25, name: 'bar', score: 1.2 },
      { file: 'src/b.ts', line: 5, name: 'baz', score: 0.9 },
    ],
    total: 3,
  };

  describe('encodeWire format=json', () => {
    it('returns standard JSON with nulls stripped', () => {
      const r = encodeWire({ a: 1, b: null, c: 'x' }, 'json');
      expect(r.format).toBe('json');
      expect(r.text).toBe('{"a":1,"c":"x"}');
    });
  });

  describe('encodeWire format=compact', () => {
    it('produces a __wire-tagged envelope with row-packed homogeneous arrays', () => {
      const r = encodeWire(sampleResponse, 'compact');
      expect(r.format).toBe('compact');
      const parsed = JSON.parse(r.text) as Record<string, unknown>;
      expect(parsed.__wire).toBe('compact-v1');
      const body = parsed.body as Record<string, unknown>;
      const items = body.items as Record<string, unknown>;
      expect(items.__rows).toEqual(['file', 'line', 'name', 'score']);
      expect(Array.isArray(items.data)).toBe(true);
      const data = items.data as unknown[][];
      expect(data).toHaveLength(3);
    });

    it('round-trips losslessly via decodeWire', () => {
      const encoded = encodeWire(sampleResponse, 'compact');
      const decoded = decodeWire(encoded.text);
      expect(decoded).toEqual(sampleResponse);
    });

    it('keeps small arrays dense (below minRowPackSize)', () => {
      const small = { items: [{ a: 1 }, { a: 2 }] };
      const r = encodeWire(small, 'compact');
      const parsed = JSON.parse(r.text) as Record<string, unknown>;
      const body = parsed.body as Record<string, unknown>;
      // Small array should remain as a dense JSON array, not row-packed.
      expect(Array.isArray(body.items)).toBe(true);
    });

    it('does not row-pack heterogeneous arrays', () => {
      const mixed = { items: [{ a: 1 }, { b: 2 }, { c: 3 }] };
      const r = encodeWire(mixed, 'compact');
      const decoded = decodeWire(r.text);
      expect(decoded).toEqual(mixed);
      const parsed = JSON.parse(r.text) as Record<string, unknown>;
      const body = parsed.body as Record<string, unknown>;
      expect(Array.isArray(body.items)).toBe(true);
    });

    it('interns repeated path strings when internPaths=true', () => {
      const longPathResponse = {
        items: [
          { file: 'src/services/auth.ts', line: 10 },
          { file: 'src/services/auth.ts', line: 25 },
          { file: 'src/services/payment.ts', line: 5 },
        ],
      };
      const r = encodeWire(longPathResponse, 'compact', { internPaths: true, rowPack: false });
      const parsed = JSON.parse(r.text) as Record<string, unknown>;
      expect(parsed.__dict).toEqual(['src/services/auth.ts']); // only path repeating ≥2x and >8 chars
      expect(decodeWire(r.text)).toEqual(longPathResponse);
    });
  });

  describe('encodeWire format=auto', () => {
    it('falls back to JSON when compact does not beat the threshold', () => {
      const tiny = { ok: true };
      const r = encodeWire(tiny, 'auto');
      expect(r.format).toBe('json');
    });

    it('emits compact when savings exceed the threshold', () => {
      // Large homogeneous array → row-packing wins by a wide margin.
      const big = {
        items: Array.from({ length: 50 }, (_, i) => ({
          file: `src/services/some/long/path/Module${i}.ts`,
          line: i,
          name: `symbol_${i}`,
          score: i / 10,
        })),
      };
      const r = encodeWire(big, 'auto');
      expect(r.format).toBe('compact');
    });

    it('respects a custom autoThreshold', () => {
      // Set threshold so high that compact never wins.
      const big = { items: Array.from({ length: 50 }, (_, i) => ({ a: i, b: i, c: i })) };
      const r = encodeWire(big, 'auto', { autoThreshold: 0.99 });
      expect(r.format).toBe('json');
    });
  });

  describe('stringifyCompactJson', () => {
    it('matches the legacy null-stripping serializer behavior', () => {
      expect(stringifyCompactJson({ a: null, b: undefined, c: 1 })).toBe('{"c":1}');
    });
  });
});
