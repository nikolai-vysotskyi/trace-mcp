/**
 * Tests for the cross-tool `detail_level` knob.
 *
 * The contract is small but easy to break: minimal-mode response items must
 * drop the heavyweight fields (signature/fqn/score/decorators) and keep the
 * essentials (name/file/line) so callers can still pick a target before
 * escalating to a deeper tool.
 */
import { describe, expect, it } from 'vitest';
import {
  compactOutlineSymbols,
  compactSearchItems,
  compactUsageRefs,
  isMinimal,
  type OutlineSymbolFull,
  type SearchItemFull,
  type UsageRefFull,
} from '../../src/tools/_common/detail-level.js';

describe('isMinimal', () => {
  it('returns true only for "minimal"', () => {
    expect(isMinimal('minimal')).toBe(true);
    expect(isMinimal('default')).toBe(false);
    expect(isMinimal('full')).toBe(false);
    expect(isMinimal(undefined)).toBe(false);
  });
});

describe('compactSearchItems', () => {
  const full: SearchItemFull[] = [
    {
      symbol_id: 'src/foo.ts::Foo#class',
      name: 'Foo',
      kind: 'class',
      fqn: 'src.foo.Foo',
      signature: 'export class Foo',
      summary: 'A test fixture class',
      file: 'src/foo.ts',
      line: 12,
      score: 0.91,
      decorators: ['Injectable'],
    },
  ];

  it('keeps name, kind, file, line', () => {
    const out = compactSearchItems(full);
    expect(out).toEqual([{ name: 'Foo', kind: 'class', file: 'src/foo.ts', line: 12 }]);
  });

  it('drops the heavy-token fields', () => {
    const out = compactSearchItems(full)[0];
    expect((out as Record<string, unknown>).symbol_id).toBeUndefined();
    expect((out as Record<string, unknown>).fqn).toBeUndefined();
    expect((out as Record<string, unknown>).signature).toBeUndefined();
    expect((out as Record<string, unknown>).summary).toBeUndefined();
    expect((out as Record<string, unknown>).score).toBeUndefined();
    expect((out as Record<string, unknown>).decorators).toBeUndefined();
  });

  it('produces less JSON than the full payload', () => {
    const fullJson = JSON.stringify(full);
    const minJson = JSON.stringify(compactSearchItems(full));
    expect(minJson.length).toBeLessThan(fullJson.length / 2);
  });
});

describe('compactOutlineSymbols', () => {
  const full: OutlineSymbolFull[] = [
    {
      symbolId: 'src/foo.ts::bar#function',
      name: 'bar',
      kind: 'function',
      signature: 'function bar(arg: number): Promise<Result>',
      lineStart: 42,
      lineEnd: 99,
    },
  ];

  it('keeps name, kind, line; drops symbolId and signature', () => {
    const out = compactOutlineSymbols(full);
    expect(out).toEqual([{ name: 'bar', kind: 'function', line: 42 }]);
    expect((out[0] as Record<string, unknown>).signature).toBeUndefined();
    expect((out[0] as Record<string, unknown>).symbolId).toBeUndefined();
    expect((out[0] as Record<string, unknown>).lineEnd).toBeUndefined();
  });

  it('handles missing lineStart by emitting null', () => {
    const out = compactOutlineSymbols([{ symbolId: 'x', name: 'x', kind: 'function' }]);
    expect(out[0].line).toBeNull();
  });
});

describe('compactUsageRefs', () => {
  const full: UsageRefFull[] = [
    {
      edge_type: 'calls',
      resolution_tier: 'ast_resolved',
      symbol: { name: 'Foo', kind: 'class', signature: 'export class Foo', line_start: 12 },
      file: 'src/foo.ts',
    },
  ];

  it('keeps file, line, name; drops edge metadata + signature', () => {
    const out = compactUsageRefs(full);
    expect(out).toEqual([{ file: 'src/foo.ts', line: 12, name: 'Foo' }]);
    expect((out[0] as Record<string, unknown>).edge_type).toBeUndefined();
    expect((out[0] as Record<string, unknown>).resolution_tier).toBeUndefined();
  });
});
