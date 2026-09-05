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

- **Fixed, version-stamped corpus:** `trace-mcp` v3.18.0 release at commit `9256cf184370cc7175e076baf2c142c4054d0d6c` (898+ TypeScript files, 11,134 symbols).
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

## Threats to validity

- **macOS ps resolution:** `cputime` resolution on macOS is bounded to integer seconds or clock ticks; we sample the full recursive child process tree (`pgid`/`ppid` walk) to capture all worker threads and helper processes.
- **Pre-indexing:** The repository is pre-indexed before sessions attach to isolate warm steady-state scaling from one-off initial repository ingestion.
- **JIT & GC variance:** Running each step with a 60-second idle hold allows Node.js V8 heap and garbage collection to stabilize before sampling.

## Verdict — MET

The benchmark harness (`scripts/bench-session-scaling.ts`) reliably reproduces the concurrency matrix and records
both absolute values and delta comparisons against prior runs into `docs/perf/session-scaling.json`.
The baseline on v3.18.0 demonstrates that a healthy daemon provides strict CPU isolation during reindexing and
predictable per-session proxy scaling, while verifying that the absence of a daemon produces severe thread and
reindex amplification across concurrent agent sessions.
