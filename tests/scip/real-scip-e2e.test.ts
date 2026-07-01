/**
 * End-to-end regression against a REAL `.scip` file produced by
 * `@sourcegraph/scip-typescript@0.4.0` — NOT synthetic protobuf bytes.
 *
 * Provenance of tests/scip/fixtures/real-scip-typescript-0.4.0.scip:
 *   Two-file TypeScript project indexed with `scip-typescript index`:
 *     src/bar.ts:  export function bar(x: number): number { return x * 2; }
 *     src/foo.ts:  import { bar } from './bar.js';
 *                  export function foo(n: number): number {
 *                    const doubled = bar(n);   // cross-file reference to bar()
 *                    return doubled + 1;
 *                  }
 *
 * Why this exists: the hand-rolled protobuf decoder (src/scip/protocol.ts) was
 * originally only exercised via a synthetic protobuf writer in the sibling unit
 * test. That writer happened to encode the same way the decoder read, so the
 * round-trip was self-consistent but WRONG vs. real indexer output. Running the
 * real bytes surfaced two fatal decoder bugs (both now fixed):
 *
 *   1. `skipField` LEN case did `this.pos += this.readVarint()`, whose JS
 *      evaluation order captured the pre-call `this.pos`, landing 1 byte short
 *      after skipping any LEN field (e.g. Document.symbols) — corrupting every
 *      subsequent field and crashing with "Unsupported protobuf wire type: 7".
 *
 *   2. Occurrence `range` (a proto3 `repeated int32`) was decoded with zig-zag
 *      (`readSignedVarint`) instead of plain varint. int32 is NOT zig-zag in
 *      proto3 (only sint32/sint64 are), so every range decoded to garbage
 *      negative lines/chars — no reference occurrence ever mapped to a symbol,
 *      so the subsystem produced ZERO scip_resolved edges on real input.
 *
 * If either bug regresses, these assertions fail.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestStore } from '../test-utils.js';
import { decodeScipIndex } from '../../src/scip/protocol.js';
import { ingestScipIndex } from '../../src/scip/ingest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'real-scip-typescript-0.4.0.scip');

function loadRealIndex() {
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  return decodeScipIndex(bytes);
}

describe('SCIP decoder — real scip-typescript output', () => {
  it('decodes the real .scip without throwing (skipField off-by-one regression)', () => {
    expect(() => loadRealIndex()).not.toThrow();
    const index = loadRealIndex();
    // Two documents: src/bar.ts and src/foo.ts.
    const paths = index.documents.map((d) => d.relativePath).sort();
    expect(paths).toEqual(['src/bar.ts', 'src/foo.ts']);
  });

  it('decodes occurrence ranges as non-negative 0-based ints (int32-not-zigzag regression)', () => {
    const index = loadRealIndex();
    for (const doc of index.documents) {
      for (const occ of doc.occurrences) {
        // SCIP spec: line/character are always 0-based and non-negative.
        expect(occ.range.startLine).toBeGreaterThanOrEqual(0);
        expect(occ.range.startCharacter).toBeGreaterThanOrEqual(0);
        expect(occ.range.endLine).toBeGreaterThanOrEqual(0);
        expect(occ.range.endCharacter).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('locates the cross-file bar() definition and reference at the right lines', () => {
    const index = loadRealIndex();
    const barDoc = index.documents.find((d) => d.relativePath === 'src/bar.ts')!;
    const fooDoc = index.documents.find((d) => d.relativePath === 'src/foo.ts')!;

    // bar() is defined on line 1 (1-based) → 0-based line 0.
    const barDef = barDoc.occurrences.find((o) => o.isDefinition && o.symbol.endsWith('bar().'));
    expect(barDef).toBeDefined();
    expect(barDef!.range.startLine).toBe(0);

    // foo.ts references bar() TWICE: the `import { bar }` binding (line 1,
    // 0-based 0) and the `bar(n)` call site (line 4, 0-based 3). Both are
    // legitimate SCIP reference occurrences to the same symbol.
    const barRefs = fooDoc.occurrences.filter(
      (o) => !o.isDefinition && o.symbol === barDef!.symbol,
    );
    expect(barRefs).toHaveLength(2);
    const refLines = barRefs.map((o) => o.range.startLine).sort((a, b) => a - b);
    expect(refLines).toEqual([0, 3]); // import binding, then the call site

    // The call-site reference specifically (0-based line 3) is what the
    // ingestion pipeline must resolve into a scip_resolved foo→bar edge.
    const callSiteRef = barRefs.find((o) => o.range.startLine === 3);
    expect(callSiteRef).toBeDefined();
  });

  it('ingests the real index and produces a scip_resolved foo→bar edge', () => {
    const index = loadRealIndex();
    const store = createTestStore();

    // Store mirrors the fixture's real 1-based line ranges.
    const barFile = store.insertFile('src/bar.ts', 'typescript', 'hb', 100);
    const barId = store.insertSymbol(barFile, {
      symbolId: 'src/bar.ts::bar#function',
      name: 'bar',
      kind: 'function',
      fqn: 'bar',
      byteStart: 0,
      byteEnd: 50,
      lineStart: 1,
      lineEnd: 3,
    });
    const fooFile = store.insertFile('src/foo.ts', 'typescript', 'hf', 120);
    const fooId = store.insertSymbol(fooFile, {
      symbolId: 'src/foo.ts::foo#function',
      name: 'foo',
      kind: 'function',
      fqn: 'foo',
      byteStart: 0,
      byteEnd: 90,
      lineStart: 3,
      lineEnd: 6,
    });

    const fooNode = store.getNodeId('symbol', fooId)!;
    const barNode = store.getNodeId('symbol', barId)!;

    const result = ingestScipIndex(store, index);

    // The cross-file reference must resolve into exactly one new scip edge.
    expect(result.edgesAdded).toBeGreaterThanOrEqual(1);
    expect(result.definitionsMapped).toBeGreaterThan(0);

    const scipEdges = store
      .getEdgesByType('references')
      .filter((e) => e.resolution_tier === 'scip_resolved');
    const fooToBar = scipEdges.find(
      (e) => e.source_node_id === fooNode && e.target_node_id === barNode,
    );
    expect(fooToBar, 'expected a scip_resolved foo→bar reference edge').toBeDefined();
  });
});
