---
layout: default
title: Weak-profile stand and full vs low-power numbers (TRA-1578)
permalink: /perf/weak-profile/
description: Internal working document. Reproducible weak-machine stand (TRACE_MCP_LOW_POWER=1) and measured full vs low-power indexing numbers.
noindex: true
---

# Weak-profile stand + full vs low-power numbers (TRA-1578)

Parent epic: TRA-1535. This closes the epic's main unverified item: the
P0/P1 flags (adaptive pool #1222, memory profiles #1224, q8 #1220) were all
measured on M-series, and the claimed weak-profile gains (−30% wall / −40%
RSS) had no stand behind them. Now they do.

## 1. The stand: `TRACE_MCP_LOW_POWER=1`

**Chosen option: the documented env-flag profile, not cpulimit/cgroups.**

Rationale: cgroups/cpulimit in CI measure OS scheduling noise, not our
adaptive logic — and they are not reproducible on a dev laptop. The weak path
in this codebase is already env-gated and deterministic: `TRACE_MCP_LOW_POWER=1`
forces it on any machine, `=0` clears it. That is the stand. One flag, same
code path a real 2c/4GB host takes via auto-detection.

What the flag drives (all measured below unless noted):

| Knob | Full | Low-power (`=1`) | Source |
|---|---|---|---|
| Extract pool size | 8 (CLI) / 4 (daemon) | capped at 2 | `extract-pool.ts:resolveAdaptivePoolSize` (#1222) |
| Worker spawn gate | 100 files | 200 files | `pipeline.ts:maybeGetExtractPool` (#1222) |
| Daemon keepalive idle window | 45 s | 10 s | `extract-pool.ts:resolveKeepAliveIdleMs` (#1222) |
| SQLite `cache_size` / `mmap_size` | 16 / 64 MB | 8 / 32 MB | `schema.ts:resolveIndexMemoryProfile` (#1224 **+ TRA-1578 wiring, see §2**) |
| ONNX dtype | q8 (default since #1220) | q8 (unchanged) | `ai/onnx.ts` — rollback via `TRACE_MCP_ONNX_DTYPE=fp32` |

What the stand does **not** simulate (read the ratios, not the absolutes):
real 2-core scheduling contention, 4 GB memory pressure / OOM behavior, and
slower disks. Absolute milliseconds below do not transfer to weak hardware;
the full-vs-low **ratios** are the signal.

Run it:

```bash
pnpm run build   # bench needs dist/extract-worker.js
# full (control):
npx tsx scripts/bench-index-throughput.ts --json docs/perf/index-throughput.json
# weak stand (experiment) — same harness, same fixture, back-to-back:
TRACE_MCP_LOW_POWER=1 npx tsx scripts/bench-index-throughput.ts --json /tmp/bench-low.json
```

## 2. Code change in this issue: env override for the SQLite profile

Found while building the stand: `resolveIndexMemoryProfile('auto')` keyed
only off `os.totalmem()`, so on a 128 GB dev machine `TRACE_MCP_LOW_POWER=1`
exercised the worker-pool half of the weak path but **not** the SQLite
cache/mmap clamp from #1224. The stand was half a stand.

Fix (`src/db/schema.ts`): `auto` now honors the same
`TRACE_MCP_LOW_POWER=1/0` override the pool uses. Explicit
`index_memory_profile: full/low-power` config still wins over the env flag —
same precedence rule as explicit pool size. Pinned by
`tests/db/trigram-merge.test.ts` → `TRA-1578: TRACE_MCP_LOW_POWER overrides
auto but not explicit profiles`.

## 3. Numbers: full vs low-power, same harness, back-to-back

Harness: `scripts/bench-index-throughput.ts`, fixture `fc47c10f` (1903
files). Machine: M5 Max / darwin arm64 / 18 CPUs, Node v22.22.3.
**Load caveat, stated first:** the host ran at load ~10 (concurrent agent
work) during all four runs — wall times are 3–5x the calm-machine baseline in
`index-throughput.md` and swing ±20% run to run. Every full/low pair below ran
back-to-back, so the **deltas** are trustworthy; the absolutes are not. n=2
per cell — order-of-magnitude, not a regression gate.

| Config | Full wall (2 runs) | Low wall (2 runs) | Δ wall | Full peak RSS | Low peak RSS | Δ RSS |
|---|---|---|---|---|---|---|
| Cold, CLI pool (8→2 workers) | 15887 / 12431 | 16557 / 15971 | **+15%** (slower) | 1201 / 1113 | 598 / 578 | **−49%** |
| Cold, daemon pool (4→2) | 14690 / 11826 | 16466 / 15897 | **+22%** (slower) | 1050 / 1045 | 744 / 650 | **−33%** |
| Cold, single-threaded (control) | 25348 / 23610 | 24560 / 23871 | ≈0% (correct — no workers involved) | 677 / 694 | 651 / 512 | small, knob-only |
| Incremental, 1 file | 1347 / 1151 | 1311 / 1243 | ≈0% (noise) | 825 / 783 | 665 / 642 | **−19%** |
| Incremental, 100 files | 4597 / 3987 | 3154 / 3268 | **−25% (faster)** | 1483 / 1404 | 723 / 775 | **−48%** |

Raw JSON of the four runs is not committed (load-skewed absolutes would
mislead); the table above is the record.

### Verdict on the epic's claims (−30% wall / −40% RSS in weak profile)

**Contradiction first, as agreed:** the −30% wall claim does **not** hold for
a cold index — low-power is 15–22% *slower* there (fewer workers, same serial
tail: edges ~2.2 s + persist ~1 s don't parallelize). The −40% RSS claim
**holds and is exceeded** on cold (−49% CLI pool, −33% daemon pool).

The surprise is the 100-file incremental: **−25% wall AND −48% RSS**, faster
*and* leaner, consistent in 2/2 pairs. Mechanism, confirmed in code (not
hypothesized): the adaptive spawn gate (`maybeGetExtractPool`,
`pipeline.ts:1581`) is 100 normally, 200 on weak — so the 100-file batch
takes the pooled path with full spawn+IPC cost in full mode and the
in-process path with zero spawn in low-power mode. The weak profile isn't
just "slower but leaner": for mid-size batches it skips unjustified worker
spawn entirely. The 1-file incremental is RSS-only (−19%, wall ≈0%) — edge
resolution (~800 ms, serial) dominates both modes there.

Per-file extract arithmetic, for the record: cold pooled full 44 ms/file
cumulative ÷ 8 workers ≈ 5.5 ms wall-share vs low 12.7 ms/file ÷ 2 ≈ 6.4 ms —
identical per-file work, only parallelization differs. No hidden per-file
regression in the weak path.

## 4. Embedding memory: idle-unload decision — НЕ ДЕЛАЕМ

Question from the issue: the q8 model sits resident (~35–60 MB claimed) —
should we unload it when idle, given warm reload is only ~50 ms?

Measured (this issue, M5 Max, `Xenova/all-MiniLM-L6-v2` q8, cache warm —
see `embedding-eval.md` for the fp32/q8 harness numbers this builds on):

- Warm `pipeline()` load: **130–194 ms**, +88 MB RSS (40→176 MB incl.
  transformers.js runtime + WASM). First-ever load 21.8 s incl. ~23 MB
  download — one-time, irrelevant to the decision.
- **Naive unload frees nothing:** dropping the pipeline reference + double
  `gc()` moved RSS 178→180 MB. Reload then *added* +26 MB (180→206) — the
  old session was still alive underneath. Repeated naive unload cycles would
  grow RSS, not shrink it.
- True disposal needs `pipe.model.dispose()` (`modeling_utils.js:241`) —
  undocumented on the `pipeline()` surface, and the WASM runtime + file cache
  stay resident regardless.

And the decisive point: **query-time `embed()` is user-visible.**
`src/ai/search.ts:74` and `src/tools/ai/ai-tools.ts:351` embed the search
query synchronously — every first semantic search after an idle-unload would
pay the reload (130–200 ms here, est. 0.3–0.8 s on a real weak host). That is
a latency regression on exactly the path the product sells as fast, to save
~50–90 MB that #1220 already cut 4x (fp32 ΔRSS 195.8 MB → q8 52.1 MB per
`embedding-eval.md`).

**Decision: no idle-unload.** The cheap win (q8) is banked; the expensive one
buys a visible-latency regression with a disposal API that doesn't cleanly
exist. Revisit only if both hold: (a) transformers.js ships a documented
`pipeline.dispose()`, (b) daemon idle RSS breaches budget *with embeddings
proven dominant* — not before.

## 5. Reproduction checklist for the next run

1. Calm machine if you want absolutes; back-to-back pairs if you want deltas.
2. Same fixture, same build, `TRACE_MCP_LOW_POWER=1` as the only variable.
3. Expect: cold wall +10–25% / peak RSS −30–50%; incremental-100 faster AND
   leaner; incremental-1 RSS-only win; single-threaded unchanged.
4. If cold wall delta flips sign on a calm machine, say so before the summary
   — a reversal is worth more than a confirmation.
