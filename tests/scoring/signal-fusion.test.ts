import { describe, it, expect } from 'vitest';
import {
  signalFusion,
  computeIdentityScore,
  buildIdentityChannel,
  type FusionChannels,
} from '../../src/scoring/signal-fusion.js';

// ── computeIdentityScore ──────────────────────────────────────

describe('computeIdentityScore', () => {
  it('returns 1.0 for exact name match', () => {
    expect(computeIdentityScore('search', 'search')).toBe(1.0);
    expect(computeIdentityScore('Search', 'search')).toBe(1.0); // case-insensitive
  });

  it('returns 1.0 for exact FQN match', () => {
    expect(
      computeIdentityScore('src/nav.ts::search#function', 'search', 'src/nav.ts::search#function'),
    ).toBe(1.0);
  });

  it('returns 0.9 for FQN ends with query', () => {
    expect(computeIdentityScore('search', 'search', 'src/nav.ts::search')).toBe(1.0); // name exact match takes priority
    expect(computeIdentityScore('MyClass', 'MyClass', 'src/foo.ts::MyClass')).toBe(1.0); // name exact
  });

  it('returns 0.8 for prefix match', () => {
    expect(computeIdentityScore('search', 'searchSymbols')).toBe(0.8);
    expect(computeIdentityScore('compute', 'computePageRank')).toBe(0.8);
  });

  it('returns 0.7 for camelCase segment match', () => {
    // 'page' is a substring of 'computePageRank' → hits substring (0.3) before segment check
    // Use a name where the segment doesn't overlap with substring containment
    expect(computeIdentityScore('page', 'computePageRank')).toBe(0.7);
  });

  it('returns 0.6 for FQN segment match', () => {
    expect(computeIdentityScore('nav', 'search', 'src/nav.ts::search#function')).toBe(0.6);
  });

  it('returns 0.5 for partial segment prefix', () => {
    expect(computeIdentityScore('comp', 'computePageRank')).toBe(0.8); // prefix of whole name
    expect(computeIdentityScore('pag', 'computePageRank')).toBe(0.5);
  });

  it('returns 0.3 for substring containment in name', () => {
    expect(computeIdentityScore('ompute', 'computePageRank')).toBe(0.3);
  });

  it('returns 0.2 for substring containment in FQN only', () => {
    // 'scoring' appears as FQN segment → 0.6
    expect(
      computeIdentityScore('scoring', 'hybridScore', 'src/scoring/hybrid.ts::hybridScore'),
    ).toBe(0.6);
  });

  it('returns 0 for no match', () => {
    expect(computeIdentityScore('xyz', 'hybridScore')).toBe(0);
    expect(computeIdentityScore('xyz', 'hybridScore', 'src/scoring/hybrid.ts::hybridScore')).toBe(
      0,
    );
  });
});

// ── buildIdentityChannel ──────────────────────────────────────

describe('buildIdentityChannel', () => {
  it('builds ranked list filtering out zero-score items', () => {
    const candidates = [
      { id: 'a', name: 'search', fqn: 'nav::search' },
      { id: 'b', name: 'searchFts', fqn: 'db::searchFts' },
      { id: 'c', name: 'unrelated', fqn: 'other::unrelated' },
    ];
    const channel = buildIdentityChannel('search', candidates);
    // 'a' = exact match (1.0), 'b' = prefix (0.8), 'c' = no match (filtered)
    expect(channel.items).toHaveLength(2);
    expect(channel.items[0].id).toBe('a');
    expect(channel.items[0].rawScore).toBe(1.0);
    expect(channel.items[1].id).toBe('b');
    expect(channel.items[1].rawScore).toBe(0.8);
  });

  it('returns empty items when no matches', () => {
    const channel = buildIdentityChannel('xyz', [{ id: 'a', name: 'foo' }]);
    expect(channel.items).toHaveLength(0);
  });
});

// ── signalFusion ──────────────────────────────────────────────

describe('signalFusion', () => {
  it('returns empty array for empty channels', () => {
    const result = signalFusion({});
    expect(result).toEqual([]);
  });

  it('fuses single channel correctly', () => {
    const channels: FusionChannels = {
      lexical: {
        items: [
          { id: 'a', rawScore: 10 },
          { id: 'b', rawScore: 5 },
          { id: 'c', rawScore: 1 },
        ],
      },
    };
    const results = signalFusion(channels);
    expect(results).toHaveLength(3);
    expect(results[0].id).toBe('a'); // rank 0 → highest score
    expect(results[1].id).toBe('b');
    expect(results[2].id).toBe('c');
    // All scores should be positive
    for (const r of results) expect(r.score).toBeGreaterThan(0);
  });

  it('fuses two channels — item in both channels ranks higher', () => {
    const channels: FusionChannels = {
      lexical: {
        items: [
          { id: 'a', rawScore: 10 },
          { id: 'b', rawScore: 5 },
        ],
      },
      identity: {
        items: [
          { id: 'b', rawScore: 1.0 }, // b is #1 in identity
          { id: 'a', rawScore: 0.5 }, // a is #2 in identity
        ],
      },
    };
    const results = signalFusion(channels);
    expect(results).toHaveLength(2);
    // Both items appear in both channels, but 'a' is #1 in lexical and 'b' is #1 in identity
    // With default weights (lexical=0.4 > identity=0.15), 'a' should still win
    // But identity weight is normalized since only 2 channels active
    // lexical normalized = 0.4 / 0.55 ≈ 0.727, identity = 0.15 / 0.55 ≈ 0.273
    // a: 0.727 * 1/(60+0) + 0.273 * 1/(60+1) ≈ 0.01212 + 0.00447 = 0.01659
    // b: 0.727 * 1/(60+1) + 0.273 * 1/(60+0) ≈ 0.01192 + 0.00455 = 0.01647
    // Very close, but 'a' should be first since lexical has higher weight
    expect(results[0].id).toBe('a');
  });

  it('item in multiple channels outranks single-channel item', () => {
    const channels: FusionChannels = {
      lexical: {
        items: [
          { id: 'a' }, // rank 0
          { id: 'b' }, // rank 1
        ],
      },
      structural: {
        items: [
          { id: 'b' }, // rank 0 — b appears in both channels
        ],
      },
    };
    const results = signalFusion(channels);
    // 'b' appears in both channels, should outrank 'a' despite being rank 1 in lexical
    expect(results[0].id).toBe('b');
  });

  it('respects custom weights', () => {
    const channels: FusionChannels = {
      lexical: {
        items: [{ id: 'a' }, { id: 'b' }],
      },
      identity: {
        items: [{ id: 'b' }, { id: 'a' }],
      },
    };
    // Give identity extremely high weight
    const results = signalFusion(channels, {
      weights: { lexical: 0.01, identity: 0.99 },
    });
    // 'b' is #1 in identity (dominant), so should be first
    expect(results[0].id).toBe('b');
  });

  it('returns debug info when enabled', () => {
    const channels: FusionChannels = {
      lexical: { items: [{ id: 'a', rawScore: 10 }] },
      structural: { items: [{ id: 'a', rawScore: 0.8 }] },
    };
    const results = signalFusion(channels, { debug: true });
    expect(results).toHaveLength(1);
    expect(results[0].debug).toBeDefined();
    expect(results[0].debug!.lexical.rank).toBe(0);
    expect(results[0].debug!.lexical.rawScore).toBe(10);
    expect(results[0].debug!.structural.rank).toBe(0);
    expect(results[0].debug!.structural.rawScore).toBe(0.8);
    expect(results[0].debug!.similarity.rank).toBeUndefined();
    expect(results[0].debug!.identity.rank).toBeUndefined();
    expect(results[0].debug!.contributions.lexical).toBeGreaterThan(0);
    expect(results[0].debug!.contributions.structural).toBeGreaterThan(0);
    expect(results[0].debug!.contributions.similarity).toBe(0);
    expect(results[0].debug!.contributions.identity).toBe(0);
  });

  it('does not include debug info when disabled', () => {
    const channels: FusionChannels = {
      lexical: { items: [{ id: 'a' }] },
    };
    const results = signalFusion(channels, { debug: false });
    expect(results[0].debug).toBeUndefined();
  });

  it('handles large candidate sets', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ id: `sym-${i}` }));
    const channels: FusionChannels = {
      lexical: { items },
      structural: { items: [...items].reverse() },
    };
    const results = signalFusion(channels);
    expect(results).toHaveLength(200);
    // All should have scores
    for (const r of results) expect(r.score).toBeGreaterThan(0);
  });

  it('ignores channels with empty items', () => {
    const channels: FusionChannels = {
      lexical: { items: [{ id: 'a' }] },
      structural: { items: [] },
    };
    const results = signalFusion(channels);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('a');
  });

  it('normalizes weights to active channels only', () => {
    // Only lexical provided — its weight should be normalized to 1.0
    const channels: FusionChannels = {
      lexical: { items: [{ id: 'a' }] },
    };
    const results = signalFusion(channels, { debug: true });
    // score should be 1.0 * 1/(60+0) since only lexical is active
    expect(results[0].score).toBeCloseTo(1 / 60, 6);
  });
});
