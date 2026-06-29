/**
 * Integration coverage for SCIP ingestion.
 *
 * Builds a tiny store with two symbols (caller `foo`, callee `bar`), encodes a
 * minimal SCIP index where:
 *   - `bar` has a Definition occurrence on its own line
 *   - inside `foo`'s body there is a reference occurrence pointing at `bar`'s
 *     SCIP symbol
 * then ingests and asserts that:
 *   - a NEW edge foo→bar is created with resolution_tier='scip_resolved'
 *   - an EXISTING text_matched foo→bar edge is UPGRADED to 'scip_resolved'
 */

import { describe, expect, it } from 'vitest';
import { createTestStore } from '../test-utils.js';
import { ingestScipIndex } from '../../src/scip/ingest.js';
import type { ScipIndex } from '../../src/scip/protocol.js';
import { SCIP_SYMBOL_ROLE_DEFINITION } from '../../src/scip/protocol.js';

const BAR_SYMBOL = 'scip-ts npm . . `mod.ts`/bar().';

/**
 * Two symbols in one file:
 *   foo: lines 1-4 (caller)
 *   bar: lines 6-8 (callee)
 * `bar` is defined on line 6 (0-based line 5); `foo` references it on line 2
 * (0-based line 1).
 */
function buildStore() {
  const store = createTestStore();
  const fileId = store.insertFile('src/mod.ts', 'typescript', 'h', 200);
  const fooId = store.insertSymbol(fileId, {
    symbolId: 'src/mod.ts::foo#function',
    name: 'foo',
    kind: 'function',
    fqn: 'foo',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 4,
  });
  const barId = store.insertSymbol(fileId, {
    symbolId: 'src/mod.ts::bar#function',
    name: 'bar',
    kind: 'function',
    fqn: 'bar',
    byteStart: 60,
    byteEnd: 110,
    lineStart: 6,
    lineEnd: 8,
  });
  const fooNode = store.getNodeId('symbol', fooId);
  const barNode = store.getNodeId('symbol', barId);
  return { store, fileId, fooId, barId, fooNode: fooNode!, barNode: barNode! };
}

function scipIndexFor(): ScipIndex {
  return {
    documents: [
      {
        relativePath: 'src/mod.ts',
        language: 'TypeScript',
        occurrences: [
          // Definition of bar on line 6 (0-based 5)
          {
            symbol: BAR_SYMBOL,
            range: { startLine: 5, startCharacter: 9, endLine: 5, endCharacter: 12 },
            symbolRoles: SCIP_SYMBOL_ROLE_DEFINITION,
            isDefinition: true,
          },
          // Reference to bar inside foo's body on line 2 (0-based 1)
          {
            symbol: BAR_SYMBOL,
            range: { startLine: 1, startCharacter: 2, endLine: 1, endCharacter: 5 },
            symbolRoles: 0,
            isDefinition: false,
          },
        ],
      },
    ],
  };
}

describe('ingestScipIndex', () => {
  it('inserts a new scip_resolved edge from caller to callee', () => {
    const { store, fooNode, barNode } = buildStore();

    const result = ingestScipIndex(store, scipIndexFor());

    expect(result.definitionsMapped).toBe(1);
    expect(result.edgesAdded).toBe(1);
    expect(result.edgesUpgraded).toBe(0);

    const edge = store.db
      .prepare(
        `SELECT resolution_tier, confidence FROM edges
         WHERE source_node_id = ? AND target_node_id = ?`,
      )
      .get(fooNode, barNode) as { resolution_tier: string; confidence: number } | undefined;

    expect(edge).toBeDefined();
    expect(edge?.resolution_tier).toBe('scip_resolved');
    // Trigger seeds confidence 1.0 for scip_resolved.
    expect(edge?.confidence).toBe(1.0);
  });

  it('upgrades an existing lower-tier edge to scip_resolved', () => {
    const { store, fooNode, barNode } = buildStore();

    // Pre-existing weak edge foo→bar.
    const inserted = store.insertEdge(
      fooNode,
      barNode,
      'calls',
      true,
      undefined,
      false,
      'text_matched',
    );
    expect(inserted.isOk()).toBe(true);

    const result = ingestScipIndex(store, scipIndexFor());

    expect(result.edgesUpgraded).toBe(1);
    expect(result.edgesAdded).toBe(0);

    const edge = store.db
      .prepare(
        `SELECT resolution_tier FROM edges
         WHERE source_node_id = ? AND target_node_id = ?`,
      )
      .get(fooNode, barNode) as { resolution_tier: string } | undefined;

    expect(edge?.resolution_tier).toBe('scip_resolved');
  });

  it('skips references whose definition is not in the index', () => {
    const { store } = buildStore();

    const orphan: ScipIndex = {
      documents: [
        {
          relativePath: 'src/mod.ts',
          language: 'TypeScript',
          occurrences: [
            {
              symbol: 'scip-ts npm . . `other.ts`/unknown().',
              range: { startLine: 1, startCharacter: 2, endLine: 1, endCharacter: 9 },
              symbolRoles: 0,
              isDefinition: false,
            },
          ],
        },
      ],
    };

    const result = ingestScipIndex(store, orphan);
    expect(result.edgesAdded).toBe(0);
    expect(result.edgesUpgraded).toBe(0);
    expect(result.unresolvedReferences).toBe(1);
  });

  it('ignores documents for files not in the trace-mcp index', () => {
    const { store } = buildStore();
    const index: ScipIndex = {
      documents: [
        {
          relativePath: 'src/not-indexed.ts',
          language: 'TypeScript',
          occurrences: [
            {
              symbol: BAR_SYMBOL,
              range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 3 },
              symbolRoles: SCIP_SYMBOL_ROLE_DEFINITION,
              isDefinition: true,
            },
          ],
        },
      ],
    };
    const result = ingestScipIndex(store, index);
    // The document maps to no indexed file, so it is skipped entirely: no
    // definitions mapped and it is not counted as processed.
    expect(result.definitionsMapped).toBe(0);
    expect(result.documentsProcessed).toBe(0);
    expect(result.edgesAdded).toBe(0);
  });
});
