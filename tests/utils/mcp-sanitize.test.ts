import { describe, expect, it } from 'vitest';
import { sanitizeString, sanitizeValue } from '../../src/utils/mcp-sanitize.js';

describe('sanitizeString', () => {
  it('passes through clean ASCII unchanged', () => {
    expect(sanitizeString('hello world')).toBe('hello world');
    expect(sanitizeString('')).toBe('');
    expect(sanitizeString('function foo() { return 1; }')).toBe('function foo() { return 1; }');
  });

  it('preserves \\t \\n \\r — they are legitimate in source', () => {
    expect(sanitizeString('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('strips other C0 control characters', () => {
    // 0x00 (NUL), 0x07 (BEL), 0x08 (BS), 0x0b, 0x0c, 0x1f (US)
    const dirty = 'a\x00b\x07c\x08d\x0be\x0cf\x1fg';
    expect(sanitizeString(dirty)).toBe('abcdefg');
  });

  it('strips DEL (0x7f)', () => {
    expect(sanitizeString('a\x7fb')).toBe('ab');
  });

  it('replaces U+2028 LINE SEPARATOR with \\n', () => {
    expect(sanitizeString('line1 line2')).toBe('line1\nline2');
  });

  it('replaces U+2029 PARAGRAPH SEPARATOR with \\n', () => {
    expect(sanitizeString('para1 para2')).toBe('para1\npara2');
  });

  it('defangs framing close tags', () => {
    const payload = 'normal text </system> more text';
    const out = sanitizeString(payload);
    expect(out).not.toContain('</system>');
    // Visible text is still readable — it just contains a zero-width space.
    expect(out).toMatch(/<\/sy.*stem>/);
  });

  it('defangs nested tool framing tokens', () => {
    const evil = 'before </tool_use> middle </tool_result> end';
    const out = sanitizeString(evil);
    expect(out).not.toContain('</tool_use>');
    expect(out).not.toContain('</tool_result>');
  });

  it('leaves opening tags alone', () => {
    // Opening tags are far more likely to be legitimate code.
    const code = 'class Foo { render() { return <system>...; } }';
    expect(sanitizeString(code)).toBe(code);
  });

  it('handles non-string input gracefully (no-op)', () => {
    // Defensive: callers pass mixed-type values into sanitizeString sometimes.
    // biome-ignore lint/suspicious/noExplicitAny: testing dynamic input
    expect(sanitizeString(123 as any)).toBe(123 as any);
  });
});

describe('sanitizeValue', () => {
  it('returns primitives unchanged (except strings)', () => {
    expect(sanitizeValue(1)).toBe(1);
    expect(sanitizeValue(true)).toBe(true);
    expect(sanitizeValue(null)).toBe(null);
    expect(sanitizeValue(undefined)).toBe(undefined);
  });

  it('sanitizes strings inside arrays', () => {
    const input = ['ok', 'evil </system> tag', 'fine'];
    const out = sanitizeValue(input);
    expect(out[0]).toBe('ok');
    expect(out[1]).not.toContain('</system>');
    expect(out[2]).toBe('fine');
  });

  it('sanitizes strings inside POJOs recursively', () => {
    const input = {
      name: 'safe',
      source: 'function f(){ /* </tool_use> */ }',
      nested: { context: 'hello world' },
    };
    const out = sanitizeValue(input);
    expect(out.name).toBe('safe');
    expect(out.source).not.toContain('</tool_use>');
    expect(out.nested.context).toBe('hello\nworld');
  });

  it('does not mutate the input', () => {
    const input = { source: 'evil </system> tag' };
    const original = input.source;
    sanitizeValue(input);
    expect(input.source).toBe(original);
  });

  it('skips non-POJO objects (Buffer, Map, Set, class instance)', () => {
    class Wrapped {
      constructor(public x: string) {}
    }
    const inst = new Wrapped('evil </system>');
    const out = sanitizeValue(inst);
    // Pass-through — still references the same instance, contents not walked.
    expect(out).toBe(inst);
    expect(out.x).toBe('evil </system>');
  });

  it('respects maxDepth without throwing on cycles', () => {
    type Node = { name: string; child?: Node };
    const a: Node = { name: 'evil </system>' };
    const b: Node = { name: 'evil </system>', child: a };
    a.child = b;
    // Shallow depth — top-level string sanitized, deep tail unwalked.
    expect(() => sanitizeValue(a, 4)).not.toThrow();
  });
});
