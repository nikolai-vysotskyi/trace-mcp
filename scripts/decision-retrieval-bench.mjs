#!/usr/bin/env node
/**
 * Ad-hoc decision-retrieval benchmark reporter (Task 9).
 *
 * Prints recall@{1,3,5} and MRR for the FTS5-only ranker over the SAME fixed
 * benchmark corpus the CI guardrail (tests/memory/decision-retrieval-benchmark.test.ts)
 * asserts against. This script is for eyeballing the numbers while iterating
 * on ranking — it must import the tracked fixture rather than keep its own
 * copy, or the two silently drift apart (they did: a prior hand-duplicated
 * corpus here diverged from tests/memory/fixtures/decision-retrieval-corpus.ts
 * and printed different, wrong numbers).
 *
 * Usage (from repo root):
 *   npx tsx scripts/decision-retrieval-bench.mjs
 *
 * NOTE: this project's tsup build produces a single bundled dist/index.js
 * (no per-module dist/memory/*.js files), and DecisionStore is not part of
 * the package's public export surface — so there is no compiled artifact
 * this script can import. It runs against the TypeScript source directly
 * (via tsx) instead.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DecisionStore } from '../src/memory/decision-store.ts';
import {
  PROJECT_ROOT,
  QUERIES,
  evaluate,
  seedCorpus,
} from '../tests/memory/fixtures/decision-retrieval-corpus.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-bench-script-'));
const store = new DecisionStore(path.join(tmp, 'decisions.db'));
try {
  seedCorpus(store);

  function ftsRank(q) {
    const orQuery = q.query.split(/\s+/).filter(Boolean).join(' OR ');
    return store
      .queryDecisions({ project_root: PROJECT_ROOT, search: orQuery, limit: 50 })
      .map((d) => d.id);
  }

  const summary = evaluate(ftsRank);
  console.log('Decision retrieval benchmark (FTS5-only, tracked corpus):');
  console.log(`  queries     : ${summary.queries}`);
  console.log(`  recall@1    : ${summary.recallAt1.toFixed(3)}`);
  console.log(`  recall@3    : ${summary.recallAt3.toFixed(3)}`);
  console.log(`  recall@5    : ${summary.recallAt5.toFixed(3)}`);
  console.log(`  MRR         : ${summary.mrr.toFixed(3)}`);
  console.log(`  (${QUERIES.length} queries against the shared benchmark corpus)`);
} finally {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
