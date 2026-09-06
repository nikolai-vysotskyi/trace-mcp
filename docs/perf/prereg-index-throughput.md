---
layout: default
title: Preregistration — indexing throughput stage breakdown
permalink: /perf/prereg-index-throughput/
description: Internal working document. Preregistered before the TRA-936 run.
noindex: true
---

# Preregistration — indexing throughput stage breakdown (TRA-936)

Written before the run, per the [TRA-920 discipline](./README.md#preregistration--tra-920).

## Question

Where does cold-index and incremental-index wall time actually go, broken down
by stage (file discovery, extract [disk read + tree-sitter parse + framework
plugin extraction], SQLite/FTS5 persist, edge resolution, LSP/SCIP/env
postprocess), and how does peak RSS during indexing compare to settled RSS
afterward? No optimization decision is made from this data — it only says
which stage is worth optimizing next.

## Corpus

This repo's own pinned perf fixture: commit `fc47c10f` (revision 2, see
[`packages/app/scripts/perf-fixture.json`](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/packages/app/scripts/perf-fixture.json)),
checked out at `~/.trace/perf-fixture/fc47c10f44eb` (shared with the desktop
app perf harness — self-indexing is this project's established dogfooding
corpus; not reinventing one, per this issue's own dependency on TRA-931's
discipline). 810 TypeScript files under `src/` alone; ~1817 files / ~9705
symbols total across the whole tree per the 2026-09-04 baseline entry in
[`README.md`](./README.md).

## Method

`scripts/bench-index-throughput.ts`, run via `npx tsx` against this checkout's
own `src/*.ts` (not `dist/`) so pipeline internals — `FileExtractor`,
`FilePersister`, `ExtractPool`, `IndexingPipeline`'s private passes, and
`web-tree-sitter`'s `Parser` — can be prototype-patched with timers from
outside, with zero production code changes. Two runs:

1. **Production run** — worker pool enabled (the pool's own worker entry,
   `dist/extract-worker.js`, is temporarily copied next to
   `src/indexer/extract-worker.js` so `ExtractPool`'s `import.meta.url`-relative
   lookup finds it under `tsx`; deleted afterward, never committed). Gives
   realistic wall time, throughput, and peak/steady RSS. Stage split covers
   extract (worker dispatch, wall time as seen from the main thread) + persist
   (always main-thread, real per-batch timing) + edge resolution +
   LSP/SCIP/env, all captured by patching the relevant methods' prototypes.
2. **Single-threaded diagnostic run** — `TRACE_MCP_WORKERS=0` forces in-process
   extraction, so `Parser.prototype.parse` (same module instance as the
   pipeline's own cached parsers) can be patched too. This is the only way to
   see inside "extract" and split it into tree-sitter parse time vs.
   everything else (disk read, framework-plugin extraction, hashing) — worker
   *threads* load their own separate module graph, so a main-thread patch
   can't see into them. This run's absolute wall time is not comparable to
   run 1 (single-threaded); only the *ratio* of parse-time to extract-total
   is read off it.

Both runs index into a fresh temp-file SQLite DB (not `:memory:`, so real
`synchronous`/WAL disk I/O is measured), with `PluginRegistry.createWithDefaults()`
(the full plugin set, not a cut-down test registry) and a default
`TraceMcpConfigSchema.parse({ root })` — no config drift across runs. RSS is
sampled from `process.memoryUsage().rss` every 50 ms during `indexAll()`, and
again once 3 s after it resolves (settled).

Incremental cost is measured on the same warm store immediately after the
cold run: append a trailing comment to `src/util/debounce.ts` (real content
change, not a `touch` — matches `bench-incremental-edges.sh`'s convention) for
the 1-file case; append the same to 100 real `src/**/*.ts` files for the
100-file case; `git checkout --` the fixture worktree between cases so each
starts from the same known content.

## Known suspects this run must answer

- **ExtractPool worker startup tax.** Compare the first pool-dispatched
  batch's per-file extract latency against the steady-state median once all
  workers are warm. Predict: visible startup tax on the first batch only,
  single-digit percent of total cold-index wall time on this corpus size —
  four workers each paying ~150-300 ms WASM+plugin init is bounded in
  absolute terms and this corpus takes longer than that to index end to end.
- **Edge-resolution share of a full cold pass.** Predict: edge resolution is
  a minority of cold-index wall time (most of a from-scratch pass is
  extraction across ~1800 files); TRA-923/924/925 already found edge
  resolution to be the dominant cost specifically on *incremental* passes
  (full-graph re-resolution on a 1-file change), not on a cold pass where
  extraction dominates by file count alone. Predict incremental (1-file)
  wall time is edge-resolution-dominated even after TRA-923's scoped-pass fix,
  because the scoped pass still has fixed per-file overhead independent of
  batch size.
- **ONNX embeddings on the hot path or not.** Already answered by reading
  `src/daemon/project-manager.ts:501-517` before running anything: `managed.status
  = 'ready'` is set, then `runSummarization()` / `runEmbeddings()` fire
  un-awaited (`.catch()`, not `await`) — a project is servable before
  embeddings run. This run does not re-verify that by executing the ONNX
  provider (no live model call — see Scope below); it is a code-reading
  finding, reported as such, not a measurement.

## Scope / what this does NOT measure

- **Live ONNX embedding wall-clock.** Running the real `OnnxProvider` needs a
  downloaded model; this environment's network policy is not assumed to allow
  that inside a benchmark script, and a flaky model-download step has no place
  in a repeatable harness. The embeddings question this run answers is
  "on the hot path or not" (code-path finding above), not "how many ms per
  symbol" — that's a separate, narrower follow-up if embedding throughput
  itself becomes the optimization target.
- **Disk read time in isolation.** Only separable from tree-sitter parse time
  in the single-threaded run, and even there it is a remainder (extract-total
  minus parse-time), not a direct measurement — `FileExtractor.extract()` has
  no single seam for "just the read". Reported as a remainder bucket, labeled
  as such.
- **N-session daemon scaling.** That is TRA-931's own harness
  (`docs/perf/session-scaling.md`, not yet merged to master); this run is a
  single project, single session, cold-JS-process measurement of the indexing
  pipeline itself, not the daemon's multi-project behavior.

## Pass bar

There is no pass/fail bar — this is a measurement task, not a regression gate
(the issue is explicit: "optimization starts after the stage breakdown
exists"). The bar for this run being useful is that every stage in the
question above gets a real number or an explicit "not separable, here's why."
A run that produces zero numbers is not a measurement, per the standing
lesson in `README.md`'s changelog ("a metric that has never once produced a
value is not a measurement, it is a plan").

## Control

None. There is nothing to compare this cold-index run against yet — it *is*
the baseline TRA-936 asks for. Future runs (after any of TRA-922/923/924/925
land further changes, or after real optimization work starts) compare against
this one.
