/**
 * Recall regression suite.
 *
 * For each fixture in `tests/recall-harness/fixtures/`, verifies that
 * recall@k against the live retrieval surface stays at or above the
 * baseline captured the day the fixture was authored. A drop indicates
 * a retrieval regression — typically introduced by a change to a
 * ranker, prompt, or scoring weight.
 *
 * Run modes (vitest):
 *   pnpm run test:recall                    # assert against baselines
 *   RECALL_UPDATE=1 pnpm run test:recall    # rewrite baselines (intentional)
 *
 * The suite is auto-skipped when the project's index DB does not exist
 * yet (e.g. fresh checkout). Add `trace-mcp add` to your local setup if
 * you want it to enforce locally.
 */

import fs from 'node:fs';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { findProjectRoot } from '../../src/project-root.js';
import { getProject } from '../../src/registry.js';
import {
  type HarnessReport,
  loadFixtures,
  runHarness,
  updateBaselines,
  writeJsonReport,
  writeMarkdownReport,
} from './runner.js';

const UPDATE_MODE = process.env.RECALL_UPDATE === '1';

// Resolve the index DB once so we can decide whether to skip the entire
// suite on machines that have not indexed the project yet.
function projectHasIndex(): boolean {
  try {
    const root = findProjectRoot(process.cwd());
    const entry = getProject(root);
    return !!entry && fs.existsSync(entry.dbPath);
  } catch {
    return false;
  }
}

const haveIndex = projectHasIndex();
const fixtures = haveIndex ? loadFixtures() : [];

describe.skipIf(!haveIndex)('recall harness', () => {
  let report: HarnessReport | undefined;

  beforeAll(async () => {
    report = await runHarness();
    writeJsonReport(report);
    writeMarkdownReport(report);
    if (UPDATE_MODE) updateBaselines(report);
  });

  afterAll(() => {
    if (!report) return;
    // Always print a one-line summary so CI logs surface the metric
    // without the human having to open the JSON report.
    process.stdout.write(
      `\nrecall-harness: ${report.passed}/${report.fixture_count} passed; ` +
        `aggregate recall@k=${report.aggregate_recall_at_k.toFixed(3)}\n`,
    );
  });

  for (const fixture of fixtures) {
    it(`${fixture.kind}: ${fixture.id}`, () => {
      const r = report?.results.find((res) => res.fixture.id === fixture.id);
      if (!r) throw new Error(`No result captured for fixture ${fixture.id}`);
      // In update mode we never fail — the goal is to capture today's
      // numbers as the new baseline, so reporting takes precedence over
      // assertion.
      if (UPDATE_MODE) {
        expect(r.recall_at_k).toBeGreaterThanOrEqual(0);
        return;
      }
      expect(
        r.recall_at_k,
        `recall@${r.k}=${r.recall_at_k.toFixed(3)} fell below baseline ${r.baseline.toFixed(
          3,
        )}; retrieved=${JSON.stringify(r.retrieved_ids.slice(0, r.k))}; matched=${JSON.stringify(
          r.matched_ids,
        )}`,
      ).toBeGreaterThanOrEqual(r.baseline);
    });
  }
});

// When the index is absent we still want a marker test so vitest reports
// "skipped" rather than "no tests" — that surfaces the missing setup.
describe.runIf(!haveIndex)('recall harness (skipped — no index)', () => {
  it('skipped: index DB missing', () => {
    expect(haveIndex).toBe(false);
  });
});
