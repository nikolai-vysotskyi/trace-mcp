---
layout: default
title: Indexing throughput — stage breakdown
permalink: /perf/index-throughput/
description: Internal working document. Measured indexing-pipeline stage breakdown for trace-mcp.
noindex: true
---

# Indexing throughput — stage breakdown (TRA-936)

Preregistration: [`prereg-index-throughput.md`](./prereg-index-throughput.md). Machine-readable
data: [`index-throughput.json`](./index-throughput.json). Harness:
[`scripts/bench-index-throughput.ts`](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/scripts/bench-index-throughput.ts).

This is a baseline, not a regression gate — there is no pass bar (see the prereg
doc). The point is a stage breakdown to optimize *from*, per this issue's own
framing: see what work can be skipped before making it faster.

## Run 2026-09-05

`fc47c10f` fixture (1903 files — this repo at the pinned perf-fixture commit),
M-series Mac, darwin 25.5.0/arm64, 18 logical CPUs, Node v22.22.3. One sample
per configuration (no regression bar to defend, so no median-of-N discipline
here — see Caveats).

### 1. Cold index throughput

| Config | Wall time | Files/sec | Pool size |
|---|---|---|---|
| One-shot pool (CLI default, `min(8,cpus-1)`) | 3051 ms | 624 | 8 |
| Daemon-shaped keepalive pool (`min(4,cpus/2)`) | 3749 ms | 508 | 4 |
| Single-threaded (`TRACE_MCP_WORKERS=0`) | 7783 ms | 244 | — |

**The two pool defaults are not the same code path, and the issue's cited
suspect describes only one of them.** `extract-pool.ts:90`
(`DEFAULT_KEEPALIVE_WORKER_COUNT = min(4, cpus/2)`) is used only by the
daemon's shared, persistent pool (`project-manager.ts:196`, `keepAlive: true`).
A one-shot pipeline run (CLI `index`, or the pipeline's own
`maybeGetExtractPool` when no pool is injected) constructs a *different*,
larger default — `DEFAULT_WORKER_COUNT = min(8, cpus-1)`, 8 workers on this
machine. Both are measured above; optimization work targeting "the" worker
count needs to say which one.

### 2. Stage breakdown, one-shot pooled cold run (production config)

`extractMs`/`persistMs`/etc. below are **cumulative time summed across
concurrent calls**, not wall-clock — extraction runs across 8 workers at once,
so the sum is larger than the 3051 ms wall time by design. Where useful,
divide by pool size for a rough per-thread wall-clock estimate.

| Stage | Cumulative | ≈ wall-clock share |
|---|---|---|
| File discovery (`collectFiles` — walk + gitignore) | 127 ms | 4% (real wall-clock, single-threaded) |
| Extract (read + tree-sitter parse + plugin extraction), across 8 workers | 11 074 ms | ≈1384 ms / 8 workers ≈ 45% |
| Persist (SQLite/FTS5 write, always main-thread) | 519 ms | 17% (real wall-clock) |
| Edge resolution | 633 ms | 21% (real wall-clock) |
| LSP + SCIP + env indexing | 0.04 ms | ~0% (both disabled by default) |
| Unaccounted (worker IPC, batching, `setImmediate` yields) | ≈ 381 ms | ~12% |

(Total wall time: 3051 ms.)

**Edge resolution is a minority of a cold pass (~21%), as predicted.**
Extraction dominates a from-scratch index by file count; TRA-923/924/925's
finding that edge resolution dominates applies to *incremental* passes (a
1-file change re-resolving the whole graph), not a cold one — see §4.

### 3. What's inside "extract" — tree-sitter parse vs. everything else

Only separable single-threaded (worker *threads* have their own module graph;
a main-thread patch on `web-tree-sitter`'s `Parser.prototype.parse` can't see
into them — see the prereg doc). Single-threaded diagnostic run, same corpus:

| | Cumulative | Share of extract |
|---|---|---|
| Extract, total | 48 573 ms | 100% |
| — tree-sitter `Parser.parse()` (3506 calls, ~1.8/file) | 2293 ms | **4.7%** |
| — everything else: disk read, framework-plugin extraction (87 integrations), content hashing, existing-row lookups | 46 281 ms | **95.3%** |

**Tree-sitter parsing itself is cheap. The surrounding work is not.** This is
a genuine finding, not a predicted one — the prereg doc took no position on
this ratio. If extract-stage throughput becomes an optimization target, the
87-integration plugin-extraction pass (not the parser) is where the time is,
though this run can't say *which* plugins without deeper instrumentation
(explicitly out of scope — see prereg §Scope).

### 4. ExtractPool worker warm-up tax

Compares the first pool-dispatched file's latency (one per worker, all
dispatched near-simultaneously) against the steady-state median once every
worker has handled at least one file. Run twice per pool (the harness was run
three times total while building it; the first run used a measurement bug —
wrong pool-size slice — and is excluded):

| Pool | First-call median (2 samples) | Steady-state median (2 samples) |
|---|---|---|
| One-shot (8 workers) | 141 ms, then 2.3 ms | 3.4 ms, then 3.3 ms |
| Daemon keepalive (4 workers) | 110 ms, then 3.9 ms | 2.7 ms, then 2.7 ms |

**Partially confirmed, and noisier than predicted.** Steady-state per-file
latency is rock-stable across every sample (2.7-3.4 ms). First-call latency
is bimodal, not a stable "always ~100-140 ms": one run per pool showed a
clear ~100-140 ms tax (roughly matching TRA-925's "~150-300 ms × N" WASM
`Language.load` + plugin-init estimate), the other showed none at all,
indistinguishable from steady state. That is more consistent with OS
thread-scheduling jitter for brand-new threads on a shared dev machine than
with a deterministic per-worker initialization cost — this measurement
can't tell the two apart with two samples. Either way, the tax observed
never multiplied by worker count in wall-clock terms (every worker's first
file runs concurrently, so it costs the *pool* one hit, not N×), and even at
its highest observed value it was a few percent of total cold-index wall
time, not the dominant cost. **Don't trust a single run of this specific
number** — if worker startup becomes an actual optimization target, take
5-10 samples first.

### 5. Incremental cost

| | 1 file changed | 100 files changed |
|---|---|---|
| Wall time | 1033 ms | 1343 ms |
| Edge resolution | 393 ms (**38%**) | 444 ms (33%) |
| Extract, cumulative (1903 calls either way — see below) | 2651 ms (≈331 ms/8 wall-share, **32%**) | 3894 ms (≈487 ms/8 wall-share, 36%) |
| Persist | 0.4 ms (1 batch) | 84 ms (2 batches) |

**A 100x larger change costs 30% more wall time, not 100x more** (1033 →
1343 ms) — the scoped incremental architecture (TRA-923) does scale with
change size the way it should. What it does *not* scale down is the fixed
per-run cost: `extractCalls` is **1903 in both cases**, because every
incremental run still calls `extract()` once per file in the whole corpus so
the content-hash gate can decide which ones actually changed — enumerating
"did anything change" costs roughly the same whether 1 file or 100 changed.
Edge resolution is the single largest labeled bucket in both cases (33-38%),
matching the prereg prediction that incremental passes stay
edge-resolution-heavy even after TRA-923's scoping fix — but the hash-gate
enumeration scan is a comparable-sized cost sitting right next to it, and it
is a *different* problem: TRA-923 fixed the scope of re-resolution once the
changed file is known, not the cost of finding out which file changed in the
first place. That scan cost is separate from — and does not overlap with —
TRA-935's "reindex that finds nothing" fix, which addresses the *zero-changes*
case; this is the *nonzero-changes* case, where the scan still has to run in
full to know how many files changed.

### 6. Peak vs. steady RSS

| Run | Peak (during) | Steady (3 s after) | Ratio |
|---|---|---|---|
| Cold, one-shot pool | 1168 MB | 532 MB | 2.2x |
| Cold, daemon pool | 1048 MB | 565 MB | 1.9x |
| Cold, single-threaded | 694 MB | 678 MB | 1.0x |
| Incremental, 1 file | 1266 MB | 796 MB | 1.6x |
| Incremental, 100 files | 1493 MB | 887 MB | 1.7x |

**Read the ratio, not the absolute MB.** These are the *benchmark harness's*
own Node process numbers — `tsx` + the full plugin registry + up to 8 worker
threads sharing one process's RSS — not a lean daemon session. The daemon's
own idle/peak RSS is already tracked separately in
[`README.md`](./README.md#current-numbers-3170-121e3e9b-darwin-2555-arm64-median-of-3)
(`tree_rss_idle_mb` / `tree_rss_peak_mb` / `rss_after_index_settle_mb`) and
that is the number to trust for "what does the daemon actually cost." What
this run adds: peak-during-indexing is consistently 1.6-2.2x steady-state
across every pooled configuration, and the single-threaded run (no worker
threads to hold WASM+grammar memory) barely moves at all (1.0x) — most of the
peak-to-steady gap is worker-thread memory that gets reclaimed once indexing
finishes, not a leak.

### 7. ONNX embeddings — hot path or not

Not live-measured (see prereg §Scope — no model download in a benchmark
script). Confirmed by reading `src/daemon/project-manager.ts:501-517`:
`managed.status = 'ready'` is set immediately after `indexAll()` resolves,
*before* `runSummarization()` and `runEmbeddings()` are called — and both are
called un-awaited (`.catch()`, not `await`). A project is servable to MCP
tool calls before embeddings run. This answers the question the issue asked
("on the hot path or truly out-of-band") without needing a throughput number;
embedding throughput itself is a separate, narrower measurement if it becomes
an optimization target on its own.

## Run 2026-09-16 — TRA-1576 incremental discovery (F1 follow-up to TRA-1536)

Same harness, same fixture (`fc47c10f`, 1903 files), M-series Mac. `indexAll`
on a live index now tries watcher since-query → git status before the
`collectFiles()` walk (`src/indexer/incremental-discovery.ts`); the walk
remains the fallback and re-verifies every 10th run / 24 h. Cold runs always
walk (unchanged — 2912 ms pooled vs 3051 ms baseline, noise).

| | walk (#1221 behavior) | fast path | Δ |
|---|---|---|---|
| Incremental 1 file, wall (same-session A/B, unique touch, indexed=1 both) | 666 ms mean (669/664) | 468 ms mean (523/414, watcher-since) | **−30%** |
| Incremental 1 file, wall (full harness) | 727 ms (#1221) | 396 ms (collect 0 ms, extractCalls 1) | −46% |
| Incremental 100 files, wall (full harness) | 1166 ms (#1221) | 940 ms (100/100 indexed, collect 0 ms) | −19% |
| Zero-change `indexAll`, wall (same-session A/B) | 223 ms mean | **42 ms** (early return, no pipeline/cache invalidation) | −81% |
| Git-status path, 1 file (snapshot removed) | — | 446 ms, 1/1 indexed | ≈ watcher-since |

Residual: edge resolution ~270–300 ms dominates the 1-file fast run
(TRA-923 scope, out of scope here — same honest gap #1221 reported).
Measurement artifact worth knowing: the first bench attempt showed the
100-file run indexing 0 files — a fire-and-forget snapshot write landing
*after* the touches made the next since-query report empty. Fixed by
awaiting the write plus a git second-opinion on empty watcher answers
(`runDiscovered`), with a regression test pinning it.

## Run 2026-09-16 — TRA-1577 edit-session incremental reparse (F2)

Same machine (darwin 25.5.0/arm64, 18 logical CPUs, Node v22.22.3).
Scenario: a synthetic 40-file TypeScript project (30 small + 8 medium +
2 × ~900-function large files) driven through a deterministic 60-edit
session — append function, rename identifier, tweak literal, prepend
comment — with one watcher-shaped `indexFiles([file])` per edit, all
in-process (single-file batches sit below the worker-pool threshold, so this
is the production watcher path). Both arms replay the identical edit script;
the run aborts unless both arms index the same symbol graph. Harness:
`runEditSessionComparison` in `scripts/bench-index-throughput.ts`
(`--edit-session-only` for the standalone run).

| | Cache on | Cache off (`TRACE_MCP_NO_TREE_CACHE=1`) |
|---|---|---|
| Session wall (60 edits) | 1084 ms | 1109 ms |
| tree-sitter `Parser.parse()` cumulative | 2.9 ms (60 calls) | 24.3 ms (60 calls) |
| Edited files via incremental reparse | **60/60 (100%)** | 0/60 |
| Final symbol graph | 3136 symbols | 3136 symbols (identical) |

Parse-level microbench on a ~900-function file (median of 15): full parse
5.89 ms vs incremental step 0.58 ms — **10.1×**.

**Reading.** The §3 bucket (tree-sitter parse inside extract) drops **8.4×**
(24.3 → 2.9 ms) at a 100% incremental share — the mechanism works exactly as
specified. Session wall drops ~2% (1084 vs 1109 ms) because parsing was
already ~2% of a single-file watcher reindex; plugin extraction, persist,
and edge resolution dominate that path (§3 predicted this ratio). Optimizing
further wall time means going after those stages, not the parser.

**Two correctness findings baked into the implementation, kept here so the
numbers read honestly:**

- web-tree-sitter 0.27 operates in **UTF-16 code units**, not the UTF-8 bytes
  classic tree-sitter documents (`const x = 関数;` reports the identifier as
  [10,12], not [10,16]). The TRA-1540 prototype computed edits in bytes, so
  every non-ASCII edit silently mis-reused subtrees. `computeSingleEdit` now
  works in UTF-16 throughout; the parity suite pins emoji/CJK/empty/large/
  chained/tsx/go fixtures.
- Concurrent first-loads of `getParser` raced (one `Language.load` per file
  in a `Promise.all` chunk), leaving duplicate WASM Language instances; this
  build returns null when an old tree's Language address differs from the
  parsing parser's. `getParser` now coalesces in-flight loads (one Language +
  Parser per grammar), and a refused incremental parse degrades to a full
  parse instead of erroring the file.

## Run 2026-09-16 — TRA-1578 weak-profile stand (F3 follow-up to TRA-1535)

Same harness, same fixture (`fc47c10f`, 1903 files), M-series Mac under
`TRACE_MCP_LOW_POWER=1`. Full stand definition, A/B table (full vs
low-power), and the embedding idle-unload decision:
[`weak-profile.md`](./weak-profile.md). Headline, back-to-back A/B (n=2,
load-skewed host — deltas, not absolutes): cold wall +15–22% / peak RSS
−33–49%; incremental-100 files −25% wall AND −48% RSS (the adaptive spawn
gate routes the batch in-process); incremental-1 file RSS-only (−19%).
The epic's −30% wall claim does not hold for cold index; the −40% RSS claim
holds and is exceeded.

## Caveats

- **One sample per configuration for the headline tables**, not a median of
  repeats — this is a baseline for a "where does the time go" question, not a
  regression gate (no pass bar exists, per the prereg doc), so the
  run-to-run variance that matters for trend-tracking wasn't controlled for
  here. Wall time, stage cumulative times, and RSS were stable within ~10%
  across the three runs taken while building this harness; the worker-warmup
  first-call latency was not (§4 reports both samples rather than picking
  one) — treat every millisecond figure here as order-of-magnitude, not a
  number to trend run over run.
- **The "extract" cumulative-time buckets are not wall-clock** in the pooled
  runs — they sum concurrent work across up to 8 threads. Wall-clock
  estimates (divide by pool size) are approximations, not measurements.
- **RSS is the harness process's own**, not a lean daemon's — see §6.
- **The disk-read component of "extract" is a remainder**, not a direct
  measurement (§3) — `FileExtractor.extract()` has no single seam that
  isolates it from framework-plugin extraction and hashing.
