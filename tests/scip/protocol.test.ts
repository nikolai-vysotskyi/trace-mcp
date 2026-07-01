/**
 * Unit coverage for the hand-rolled SCIP protobuf decoder.
 *
 * We don't depend on scip-typescript being installed; instead we hand-encode a
 * tiny SCIP Index with a minimal protobuf writer (mirroring the field numbers
 * the decoder reads) and assert the decoder recovers documents + occurrences.
 */

import { describe, expect, it } from 'vitest';
import {
  type ScipOccurrence,
  SCIP_SYMBOL_ROLE_DEFINITION,
  decodeScipIndex,
} from '../../src/scip/protocol.js';

// ─── Minimal protobuf writer (test-only) ─────────────────────────────────────

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function tag(field: number, wire: number): number[] {
  return varint((field << 3) | wire);
}

function lenField(field: number, payload: number[]): number[] {
  return [...tag(field, 2), ...varint(payload.length), ...payload];
}

function stringField(field: number, s: string): number[] {
  const bytes = [...new TextEncoder().encode(s)];
  return lenField(field, bytes);
}

function varintField(field: number, n: number): number[] {
  return [...tag(field, 0), ...varint(n)];
}

/**
 * Packed `repeated int32` for the occurrence range field (field 1).
 *
 * IMPORTANT: proto3 `int32` is encoded as a PLAIN varint (two's complement) —
 * NOT zig-zag. Only `sint32`/`sint64` use zig-zag. SCIP ranges are always
 * 0-based and non-negative (see scip.proto / docs/scip.md), so this writer
 * must match plain-varint to reflect real `scip-typescript`/`scip-python`
 * output. (A prior version of both this writer AND the decoder used zig-zag —
 * self-consistent in this synthetic round-trip, but wrong vs. real SCIP
 * indexers; see tests/scip/real-scip-e2e.test.ts, which decodes an actual
 * captured .scip file and would have caught this.)
 */
function packedRange(field: number, ints: number[]): number[] {
  const payload: number[] = [];
  for (const n of ints) payload.push(...varint(n));
  return lenField(field, payload);
}

function encodeOccurrence(symbol: string, range: number[], roles: number): number[] {
  return [
    ...packedRange(1, range),
    ...stringField(2, symbol),
    ...(roles ? varintField(3, roles) : []),
  ];
}

function encodeDocument(
  relativePath: string,
  language: string,
  occurrences: Array<{ symbol: string; range: number[]; roles: number }>,
): number[] {
  const out: number[] = [...stringField(1, relativePath)];
  for (const occ of occurrences) {
    out.push(...lenField(2, encodeOccurrence(occ.symbol, occ.range, occ.roles)));
  }
  out.push(...stringField(4, language));
  return out;
}

function encodeIndex(documents: number[][]): Uint8Array {
  const out: number[] = [];
  for (const doc of documents) out.push(...lenField(2, doc));
  return new Uint8Array(out);
}

describe('decodeScipIndex', () => {
  it('decodes documents, occurrences, range and definition role', () => {
    const doc = encodeDocument('src/a.ts', 'TypeScript', [
      {
        symbol: 'scip-ts . . `a.ts`/foo().',
        range: [0, 9, 0, 12],
        roles: SCIP_SYMBOL_ROLE_DEFINITION,
      },
      { symbol: 'scip-ts . . `a.ts`/foo().', range: [3, 4, 3, 7], roles: 0 },
    ]);
    const bytes = encodeIndex([doc]);

    const index = decodeScipIndex(bytes);
    expect(index.documents).toHaveLength(1);

    const d = index.documents[0];
    expect(d.relativePath).toBe('src/a.ts');
    expect(d.language).toBe('TypeScript');
    expect(d.occurrences).toHaveLength(2);

    const def = d.occurrences[0];
    expect(def.symbol).toBe('scip-ts . . `a.ts`/foo().');
    expect(def.isDefinition).toBe(true);
    expect(def.range).toEqual({
      startLine: 0,
      startCharacter: 9,
      endLine: 0,
      endCharacter: 12,
    });

    const ref = d.occurrences[1];
    expect(ref.isDefinition).toBe(false);
    expect(ref.range.startLine).toBe(3);
  });

  it('handles the 3-int same-line range shape', () => {
    const doc = encodeDocument('src/b.ts', 'TypeScript', [
      { symbol: 'sym', range: [5, 2, 8], roles: 0 },
    ]);
    const index = decodeScipIndex(encodeIndex([doc]));
    const occ: ScipOccurrence = index.documents[0].occurrences[0];
    expect(occ.range).toEqual({
      startLine: 5,
      startCharacter: 2,
      endLine: 5,
      endCharacter: 8,
    });
  });

  it('returns an empty index for empty input', () => {
    expect(decodeScipIndex(new Uint8Array(0)).documents).toEqual([]);
  });

  it('correctly skips a LEN field (Document.symbols, field 3) before reading further fields', () => {
    // Regression for the skipField off-by-one: `this.pos += this.readVarint()`
    // captured the pre-call `this.pos`, landing 1 byte short after skipping any
    // LEN-wire field. A Document's `symbols` field (3) is always skipped (this
    // decoder never reads it), so encode one BETWEEN two occurrences and assert
    // both occurrences (and the trailing language field) still decode correctly.
    const symbolInfoPayload = [1, 2, 3, 4, 5, 6, 7, 8]; // arbitrary skip-worthy bytes
    const doc = [
      ...stringField(1, 'src/skip.ts'),
      ...lenField(
        2,
        encodeOccurrence(
          'scip-ts . . `skip.ts`/foo().',
          [0, 9, 0, 12],
          SCIP_SYMBOL_ROLE_DEFINITION,
        ),
      ),
      ...lenField(3, symbolInfoPayload), // skipped SymbolInformation — the drift trigger
      ...lenField(2, encodeOccurrence('scip-ts . . `skip.ts`/foo().', [3, 4, 3, 7], 0)),
      ...stringField(4, 'TypeScript'),
    ];
    const index = decodeScipIndex(encodeIndex([doc]));

    expect(index.documents).toHaveLength(1);
    const d = index.documents[0];
    expect(d.relativePath).toBe('src/skip.ts');
    expect(d.language).toBe('TypeScript');
    expect(d.occurrences).toHaveLength(2);
    expect(d.occurrences[0].isDefinition).toBe(true);
    expect(d.occurrences[1].range.startLine).toBe(3);
  });
});
