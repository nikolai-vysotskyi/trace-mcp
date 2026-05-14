/**
 * Behavioural coverage for `getCommunities()` — the read-only sibling of
 * `detectCommunities()`. We seed the `communities` and `community_members`
 * tables directly (the same schema `detectCommunities` writes to) and assert
 * the read contract:
 *   - empty graph: `{ communities: [], totalFiles: 0, resolution, seed }`
 *   - rows are returned ordered by file_count DESC (largest community first)
 *   - each community has id, label, fileCount, cohesion, internalEdges,
 *     externalEdges, keyFiles
 *   - totalFiles equals the sum of every community's fileCount
 *   - keyFiles is capped at 5 (LIMIT 5 in the query)
 *   - getCommunityDetail returns full file list + dependsOn/dependedBy
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getCommunities } from '../../../src/tools/analysis/communities.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
}

function insertCommunity(
  store: Store,
  opts: {
    id: number;
    label: string;
    files: string[];
    cohesion?: number;
    internalEdges?: number;
    externalEdges?: number;
  },
): void {
  store.db
    .prepare(
      'INSERT INTO communities (id, label, file_count, cohesion, internal_edges, external_edges) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      opts.id,
      opts.label,
      opts.files.length,
      opts.cohesion ?? 0.8,
      opts.internalEdges ?? 5,
      opts.externalEdges ?? 1,
    );
  const insertMember = store.db.prepare(
    'INSERT INTO community_members (community_id, file_path) VALUES (?, ?)',
  );
  for (const f of opts.files) insertMember.run(opts.id, f);
}

function seedTwoCommunities(): Fixture {
  const store = createTestStore();

  // Larger community: 7 files (so we can verify the 5-file keyFiles cap).
  insertCommunity(store, {
    id: 1,
    label: 'core',
    files: [
      'src/core/a.ts',
      'src/core/b.ts',
      'src/core/c.ts',
      'src/core/d.ts',
      'src/core/e.ts',
      'src/core/f.ts',
      'src/core/g.ts',
    ],
    cohesion: 0.92,
    internalEdges: 20,
    externalEdges: 2,
  });

  // Smaller community: 3 files.
  insertCommunity(store, {
    id: 2,
    label: 'cli',
    files: ['src/cli/x.ts', 'src/cli/y.ts', 'src/cli/z.ts'],
    cohesion: 0.7,
    internalEdges: 6,
    externalEdges: 3,
  });

  return { store };
}

describe('getCommunities() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seedTwoCommunities();
  });

  it('returns an empty envelope when no communities exist (no detect run)', () => {
    const empty = createTestStore();
    const result = getCommunities(empty);
    expect(result.isOk()).toBe(true);
    const payload = result._unsafeUnwrap();
    expect(payload.communities).toEqual([]);
    expect(payload.totalFiles).toBe(0);
    expect(typeof payload.resolution).toBe('number');
    expect(typeof payload.seed).toBe('number');
  });

  it('returns rows ordered by file_count DESC (largest community first)', () => {
    const result = getCommunities(ctx.store);
    expect(result.isOk()).toBe(true);
    const payload = result._unsafeUnwrap();
    expect(payload.communities.length).toBe(2);
    expect(payload.communities[0].id).toBe(1);
    expect(payload.communities[0].fileCount).toBe(7);
    expect(payload.communities[1].id).toBe(2);
    expect(payload.communities[1].fileCount).toBe(3);
    // Descending order invariant.
    for (let i = 1; i < payload.communities.length; i++) {
      expect(payload.communities[i - 1].fileCount).toBeGreaterThanOrEqual(
        payload.communities[i].fileCount,
      );
    }
  });

  it('each community row carries id, label, fileCount, cohesion, internal/externalEdges, keyFiles', () => {
    const result = getCommunities(ctx.store);
    const communities = result._unsafeUnwrap().communities;
    for (const c of communities) {
      expect(typeof c.id).toBe('number');
      expect(typeof c.label).toBe('string');
      expect(typeof c.fileCount).toBe('number');
      expect(typeof c.cohesion).toBe('number');
      expect(typeof c.internalEdges).toBe('number');
      expect(typeof c.externalEdges).toBe('number');
      expect(Array.isArray(c.keyFiles)).toBe(true);
    }

    const core = communities.find((c) => c.id === 1)!;
    expect(core.label).toBe('core');
    expect(core.cohesion).toBeCloseTo(0.92);
    expect(core.internalEdges).toBe(20);
    expect(core.externalEdges).toBe(2);
  });

  it('keyFiles is capped at 5 entries even when the community has more', () => {
    const result = getCommunities(ctx.store);
    const core = result._unsafeUnwrap().communities.find((c) => c.id === 1)!;
    // We seeded 7 files into community 1; the query uses LIMIT 5.
    expect(core.fileCount).toBe(7);
    expect(core.keyFiles.length).toBe(5);
    // All keyFiles must be real members of the community.
    for (const f of core.keyFiles) {
      expect(f.startsWith('src/core/')).toBe(true);
    }
  });

  it('totalFiles is the sum of every community fileCount', () => {
    const result = getCommunities(ctx.store);
    const payload = result._unsafeUnwrap();
    const sum = payload.communities.reduce((acc, c) => acc + c.fileCount, 0);
    expect(payload.totalFiles).toBe(sum);
    expect(payload.totalFiles).toBe(7 + 3);
  });
});
