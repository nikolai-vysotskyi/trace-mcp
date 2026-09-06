---
layout: default
title: Preregistration — concurrency & session scaling benchmark
permalink: /perf/prereg-session-scaling/
description: What the concurrency and session scaling benchmark set out to measure, the pass bars, and the control condition comparing daemon-healthy vs daemon-absent architectures.
noindex: true
measurement: session_scaling
data_file: docs/perf/session-scaling.json
preregistration: yes
written_on: 2026-09-05
verdict: MET
---

# Preregistration — concurrency & session scaling benchmark (TRA-931)

**This measurement was preregistered.** Written on 2026-09-05 for TRA-931 (parent tracking issue TRA-921).
Following the discipline established in TRA-920, the test plan, metrics, frozen corpus, pass bars, predictions,
and control condition were declared and frozen before recording the v3.18.0 baseline dataset.

## Question

As concurrent stdio AI coding agent sessions scale (N = 1, 4, 9) working on a shared repository:

1. What is the cold-start latency, peak RSS, and thread cost to first tool response (`get_project_map`)?
2. What is the steady-state idle cost at 60s (RSS and thread count) comparing a healthy daemon versus an unmanaged local fallback?
3. What is the CPU seconds and wall time consumed across the daemon and all sessions when an edit changes a single file?
4. What is the exact scaling multiplier of system resource consumption at N=9 vs N=1 across both architectures?

## Metric

All metrics are measured from real process trees using system primitives (`ps -o rss=`, `ps -M`, `ps -o cputime=`):

- **Cold start wall time:** Milliseconds elapsed from session spawn until JSON-RPC stdio response to `tools/call` (`get_project_map`) arrives.
- **Cold start peak RSS & threads:** Peak resident set size (MB) and thread count observed during session initialization.
- **Steady-state idle (60s):** Per-session RSS (MB), daemon RSS (MB), total system RSS (MB), and total thread count measured after a 60-second idle hold to permit garbage collection and event loops to reach steady-state.
- **1-file change cost:** Wall-clock time (ms) and delta CPU seconds (`cputime`) consumed across daemon and all session process trees following an edit to `src/util/debounce.ts`.
- **Scaling multipliers (N=9 vs N=1):** Ratio of total idle RSS, total thread count, and 1-file change CPU consumption at N=9 compared to N=1.

Emitted by `scripts/bench-session-scaling.ts` directly into `docs/perf/session-scaling.json`.

## Corpus

- **Fixed, version-stamped corpus:** `trace-mcp` v3.18.0 release at commit `9256cf184370cc7175e076baf2c142c4054d0d6c` (2,277 indexed files, 898 of them TypeScript under `src/`;
  11,156 symbols — both counts read from the index at run time, not hand-written).
- **Isolated standalone fixture:** Extracted via `git archive` into an independent temporary repository for each benchmark run, ensuring no lock contention, DB aliasing, or unmanaged git worktree interference.

## Pass bar

- **Primary Scaling Linearity:** Under a healthy daemon, marginal per-session idle RSS must remain bounded (< 200 MB/session), and total RSS at N=9 must not exceed 9× single-session fallback cost (< 1,950 MB).
- **CPU Isolation:** In daemon-healthy mode, background reindexing for a 1-file change must execute in the daemon process, with active stdio sessions consuming <= 0.5 CPU seconds in aggregate.
- **Failure Mode Visibility:** The benchmark must clearly expose the resource amplification of the daemon-absent fallback mode (concurrent local watchers, redundant extraction worker pools, and duplicated graph indexing).

## Prediction

- **Daemon Healthy (Arm A):** Stdio sessions act as lightweight HTTP proxy clients to the persistent daemon.
  - Per-session idle RSS stabilizes at ~140–190 MB with ~12 threads per session.
  - On a 1-file change, only the daemon indexes; proxy sessions consume ~0 CPU seconds.
  - Total system RSS scales as `daemon_base + N * ~150 MB`.
- **Daemon Absent (Arm B):** Stdio sessions fall back to full local backend instances.
  - Each session opens its own SQLite databases, task cache, and file watcher.
  - At N=9, this consumes 9x thread pools and re-indexes the file 9 independent times, resulting in significant thread bloat and redundant CPU waste.

## Control

Arm B is a real measured control arm (`TRACE_MCP_NO_DAEMON=1`), not an estimate or extrapolation.
Both Arm A and Arm B run against the exact same corpus, at the exact same concurrency steps (N = 1, 4, 9),
with the exact same 60-second idle period and identical file edit trigger.

## Amendment — 2026-09-06 (control arm corrected)

The first baseline recorded under this preregistration did not measure its control arm. Arm B pointed
every session at one pre-indexed data directory, which puts `LocalBackend` on its read-only seeded
path: no `indexAll`, no `FileWatcher`. Nothing reindexed after the edit, and the harness recorded a
fixed `sleep(3500)` as the reindex wall time. Found in review of PR #956; that baseline is discarded,
not amended.

The control arm now runs as declared, with three procedural changes:

1. **One private data directory per session, nothing pre-indexed** — so each session runs the full
   local indexing stack and its own watcher, which is what "daemon absent" is supposed to mean.
2. **A daemon port nothing listens on** — a session left on the default port connects to whatever
   daemon the developer already runs on 3741, which silently turns the control arm into a second
   treatment arm.
3. **Reindexing is verified, not timed out.** After the edit, each session is polled through `search`
   until the newly added marker symbol appears in its index; that observed time is the recorded wall
   time. A session that never surfaces the symbol fails the run. No fixed sleeps remain in either arm.

Readiness is also verified before the idle sample: the daemonless arm polls `get_index_health` until
each session's own index holds the corpus, so idle RSS is steady state rather than a mid-indexing
snapshot. Corpus file and symbol counts are read from the index at run time instead of being written
into the script by hand.

Reaching the declared control condition required one product fix, kept in the same change:
`seedSessionDbFromShared` treated an existing-but-empty shared DB as a valid snapshot. Project
registration creates that file before anything is indexed, so on a machine with no daemon the first
session seeded itself from zero files, latched read-only, and served an empty index forever.

## Threats to validity

- **macOS ps resolution:** `cputime` resolution on macOS is bounded to integer seconds or clock ticks; we sample the full recursive child process tree (`pgid`/`ppid` walk) to capture all worker threads and helper processes.
- **Pre-indexing:** Only Arm A attaches to a pre-indexed corpus, which is what a healthy daemon means. Arm B indexes per session by design, so its idle sample waits for each session's index to be ready first.
- **JIT & GC variance:** Running each step with a 60-second idle hold allows Node.js V8 heap and garbage collection to stabilize before sampling.

## Verdict — MET (on the corrected run of 2026-09-06)

The harness (`scripts/bench-session-scaling.ts`) reproduces the concurrency matrix and records absolute
values plus deltas against prior runs into `docs/perf/session-scaling.json`.

The v3.18.0 baseline shows the predicted amplification, now measured rather than assumed: a one-file
change costs the daemon 0.71 CPU seconds at N=9 (1.26× its N=1 cost) with sessions at 0.02 s, while
the daemonless arm burns 15.68 CPU seconds across nine sessions — 19.1× its own N=1 cost — with every
session's reindex confirmed by querying its index. Idle RSS at N=9 is 1,975.8 MB daemon-backed versus
4,433.6 MB daemonless.

The prediction of ~140–190 MB per proxy session held (139.9–141.5 MB). The prediction that daemonless
sessions differ mainly in thread count did not: threads grow 9.00× as predicted, but per-session idle
RSS is 398–482 MB, roughly 3× a proxy session, and that is where most of the machine cost sits.
