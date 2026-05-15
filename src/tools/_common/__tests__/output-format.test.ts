import { describe, expect, it } from 'vitest';
import { decode as toonDecode } from '@toon-format/toon';
import { OutputFormatSchema, encodeResponse, isToonRequested } from '../output-format.js';

describe('output-format', () => {
  describe('OutputFormatSchema', () => {
    it('accepts json, markdown, toon and undefined', () => {
      expect(OutputFormatSchema.parse('json')).toBe('json');
      expect(OutputFormatSchema.parse('markdown')).toBe('markdown');
      expect(OutputFormatSchema.parse('toon')).toBe('toon');
      expect(OutputFormatSchema.parse(undefined)).toBeUndefined();
    });

    it('rejects unknown formats', () => {
      expect(() => OutputFormatSchema.parse('xml')).toThrow();
    });
  });

  describe('encodeResponse — default and json', () => {
    it('returns valid JSON parseable back to input when format is undefined', () => {
      const payload = { hello: 'world', n: 42, list: [1, 2, 3] };
      const out = encodeResponse(payload, undefined);
      expect(JSON.parse(out)).toEqual(payload);
    });

    it('returns valid JSON parseable back to input when format is "json"', () => {
      const payload = { hello: 'world', n: 42, list: [1, 2, 3] };
      const out = encodeResponse(payload, 'json');
      expect(JSON.parse(out)).toEqual(payload);
    });

    it('produces compact (non-pretty) JSON', () => {
      const payload = { a: 1, b: 2 };
      const out = encodeResponse(payload, 'json');
      expect(out).not.toContain('\n');
      expect(out).not.toContain('  ');
    });
  });

  describe('encodeResponse — toon', () => {
    it('encodes a tabular array and round-trips via decode()', () => {
      const payload = [
        { a: 1, b: 'x' },
        { a: 2, b: 'y' },
      ];
      const out = encodeResponse(payload, 'toon');
      expect(out).toBeTruthy();
      expect(out.length).toBeGreaterThan(0);
      expect(out).toContain('a');
      expect(out).toContain('b');
      const decoded = toonDecode(out);
      expect(decoded).toEqual(payload);
    });

    it('encodes nested objects losslessly', () => {
      const payload = {
        items: [
          { id: 1, name: 'foo' },
          { id: 2, name: 'bar' },
        ],
        total: 2,
      };
      const out = encodeResponse(payload, 'toon');
      const decoded = toonDecode(out);
      expect(decoded).toEqual(payload);
    });

    it('falls back to JSON.stringify for a primitive string', () => {
      const out = encodeResponse('plain string', 'toon');
      expect(out).toBe(JSON.stringify('plain string'));
    });

    it('falls back to JSON.stringify for a primitive number', () => {
      const out = encodeResponse(42, 'toon');
      expect(out).toBe(JSON.stringify(42));
    });

    it('falls back to JSON.stringify for null', () => {
      const out = encodeResponse(null, 'toon');
      expect(out).toBe(JSON.stringify(null));
    });

    it('falls back to JSON.stringify for undefined', () => {
      const out = encodeResponse(undefined, 'toon');
      expect(out).toBe(JSON.stringify(undefined));
    });
  });

  describe('encodeResponse — markdown', () => {
    it('throws because markdown is tool-specific', () => {
      expect(() => encodeResponse({ a: 1 }, 'markdown')).toThrow(/markdown is tool-specific/);
    });
  });

  describe('isToonRequested', () => {
    it('narrows correctly for "toon"', () => {
      const v: unknown = 'toon';
      expect(isToonRequested(v)).toBe(true);
      if (isToonRequested(v)) {
        const t: 'toon' = v;
        expect(t).toBe('toon');
      }
    });

    it('returns false for other formats', () => {
      expect(isToonRequested('json')).toBe(false);
      expect(isToonRequested('markdown')).toBe(false);
      expect(isToonRequested(undefined)).toBe(false);
      expect(isToonRequested(null)).toBe(false);
      expect(isToonRequested(42)).toBe(false);
      expect(isToonRequested({})).toBe(false);
    });
  });
});
