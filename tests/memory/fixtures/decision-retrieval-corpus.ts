/**
 * Fixed decision-retrieval evaluation corpus + query set (Task 9).
 *
 * A small LongMemEval / LoCoMo-style benchmark: a curated set of decisions and
 * natural-language queries with hand-labelled relevant ids. Used to measure
 * recall@k and MRR so retrieval changes are *tracked* — a regression in ranking
 * shows up as a dropped metric rather than going unnoticed.
 *
 * Shared by:
 *   - tests/memory/decision-retrieval-benchmark.test.ts  (CI guardrail)
 *   - scripts/decision-retrieval-bench.mjs               (ad-hoc reporting)
 *
 * Ids are stable (1..N) and used directly as relevance labels. Keep this file
 * deterministic — no timestamps that drift, no randomness.
 */
import type { DecisionStore, DecisionType } from '../../../src/memory/decision-store.js';

export interface CorpusDecision {
  id: number;
  title: string;
  content: string;
  type: DecisionType;
  tags?: string[];
}

export const PROJECT_ROOT = '/projects/retrieval-bench';

/**
 * 16 decisions spanning a few topical clusters (auth, caching, build, API,
 * data). Titles + content are written so lexical and semantic signals diverge
 * on some queries (e.g. "speed up logins" should hit the argon2 cost-tuning
 * decision even though it shares no salient keyword with the query).
 */
export const CORPUS: CorpusDecision[] = [
  {
    id: 1,
    title: 'Adopt argon2id for password hashing',
    content:
      'Replaced bcrypt with argon2id for password storage. Argon2id resists GPU ' +
      'cracking and is the current OWASP recommendation.',
    type: 'tech_choice',
    tags: ['auth', 'security'],
  },
  {
    id: 2,
    title: 'Tune argon2 cost parameters for login latency',
    content:
      'Lowered argon2 memory cost from 64MiB to 19MiB so authentication completes ' +
      'faster on the login path without unacceptably weakening the hash.',
    type: 'tradeoff',
    tags: ['auth', 'performance'],
  },
  {
    id: 3,
    title: 'Use Redis for session storage',
    content:
      'Moved session storage from the database to Redis to scale concurrent ' +
      'sessions and reduce read load on Postgres.',
    type: 'architecture_decision',
    tags: ['caching', 'sessions'],
  },
  {
    id: 4,
    title: 'Cache invalidation via pub/sub fanout',
    content:
      'Invalidate cached entries by publishing a Redis pub/sub message so every ' +
      'app node drops the stale key simultaneously.',
    type: 'architecture_decision',
    tags: ['caching'],
  },
  {
    id: 5,
    title: 'Drop the GraphQL gateway in favour of REST',
    content:
      'Removed the GraphQL gateway; the frontend now calls REST endpoints ' +
      'directly, simplifying the request path and cutting a network hop.',
    type: 'architecture_decision',
    tags: ['api'],
  },
  {
    id: 6,
    title: 'Version the public API under /v2',
    content:
      'Introduced an explicit /v2 prefix for breaking API changes so existing ' +
      'clients on /v1 keep working during migration.',
    type: 'convention',
    tags: ['api'],
  },
  {
    id: 7,
    title: 'Pin Node.js to the 20 LTS line',
    content:
      'Standardised the runtime on Node.js 20 LTS to match the support window ' +
      'and avoid drift between developer machines and CI.',
    type: 'tech_choice',
    tags: ['runtime', 'build'],
  },
  {
    id: 8,
    title: 'Switch the bundler to tsup',
    content:
      'Adopted tsup for building the TypeScript package — faster cold builds and ' +
      'simpler config than the previous rollup setup.',
    type: 'tech_choice',
    tags: ['build'],
  },
  {
    id: 9,
    title: 'Store money as integer minor units',
    content:
      'Persist monetary amounts as integer cents rather than floating point to ' +
      'avoid rounding errors in financial calculations.',
    type: 'convention',
    tags: ['data', 'correctness'],
  },
  {
    id: 10,
    title: 'Use UUIDv7 for primary keys',
    content:
      'Switched primary keys to UUIDv7 so ids are globally unique and roughly ' +
      'time-ordered, improving index locality over random UUIDv4.',
    type: 'tech_choice',
    tags: ['data'],
  },
  {
    id: 11,
    title: 'Rate-limit auth endpoints',
    content:
      'Added a per-IP rate limit on the login and token endpoints to slow down ' +
      'credential-stuffing and brute-force attempts.',
    type: 'architecture_decision',
    tags: ['auth', 'security'],
  },
  {
    id: 12,
    title: 'Serve static assets from a CDN',
    content:
      'Front static assets with a CDN to cut latency for distant users and ' +
      'offload bandwidth from the origin servers.',
    type: 'architecture_decision',
    tags: ['performance'],
  },
  {
    id: 13,
    title: 'Adopt structured JSON logging',
    content:
      'Emit logs as structured JSON via pino so they can be parsed and queried ' +
      'in the log aggregator instead of grepping free text.',
    type: 'convention',
    tags: ['observability'],
  },
  {
    id: 14,
    title: 'Run database migrations in CI before deploy',
    content:
      'Gate deploys on running schema migrations in the CI pipeline so a bad ' +
      'migration fails fast rather than in production.',
    type: 'convention',
    tags: ['build', 'data'],
  },
  {
    id: 15,
    title: 'Encrypt PII at rest',
    content:
      'Encrypt personally identifiable information columns at rest using ' +
      'application-level envelope encryption with rotated data keys.',
    type: 'architecture_decision',
    tags: ['security', 'data'],
  },
  {
    id: 16,
    title: 'Prefer composition over inheritance for plugins',
    content:
      'Plugin authors should compose small capability objects rather than ' +
      'extending a base class, keeping the plugin surface flat and testable.',
    type: 'convention',
    tags: ['architecture'],
  },
];

export interface BenchQuery {
  query: string;
  /** Decision ids considered relevant for this query (gold labels). */
  relevant: number[];
}

/**
 * Queries are phrased to mostly overlap lexically with their targets (so FTS5
 * has a fair shot — the CI floor depends on it) while still rewarding semantic
 * ranking when embeddings are present.
 */
export const QUERIES: BenchQuery[] = [
  { query: 'password hashing algorithm', relevant: [1, 2] },
  { query: 'argon2 login latency tuning', relevant: [2, 1] },
  { query: 'redis session storage', relevant: [3, 4] },
  { query: 'cache invalidation', relevant: [4, 3] },
  { query: 'graphql gateway rest', relevant: [5] },
  { query: 'api versioning prefix', relevant: [6] },
  { query: 'node lts runtime version', relevant: [7] },
  { query: 'bundler tsup build', relevant: [8] },
  { query: 'money currency rounding', relevant: [9] },
  { query: 'uuid primary key', relevant: [10] },
  { query: 'rate limit brute force login', relevant: [11] },
  { query: 'cdn static assets latency', relevant: [12] },
  { query: 'structured json logging', relevant: [13] },
  { query: 'database migrations ci deploy', relevant: [14] },
  { query: 'encrypt pii at rest', relevant: [15] },
  { query: 'composition over inheritance plugins', relevant: [16] },
];

/** Seed a DecisionStore with the fixed corpus (ids land 1..N in insert order). */
export function seedCorpus(store: DecisionStore): void {
  for (const d of CORPUS) {
    store.addDecision({
      title: d.title,
      content: d.content,
      type: d.type,
      project_root: PROJECT_ROOT,
      tags: d.tags,
    });
  }
}

// ── Metrics ──────────────────────────────────────────────────────────────

/** recall@k: fraction of a query's relevant ids present in the top-k ranking. */
export function recallAtK(ranked: number[], relevant: number[], k: number): number {
  if (relevant.length === 0) return 1;
  const topK = new Set(ranked.slice(0, k));
  const hit = relevant.filter((id) => topK.has(id)).length;
  return hit / relevant.length;
}

/** Reciprocal rank of the first relevant id (0 when none in the ranking). */
export function reciprocalRank(ranked: number[], relevant: number[]): number {
  const rel = new Set(relevant);
  for (let i = 0; i < ranked.length; i++) {
    if (rel.has(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

export interface BenchSummary {
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
  queries: number;
}

/** Average recall@{1,3,5} + MRR over the query set given a ranker callback. */
export function evaluate(rank: (q: BenchQuery) => number[]): BenchSummary {
  let r1 = 0;
  let r3 = 0;
  let r5 = 0;
  let mrr = 0;
  for (const q of QUERIES) {
    const ranked = rank(q);
    r1 += recallAtK(ranked, q.relevant, 1);
    r3 += recallAtK(ranked, q.relevant, 3);
    r5 += recallAtK(ranked, q.relevant, 5);
    mrr += reciprocalRank(ranked, q.relevant);
  }
  const n = QUERIES.length;
  return {
    recallAt1: r1 / n,
    recallAt3: r3 / n,
    recallAt5: r5 / n,
    mrr: mrr / n,
    queries: n,
  };
}
