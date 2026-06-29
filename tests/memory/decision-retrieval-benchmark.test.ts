/**
 * Tracked decision-retrieval benchmark (Task 9).
 *
 * Runs a LongMemEval / LoCoMo-style recall@k + MRR evaluation over a fixed
 * decision corpus. Two configurations:
 *   1. FTS5-only (zero-dependency fallback) — must clear a recall floor.
 *   2. Hybrid (deterministic bag-of-words embeddings) — must not regress
 *      below the FTS5 baseline on aggregate.
 *
 * The floors are intentionally conservative; the point is to *catch
 * regressions*, not to overfit. If a ranking change legitimately moves the
 * numbers, update the asserted floors here in the same commit so the change is
 * visible in review.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingService } from '../../src/ai/interfaces.js';
import { hybridRankDecisions } from '../../src/memory/decision-hybrid.js';
import { DecisionStore } from '../../src/memory/decision-store.js';
import {
  PROJECT_ROOT,
  QUERIES,
  type BenchQuery,
  evaluate,
  seedCorpus,
} from './fixtures/decision-retrieval-corpus.js';

/** Deterministic bag-of-words embedding over a topical vocabulary. */
const VOCAB = [
  'password',
  'hash',
  'argon2',
  'bcrypt',
  'login',
  'latency',
  'redis',
  'session',
  'cache',
  'invalidation',
  'graphql',
  'rest',
  'api',
  'version',
  'node',
  'lts',
  'runtime',
  'bundler',
  'tsup',
  'build',
  'money',
  'currency',
  'rounding',
  'uuid',
  'key',
  'rate',
  'limit',
  'brute',
  'cdn',
  'static',
  'asset',
  'json',
  'logging',
  'migration',
  'deploy',
  'encrypt',
  'pii',
  'composition',
  'inheritance',
  'plugin',
];
function bagEmbed(text: string): number[] {
  const lower = text.toLowerCase();
  return VOCAB.map((w) => (lower.match(new RegExp(w, 'g')) ?? []).length);
}
const fakeEmbeddings: EmbeddingService = {
  async embed(text) {
    return bagEmbed(text);
  },
  async embedBatch(texts) {
    return texts.map(bagEmbed);
  },
  dimensions() {
    return VOCAB.length;
  },
  modelName() {
    return 'bench-bow';
  },
};

describe('decision retrieval benchmark', () => {
  let store: DecisionStore;
  let dbPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-bench-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
    seedCorpus(store);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  /** FTS5-only ranker: feed the query through queryDecisions search. */
  function ftsRank(q: BenchQuery): number[] {
    // OR the terms so FTS5 matches on any token (mirrors how the tool builds
    // its MATCH when the caller passes a free-text query).
    const orQuery = q.query.split(/\s+/).filter(Boolean).join(' OR ');
    return store
      .queryDecisions({ project_root: PROJECT_ROOT, search: orQuery, limit: 50 })
      .map((d) => d.id);
  }

  it('FTS5-only clears the recall floor', () => {
    const summary = evaluate(ftsRank);
    // Conservative floors — catch regressions, not overfit. Measured baseline
    // on this corpus: recall@3≈0.97, recall@5≈0.97, MRR≈0.78.
    expect(summary.recallAt5).toBeGreaterThanOrEqual(0.85);
    expect(summary.recallAt3).toBeGreaterThanOrEqual(0.7);
    expect(summary.mrr).toBeGreaterThanOrEqual(0.6);
    // Sanity: full query set evaluated.
    expect(summary.queries).toBe(16);
  });

  it('hybrid (embeddings) does not regress below the FTS5 baseline', async () => {
    const ftsSummary = evaluate(ftsRank);

    // Precompute hybrid rankings (async) into a map, then evaluate synchronously.
    const hybridRanks = new Map<string, number[]>();
    for (const q of QUERIES) {
      const pool = store.queryDecisions({
        project_root: PROJECT_ROOT,
        search: q.query.split(/\s+/).filter(Boolean).join(' OR '),
        limit: 50,
      });
      const ranked = await hybridRankDecisions({
        query: q.query,
        pool,
        embeddingService: fakeEmbeddings,
        limit: 50,
        weights: { lexical: 0.5, similarity: 0.5 },
      });
      hybridRanks.set(
        q.query,
        ranked.map((d) => d.id),
      );
    }
    const hybridSummary = evaluate((q) => hybridRanks.get(q.query) ?? []);

    // Aggregate recall@5 must not drop relative to FTS5 (fusion only reorders
    // within the same pool, so recall@5 is at worst equal).
    expect(hybridSummary.recallAt5).toBeGreaterThanOrEqual(ftsSummary.recallAt5);
    // MRR should be at least as good — embeddings lift the best match.
    expect(hybridSummary.mrr).toBeGreaterThanOrEqual(ftsSummary.mrr - 1e-9);
  });
});
