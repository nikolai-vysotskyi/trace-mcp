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
