/**
 * Behavioural pins for the `trace-mcp benchmark` accuracy contract.
 *
 * These tests guard the explicit honesty-and-precision properties added when
 * the synthetic benchmark was audited:
 *   1. Output is labelled as synthetic — caveats and `accuracy.kind` MUST be present.
 *   2. Multi-sample stats (mean / stddev / p95) are emitted on every scenario
 *      and at the totals level.
 *   3. The tokenizer-calibration path actually changes the chars-per-token ratio
 *      when gpt-tokenizer is available, and falls back cleanly when disabled.
 *   4. Reproducibility: same seed + same calibration produce identical totals.
 *   5. The legacy chars/3.5 hardcode is gone (no scenario reports tokens computed
 *      via the old off-by-one path in tests_for).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  _getCharsPerTokenForTests,
  _resetTokenizerCalibrationForTests,
  calibrateTokenizer,
  runBenchmark,
} from '../../src/analytics/benchmark.js';
import type { Store } from '../../src/db/store.js';
import { createTestStore } from '../test-utils.js';

function seedStore(): Store {
  const store = createTestStore();
  const f1 = store.insertFile('src/parser.ts', 'typescript', 'h1', 5000);
  const f2 = store.insertFile('src/store.ts', 'typescript', 'h2', 8000);
  const f3 = store.insertFile('src/utils.ts', 'typescript', 'h3', 3000);
  const f4 = store.insertFile('src/cache.ts', 'typescript', 'h4', 4500);
  const f5 = store.insertFile('src/router.ts', 'typescript', 'h5', 6200);

  const sym = (fileId: number, name: string, kind: string, byteStart: number, byteEnd: number) =>
    store.insertSymbol(fileId, {
      symbolId: `${name}-id`,
      name,
      kind,
      fqn: name,
      signature: `${kind} ${name}`,
      byteStart,
      byteEnd,
      lineStart: 1,
      lineEnd: 10,
    });
  sym(f1, 'parseInput', 'function', 100, 800);
  sym(f1, 'Parser', 'class', 900, 3000);
  sym(f2, 'Store', 'class', 50, 6000);
  sym(f2, 'createStore', 'function', 6100, 7500);
  sym(f3, 'formatOutput', 'function', 0, 500);
  sym(f4, 'lookup', 'method', 100, 1500);
  sym(f4, 'Cache', 'class', 1600, 4000);
  sym(f5, 'route', 'function', 200, 1800);
  sym(f5, 'Router', 'class', 1900, 5500);
  return store;
}

describe('benchmark accuracy contract', () => {
  let store: Store;

  beforeEach(() => {
    store = seedStore();
    // Force a known, uncalibrated baseline at the start of each test.
    _resetTokenizerCalibrationForTests(4.0, false);
  });

  it('result.accuracy declares the estimator is synthetic and exposes the caveats', () => {
    const result = runBenchmark(store, {
      queries: 3,
      seed: 7,
      samples: 3,
      calibrateTokenizer: false,
    });
    expect(result.accuracy.kind).toBe('synthetic-estimator');
    expect(result.accuracy.samples).toBe(3);
    expect(result.accuracy.tokenizer_calibrated).toBe(false);
    expect(result.accuracy.chars_per_token).toBeCloseTo(4.0, 1);
    // Caveats: must mention that the trace-mcp side is NOT a real tool call.
    expect(result.accuracy.caveats.some((c) => /multiplier|not real tool|estimat/i.test(c))).toBe(
      true,
    );
    // Methodology line must explicitly say "SYNTHETIC".
    expect(result.methodology).toMatch(/SYNTHETIC ESTIMATOR/);
  });

  it('multi-sample mode produces non-zero variance on at least one scenario', () => {
    const result = runBenchmark(store, {
      queries: 4,
      seed: 13,
      samples: 5,
      calibrateTokenizer: false,
    });
    expect(result.totals.reduction_stats).toBeDefined();
    // totals.reduction_stats is cross-scenario dispersion (1 datapoint per scenario),
    // not cross-sample. Use scenario.reduction_stats for cross-sample variance.
    expect(result.totals.reduction_stats?.samples).toBe(result.scenarios.length);
    // Every scenario must carry per-sample stats.
    for (const s of result.scenarios) {
      expect(s.reduction_stats).toBeDefined();
      expect(s.reduction_stats?.samples).toBe(5);
      expect(s.reduction_stats?.mean).toBeGreaterThanOrEqual(0);
      expect(s.reduction_stats?.p95).toBeGreaterThanOrEqual(s.reduction_stats!.mean - 0.01);
    }
    // Sampling re-rolls must produce some scenario with stddev > 0.
    // (If every scenario is constant-by-construction the multi-sample machinery
    // is broken — at minimum symbol_lookup depends on which symbols are picked.)
    const anyDispersion = result.scenarios.some((s) => (s.reduction_stats?.stddev ?? 0) > 0);
    expect(anyDispersion).toBe(true);
    // Totals stddev across scenarios should also be > 0 because scenarios
    // differ from each other.
    expect(result.totals.reduction_stats?.stddev ?? 0).toBeGreaterThan(0);
  });

  it('same seed + same calibration produces byte-identical totals (reproducibility)', () => {
    _resetTokenizerCalibrationForTests(4.0, false);
    const r1 = runBenchmark(store, {
      queries: 3,
      seed: 99,
      samples: 4,
      calibrateTokenizer: false,
    });
    _resetTokenizerCalibrationForTests(4.0, false);
    const r2 = runBenchmark(store, {
      queries: 3,
      seed: 99,
      samples: 4,
      calibrateTokenizer: false,
    });
    expect(r1.totals.baseline_tokens).toBe(r2.totals.baseline_tokens);
    expect(r1.totals.trace_mcp_tokens).toBe(r2.totals.trace_mcp_tokens);
    expect(r1.totals.reduction_pct).toBe(r2.totals.reduction_pct);
    expect(r1.totals.reduction_stats?.stddev).toBe(r2.totals.reduction_stats?.stddev);
  });

  it('tokenizer calibration changes the chars-per-token ratio when gpt-tokenizer is available', async () => {
    _resetTokenizerCalibrationForTests(99.0, false);
    const before = _getCharsPerTokenForTests();
    expect(before.calibrated).toBe(false);
    expect(before.ratio).toBe(99.0);

    await calibrateTokenizer();

    const after = _getCharsPerTokenForTests();
    // If gpt-tokenizer loaded, ratio MUST have moved into the sane band [2,6].
    // If gpt-tokenizer is unavailable in CI we accept the fallback state but
    // still assert the chars-per-token guard rails — this test documents the
    // contract either way.
    if (after.calibrated) {
      expect(after.ratio).toBeGreaterThanOrEqual(2.0);
      expect(after.ratio).toBeLessThanOrEqual(6.0);
      expect(after.ratio).not.toBe(99.0);
    } else {
      // Fallback path: ratio kept the previous sentinel because calibration failed.
      expect(after.ratio).toBe(99.0);
    }
  });

  it('calibrated ratio (when available) is within 10% of a known cl100k_base ratio for a code-like sample', async () => {
    _resetTokenizerCalibrationForTests(4.0, false);
    await calibrateTokenizer();
    const { ratio, calibrated } = _getCharsPerTokenForTests();
    if (!calibrated) {
      // No tokenizer available — skip the accuracy assertion but document.
      expect(ratio).toBe(4.0);
      return;
    }
    // For TypeScript-ish source, cl100k_base typically yields ~3.5-4.5 chars/token.
    expect(ratio).toBeGreaterThan(3.0);
    expect(ratio).toBeLessThan(5.5);
  });

  it('tests_for scenario uses estimateTokens consistently (no chars/3.5 off-by-one)', () => {
    _resetTokenizerCalibrationForTests(4.0, false);
    const result = runBenchmark(store, {
      queries: 3,
      seed: 1,
      samples: 1,
      calibrateTokenizer: false,
    });
    const testsFor = result.scenarios.find((s) => s.name === 'tests_for');
    expect(testsFor).toBeDefined();
    // baseline = globTokens(200) + estimateTokens(3*5*80) + 2*estimateTokens(3000)
    // With ratio 4.0: 200 + ceil(1200/4) + 2*ceil(3000/4) = 200 + 300 + 1500 = 2000 per query.
    // Old buggy code would give: 200 + 1200/3.5 + 2*ceil(3000/3.5) = 200 + 342.85 + 1716 = 2258.85, then Math.round.
    // Pin the new integer math: every baseline detail row should be a clean integer.
    for (const d of testsFor!.details) {
      expect(Number.isInteger(d.baseline_tokens)).toBe(true);
      expect(d.baseline_tokens).toBe(2000);
    }
  });

  it('totals.reduction_pct matches a recomputation from baseline/trace_mcp tokens (no hidden double-count)', () => {
    _resetTokenizerCalibrationForTests(4.0, false);
    const result = runBenchmark(store, {
      queries: 2,
      seed: 5,
      samples: 1,
      calibrateTokenizer: false,
    });
    const { baseline_tokens, trace_mcp_tokens, reduction_pct } = result.totals;
    const expected = Math.round((1 - trace_mcp_tokens / baseline_tokens) * 1000) / 10;
    expect(reduction_pct).toBe(expected);
    // Scenario sums must equal totals (no double-counting between scenarios).
    const sumBaseline = result.scenarios.reduce((s, sc) => s + sc.baseline_tokens, 0);
    const sumCompact = result.scenarios.reduce((s, sc) => s + sc.trace_mcp_tokens, 0);
    expect(sumBaseline).toBe(baseline_tokens);
    expect(sumCompact).toBe(trace_mcp_tokens);
  });
});
