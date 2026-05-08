import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { optionalEnum, optionalNonEmptyString } from '../../src/tools/register/_zod-helpers.js';

describe('optionalNonEmptyString', () => {
  const schema = z.object({
    file_pattern: optionalNonEmptyString(512),
  });

  it('coerces empty string to undefined', () => {
    const out = schema.parse({ file_pattern: '' });
    expect(out.file_pattern).toBeUndefined();
  });

  it('coerces null to undefined', () => {
    const out = schema.parse({ file_pattern: null });
    expect(out.file_pattern).toBeUndefined();
  });

  it('passes through real values unchanged', () => {
    const out = schema.parse({ file_pattern: 'src/**/*.ts' });
    expect(out.file_pattern).toBe('src/**/*.ts');
  });

  it('omits → undefined', () => {
    const out = schema.parse({});
    expect(out.file_pattern).toBeUndefined();
  });

  it('still enforces maxLen', () => {
    const tooLong = 'a'.repeat(600);
    expect(() => schema.parse({ file_pattern: tooLong })).toThrow();
  });

  it('rejects non-string non-null/empty values', () => {
    expect(() => schema.parse({ file_pattern: 42 })).toThrow();
    expect(() => schema.parse({ file_pattern: ['arr'] })).toThrow();
  });
});

describe('optionalEnum', () => {
  const schema = z.object({
    kind: optionalEnum(['function', 'class', 'method']),
  });

  it('coerces empty string to undefined', () => {
    const out = schema.parse({ kind: '' });
    expect(out.kind).toBeUndefined();
  });

  it('coerces null to undefined', () => {
    const out = schema.parse({ kind: null });
    expect(out.kind).toBeUndefined();
  });

  it('passes through valid enum values', () => {
    const out = schema.parse({ kind: 'class' });
    expect(out.kind).toBe('class');
  });

  it('rejects unknown enum values', () => {
    expect(() => schema.parse({ kind: 'enum' })).toThrow();
  });
});
