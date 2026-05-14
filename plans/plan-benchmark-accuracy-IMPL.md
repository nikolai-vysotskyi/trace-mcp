# Benchmark Accuracy Audit — IMPL Report

Audit and surgical fixes for the `trace-mcp benchmark` CLI command and the
matching `benchmark_project` MCP tool. Both share the same engine in
`src/analytics/benchmark.ts`.

## Entry points

- CLI subcommand: `src/cli/analytics.ts` — exposes `benchmark` (top-level) and
  `analytics benchmark`. Both delegate to `runBenchmarkAction()` →
  `runBenchmark()` from `src/analytics/benchmark.ts`.
- MCP tool: `src/tools/register/session.ts:360-381` — registers
  `benchmark_project`, calling the same `runBenchmark()`.
- Engine: `src/analytics/benchmark.ts`.

## Audit Matrix

| Criterion | Verdict | Evidence |
|---|---|---|
| Warm-up | N/A | No timing measurement — entirely a synthetic token calculator |
| Sample size | FAIL | Single pass per scenario; `queries` is sample count, not iteration count (`benchmark.ts:604`) |
| Variance reporting | FAIL | No stddev / p50 / p95 anywhere; single mean with misleading 1-decimal precision (`benchmark.ts:61`) |
| Baseline accuracy | FAIL | Never reads files; uses formulas like `file_byte_length * 0.08`, `* 0.45`, `* 0.06` (`benchmark.ts:141, 169, 245, 363, 446`) |
| Tokenization | FAIL | `chars / 3.5` heuristic, no real tokenizer (`benchmark.ts:38-40`) |
| GC / JIT warmup | N/A | No timing |
| Result caching | N/A | No real query loop |
| Wall clock vs CPU | N/A | No timing |
| Reproducibility | PASS | Deterministic with seed (`benchmark.ts:42-48`) |
| Off-by-one | FAIL | `benchmarkTestsFor` divides chars by 3.5 directly instead of routing through `estimateTokens` → inconsistent rounding (`benchmark.ts:580`) |
| Misleading aggregate | FAIL | Methodology line claims "actual compact response size from index" — both sides are fabricated (`benchmark.ts:649`) |
| `composite_task` inconsistency | FAIL | Comment says "~10-15%" but code uses 0.08 = 8% (`benchmark.ts:362-363`) |

## Bugs Picked + Rationale

1. **False methodology claim** — output told users it measured "actual compact
   response size from index". It did not. Most user-visible accuracy bug.
2. **No tokenizer calibration** — `chars/3.5` is ~14% off cl100k_base on code.
   `gpt-tokenizer` is already a dep, so calibration is free.
3. **Single-shot reduction with misleading 1-decimal precision** — readers
   couldn't tell whether 92.9% was noise or signal. Added multi-sample with
   stddev / p95.
4. **`benchmarkTestsFor` off-by-one** — divided chars by 3.5 directly instead
   of `estimateTokens()`, producing non-integer baseline tokens that other
   scenarios didn't have.
5. **Misleading share-report dollar figures** — `$X wasted` framing implied
   measured savings; reworded to "estimated".

## Fixes Shipped

Each bug fixed in `src/analytics/benchmark.ts` and surfaced in
`src/cli/analytics.ts` output:

- Replaced hardcoded `chars/3.5` with calibrated `CALIBRATED_CHARS_PER_TOKEN`,
  default 4.0, calibrated against `gpt-tokenizer` cl100k_base on a TypeScript
  sample. Calibration is idempotent for the process; CLI awaits it explicitly.
- Added `samples` parameter (default 5) — `runScenariosOnce()` runs `samples`
  times with seed-shifted rng. `reduction_stats: { mean, stddev, p95, samples }`
  attached to every scenario and the totals.
- Rewrote `methodology` string: starts with `SYNTHETIC ESTIMATOR.` and lists
  the chars-per-token ratio + samples + seed.
- Added `accuracy: { kind: 'synthetic-estimator', chars_per_token,
  tokenizer_calibrated, samples, caveats[] }` to the JSON envelope.
- Fixed `benchmarkTestsFor`: `(3*5*80)/3.5` → `estimateTokens(3*5*80)`.
- Markdown formatter now shows stddev and p95 columns, the synthetic-estimator
  callout, and a caveats list.
- Text formatter prefixes with "Synthetic token-waste estimate", shows
  `±stddev%` per scenario and at totals, and prints the tokenizer state.
- Share-report wording: "Estimated token waste" not "Your AI agent recomputes
  work worth", plus a footer disclosing chars/token + sample count.
- CLI exposes `--samples <n>` and `--no-calibrate` flags on both `benchmark`
  and `analytics benchmark`.

## Test Coverage Delta

New file: `tests/tools/benchmark-accuracy.test.ts` — 7 cases:

1. `result.accuracy` declares synthetic-estimator + caveats + methodology says
   SYNTHETIC.
2. Multi-sample mode populates `reduction_stats` per scenario AND in totals;
   at least one scenario has stddev > 0.
3. Same seed + same calibration → byte-identical totals (reproducibility).
4. Tokenizer calibration moves chars-per-token into [2,6] band when
   gpt-tokenizer is present; falls back cleanly otherwise.
5. Calibrated ratio lands in [3.0, 5.5] for TS-like sample (when tokenizer
   present).
6. `tests_for` scenario produces integer `baseline_tokens` matching the new
   `estimateTokens()` path (no chars/3.5 off-by-one).
7. `totals.reduction_pct` matches `(1 - tm/bl) * 100`, and sum of scenario
   tokens equals totals (no hidden double-count).

Existing `tests/analytics/benchmark.test.ts` (4 tests) still passes — output
shape changes are additive.

## BEFORE vs AFTER sample output

BEFORE (`/tmp/bench-before.log`):

```
⚡ Recomputation leak in this codebase
   92.9% recomputed work · 777,929 tokens that don't need to be paid for
   1,328 files / 7,824 symbols indexed
   symbol_lookup              20,392 →    1,010 tokens   (95.0% saved)
   ...
   TOTAL                     837,037 →   59,108 tokens   (92.9% saved)
```

AFTER (`/tmp/bench-after.log`):

```
⚡ Synthetic token-waste estimate for this codebase
   ~92.8% ± 16.7% recomputed work · ~596,255 tokens (estimated, not measured)
   1,327 files / 7,836 symbols indexed
   tokenizer: chars/4.29 (calibrated) · 5 samples
   symbol_lookup              32,628 →    5,116 tokens   (84.3% ±5.5% saved)
   ...
   TOTAL                     642,539 →   46,284 tokens   (92.8% ± 16.7% saved)
   Synthetic estimator — see --format json for caveats.
```

Note: the headline number dropped from 837k to 643k baseline tokens because
the tokenizer is now calibrated to ~4.29 chars/token instead of 3.5. The
reduction percentage stayed in the same ballpark (92.9% → 92.8%), but the
±16.7% stddev now shows the figure should not be quoted to 1 decimal place.

## Test Suite Status

- New: `tests/tools/benchmark-accuracy.test.ts` — 7/7 pass
- Legacy: `tests/analytics/benchmark.test.ts` — 4/4 still pass
- Full suite: 5943 pass / 8 skipped (vs ~5939 baseline — 4 net new passes)
- `pnpm run build` — exit 0

## Follow-ups Punted

- The trace-mcp side is still computed from fixed multipliers, NOT actual tool
  invocations. A real measurement harness would: run `get_outline`,
  `get_symbol`, `find_usages` etc. against this same store and tokenize the
  actual JSON responses. That's a much larger surgery (needs sandboxed
  server instance + tool dispatch + JSON tokenization plumbing) and out of
  scope for this accuracy pass. The caveats list calls this out explicitly.
- Per-scenario multiplier rationales are inconsistent with one another (some
  use 0.05, some 0.08, some 0.45) — they could be unified or sourced from a
  config file. Punted.
- Wall-clock latency reporting is not in the benchmark at all. If the user
  wants p50/p95 latency, that's a separate feature.

## One Risk

Even after these fixes, the underlying claim — that trace-mcp saves ~92% of
tokens vs raw reads — is still an upper-bound estimate driven by per-scenario
multipliers. A motivated reader could still cite the headline figure and
mislead, even though caveats are now in the JSON envelope and the text/markdown
output prefixes the figure with "~" and "Synthetic estimator". The deeper fix
is the real measurement harness called out in Follow-ups.
