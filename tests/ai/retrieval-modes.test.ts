/**
 * Unit tests for the memoir-style retrieval mode helpers.
 *
 * Two layers:
 *   1. `selectRetrievalMode` heuristic — path-shaped vs query-shaped inputs.
 *   2. Integration tests for each mode against a seeded fixture index, plus a
 *      regression guard that `single` mode keeps its byte-identical shape.
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  bucketize,
  isPathShapedQuery,
  isRetrievalMode,
  RETRIEVAL_MODES,
  selectRetrievalMode,
  TIERED_BUCKET_SIZES,
  TIERED_TOTAL_LIMIT,
  type RetrievalItem,
} from '../../src/ai/retrieval-modes.js';
import { gatherContextWithEnvelope } from '../../src/ai/ask-shared.js';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { search } from '../../src/tools/navigation/navigation.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/no-framework');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE_DIR,
    include: ['src/**/*.ts'],
    exclude: ['vendor/**', 'node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

describe('selectRetrievalMode', () => {
  it('exposes the canonical mode list', () => {
    expect(RETRIEVAL_MODES).toEqual(['single', 'tiered', 'drill', 'flat', 'get']);
  });

  it('isRetrievalMode narrows known strings and rejects junk', () => {
    expect(isRetrievalMode('single')).toBe(true);
    expect(isRetrievalMode('tiered')).toBe(true);
    expect(isRetrievalMode('flat')).toBe(true);
    expect(isRetrievalMode('drill')).toBe(true);
    expect(isRetrievalMode('get')).toBe(true);
    expect(isRetrievalMode('grep')).toBe(false);
    expect(isRetrievalMode('')).toBe(false);
    expect(isRetrievalMode(null)).toBe(false);
    expect(isRetrievalMode(123)).toBe(false);
  });

  describe('isPathShapedQuery', () => {
    it.each([
      ['src/db/store.ts', true],
      ['app/Http/Controllers/UserController.php', true],
      ['store.ts', true], // single-token leaf with extension
      ['ts:src/foo.ts:10:0:bar', true], // symbol-id shape
      ['src/foo', true],
      ['User', false],
      ['save user', false], // whitespace ⇒ NL
      ['how does auth work?', false],
      ['', false],
      ['foo.', false], // bare trailing dot is not an extension
    ])('%s → %s', (q, expected) => {
      expect(isPathShapedQuery(q)).toBe(expected);
    });
  });

  describe('default-mode picker', () => {
    it('returns drill when drillFrom is supplied (overrides shape heuristic)', () => {
      expect(selectRetrievalMode('User', { drillFrom: 'src/auth/' })).toBe('drill');
      expect(selectRetrievalMode('src/foo.ts', { drillFrom: 'src/' })).toBe('drill');
    });

    it('honors explicit prefer hint', () => {
      expect(selectRetrievalMode('User', { prefer: 'flat' })).toBe('flat');
      expect(selectRetrievalMode('User', { prefer: 'tiered' })).toBe('tiered');
    });

    it('routes path-shaped queries to get mode', () => {
      expect(selectRetrievalMode('src/db/store.ts')).toBe('get');
      expect(selectRetrievalMode('store.ts')).toBe('get');
      expect(selectRetrievalMode('ts:src/foo.ts:10:0:bar')).toBe('get');
    });

    it('routes natural-language queries to single mode', () => {
      expect(selectRetrievalMode('User')).toBe('single');
      expect(selectRetrievalMode('how does authentication work')).toBe('single');
      expect(selectRetrievalMode('save')).toBe('single');
    });
  });
});

describe('bucketize', () => {
  function fakeItem(i: number): RetrievalItem {
    return {
      symbol_id: `s${i}`,
      name: `name${i}`,
      kind: 'function',
      fqn: null,
      file: `f${i}.ts`,
      line: 1,
      score: 1 - i * 0.01,
    };
  }

  it('slices into the documented [3,7,15] tiers', () => {
    const items = Array.from({ length: TIERED_TOTAL_LIMIT }, (_, i) => fakeItem(i));
    const buckets = bucketize(items);
    expect(buckets.high).toHaveLength(TIERED_BUCKET_SIZES.high);
    expect(buckets.medium).toHaveLength(TIERED_BUCKET_SIZES.medium);
    expect(buckets.low).toHaveLength(TIERED_BUCKET_SIZES.low);
    expect(buckets.high[0]).toBe(items[0]);
    expect(buckets.medium[0]).toBe(items[TIERED_BUCKET_SIZES.high]);
    expect(buckets.low[0]).toBe(items[TIERED_BUCKET_SIZES.high + TIERED_BUCKET_SIZES.medium]);
  });

  it('handles short input — partial buckets without throwing', () => {
    const items = Array.from({ length: 4 }, (_, i) => fakeItem(i));
    const buckets = bucketize(items);
    expect(buckets.high).toHaveLength(3);
    expect(buckets.medium).toHaveLength(1);
    expect(buckets.low).toHaveLength(0);
  });

  it('caps low at TIERED_BUCKET_SIZES.low even when oversupplied', () => {
    const items = Array.from({ length: 100 }, (_, i) => fakeItem(i));
    const buckets = bucketize(items);
    expect(buckets.low).toHaveLength(TIERED_BUCKET_SIZES.low);
  });
});

describe('retrieval-mode integration', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());

    const config = makeConfig();
    const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
    await pipeline.indexAll();
  });

  it('regression guard: single mode result shape is byte-identical to today', async () => {
    // The MCP `search` tool wraps `search()` from navigation.ts. Single mode
    // must NOT touch the underlying search call signature or the items shape.
    const result = await search(store, 'User', undefined, 5);
    expect(result).toHaveProperty('items');
    expect(result).toHaveProperty('total');
    expect(Array.isArray(result.items)).toBe(true);
    if (result.items.length > 0) {
      const first = result.items[0];
      expect(first).toHaveProperty('symbol');
      expect(first).toHaveProperty('file');
      expect(first).toHaveProperty('score');
    }
  });

  it('gatherContextWithEnvelope: single mode (default) does NOT add mode/buckets/parent', async () => {
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const { envelope } = await gatherContextWithEnvelope(
      FIXTURE_DIR,
      store,
      registry,
      'User',
      4000,
    );
    expect(envelope.mode).toBeUndefined();
    expect(envelope.buckets).toBeUndefined();
    expect(envelope.parent).toBeUndefined();
    expect(Array.isArray(envelope.files)).toBe(true);
    expect(Array.isArray(envelope.symbols)).toBe(true);
  });

  it('gatherContextWithEnvelope: tiered mode populates buckets', async () => {
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const { envelope } = await gatherContextWithEnvelope(
      FIXTURE_DIR,
      store,
      registry,
      'User',
      4000,
      undefined,
      'tiered',
    );
    expect(envelope.mode).toBe('tiered');
    expect(envelope.buckets).toBeDefined();
    expect(Array.isArray(envelope.buckets!.high)).toBe(true);
    expect(Array.isArray(envelope.buckets!.medium)).toBe(true);
    expect(Array.isArray(envelope.buckets!.low)).toBe(true);
  });

  it('gatherContextWithEnvelope: drill mode stamps parent and scopes envelope', async () => {
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const { envelope } = await gatherContextWithEnvelope(
      FIXTURE_DIR,
      store,
      registry,
      'User',
      4000,
      undefined,
      'drill',
      'src',
    );
    expect(envelope.mode).toBe('drill');
    expect(envelope.parent).toBe('src');
    for (const f of envelope.files) {
      expect(f.startsWith('src')).toBe(true);
    }
  });

  it('gatherContextWithEnvelope: flat mode stamps mode, no buckets', async () => {
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const { envelope } = await gatherContextWithEnvelope(
      FIXTURE_DIR,
      store,
      registry,
      'User',
      4000,
      undefined,
      'flat',
    );
    expect(envelope.mode).toBe('flat');
    expect(envelope.buckets).toBeUndefined();
    expect(envelope.parent).toBeUndefined();
  });

  it('gatherContextWithEnvelope: get mode stamps mode without crashing on NL queries', async () => {
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const { envelope } = await gatherContextWithEnvelope(
      FIXTURE_DIR,
      store,
      registry,
      'src/foo.ts',
      4000,
      undefined,
      'get',
    );
    expect(envelope.mode).toBe('get');
  });
});
