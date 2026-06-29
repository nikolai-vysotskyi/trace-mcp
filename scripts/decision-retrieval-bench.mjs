#!/usr/bin/env node
/**
 * Ad-hoc decision-retrieval benchmark reporter (Task 9).
 *
 * Prints recall@{1,3,5} and MRR for the FTS5-only ranker over the fixed
 * benchmark corpus. The CI guardrail lives in
 * tests/memory/decision-retrieval-benchmark.test.ts; this script is for eyeballing
 * the numbers while iterating on ranking.
 *
 * Usage (from repo root, after `pnpm run build`):
 *   node scripts/decision-retrieval-bench.mjs
 *
 * It imports the COMPILED store from dist/, and the corpus/metrics are inlined
 * here so the script has zero dependency on test-only TypeScript fixtures.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const distStore = path.resolve('dist/memory/decision-store.js');
if (!fs.existsSync(distStore)) {
  console.error('dist/ not found — run `pnpm run build` first.');
  process.exit(1);
}
const { DecisionStore } = await import(pathToFileURL(distStore).href);

const PROJECT_ROOT = '/projects/retrieval-bench';

const CORPUS = [
  [
    'Adopt argon2id for password hashing',
    'Replaced bcrypt with argon2id for password storage; resists GPU cracking.',
    'tech_choice',
  ],
  [
    'Tune argon2 cost parameters for login latency',
    'Lowered argon2 memory cost so authentication completes faster on the login path.',
    'tradeoff',
  ],
  [
    'Use Redis for session storage',
    'Moved session storage to Redis to scale concurrent sessions.',
    'architecture_decision',
  ],
  [
    'Cache invalidation via pub/sub fanout',
    'Invalidate cached entries by publishing a Redis pub/sub message.',
    'architecture_decision',
  ],
  [
    'Drop the GraphQL gateway in favour of REST',
    'Frontend now calls REST endpoints directly; removed the GraphQL gateway.',
    'architecture_decision',
  ],
  [
    'Version the public API under /v2',
    'Introduced an explicit /v2 prefix for breaking API changes.',
    'convention',
  ],
  ['Pin Node.js to the 20 LTS line', 'Standardised the runtime on Node.js 20 LTS.', 'tech_choice'],
  [
    'Switch the bundler to tsup',
    'Adopted tsup for building the TypeScript package.',
    'tech_choice',
  ],
  [
    'Store money as integer minor units',
    'Persist monetary amounts as integer cents to avoid floating point rounding.',
    'convention',
  ],
  [
    'Use UUIDv7 for primary keys',
    'Switched primary keys to UUIDv7 for time-ordered globally unique ids.',
    'tech_choice',
  ],
  [
    'Rate-limit auth endpoints',
    'Added a per-IP rate limit on login and token endpoints to slow brute-force.',
    'architecture_decision',
  ],
  [
    'Serve static assets from a CDN',
    'Front static assets with a CDN to cut latency for distant users.',
    'architecture_decision',
  ],
  ['Adopt structured JSON logging', 'Emit logs as structured JSON via pino.', 'convention'],
  [
    'Run database migrations in CI before deploy',
    'Gate deploys on running schema migrations in CI.',
    'convention',
  ],
  [
    'Encrypt PII at rest',
    'Encrypt personally identifiable information columns at rest.',
    'architecture_decision',
  ],
  [
    'Prefer composition over inheritance for plugins',
    'Plugin authors compose small capability objects rather than extending a base class.',
    'convention',
  ],
];

const QUERIES = [
  ['password hashing algorithm', [1, 2]],
  ['argon2 login latency tuning', [2, 1]],
  ['redis session storage', [3, 4]],
  ['cache invalidation', [4, 3]],
  ['graphql gateway rest', [5]],
  ['api versioning prefix', [6]],
  ['node lts runtime version', [7]],
  ['bundler tsup build', [8]],
  ['money currency rounding', [9]],
  ['uuid primary key', [10]],
  ['rate limit brute force login', [11]],
  ['cdn static assets latency', [12]],
  ['structured json logging', [13]],
  ['database migrations ci deploy', [14]],
  ['encrypt pii at rest', [15]],
  ['composition over inheritance plugins', [16]],
];

function recallAtK(ranked, relevant, k) {
  if (relevant.length === 0) return 1;
  const top = new Set(ranked.slice(0, k));
  return relevant.filter((id) => top.has(id)).length / relevant.length;
}
function reciprocalRank(ranked, relevant) {
  const rel = new Set(relevant);
  for (let i = 0; i < ranked.length; i++) if (rel.has(ranked[i])) return 1 / (i + 1);
  return 0;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-bench-script-'));
const store = new DecisionStore(path.join(tmp, 'decisions.db'));
try {
  for (const [title, content, type] of CORPUS) {
    store.addDecision({ title, content, type, project_root: PROJECT_ROOT });
  }
  let r1 = 0,
    r3 = 0,
    r5 = 0,
    mrr = 0;
  for (const [query, relevant] of QUERIES) {
    const orQuery = query.split(/\s+/).filter(Boolean).join(' OR ');
    const ranked = store
      .queryDecisions({ project_root: PROJECT_ROOT, search: orQuery, limit: 50 })
      .map((d) => d.id);
    r1 += recallAtK(ranked, relevant, 1);
    r3 += recallAtK(ranked, relevant, 3);
    r5 += recallAtK(ranked, relevant, 5);
    mrr += reciprocalRank(ranked, relevant);
  }
  const n = QUERIES.length;
  console.log('Decision retrieval benchmark (FTS5-only):');
  console.log(`  queries     : ${n}`);
  console.log(`  recall@1    : ${(r1 / n).toFixed(3)}`);
  console.log(`  recall@3    : ${(r3 / n).toFixed(3)}`);
  console.log(`  recall@5    : ${(r5 / n).toFixed(3)}`);
  console.log(`  MRR         : ${(mrr / n).toFixed(3)}`);
} finally {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
