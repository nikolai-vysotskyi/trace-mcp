---
layout: default
title: Concurrency and session scaling
permalink: /perf/session-scaling/
description: Internal working document. What N concurrent stdio sessions cost with and without a shared daemon.
noindex: true
---

# Concurrency & Session Scaling Benchmark Report (TRA-931)

Automated benchmark of multi-session concurrency for stdio AI coding agent sessions.
Tracking issue: **TRA-931** (parent umbrella tracking issue: **TRA-921**).

## Executive Summary

When several AI coding agent sessions (Claude Code, Cursor, Cline, Roo) run at once on the same
machine and codebase, what backs them decides whether machine cost grows sub-linearly or linearly.

The harness (`scripts/bench-session-scaling.ts`) measures cold start, 60 s steady-state idle cost,
the cost of a one-file change, and how all three scale across N ∈ {1, 4, 9} concurrent stdio
sessions, in two arms: with a healthy daemon, and daemonless.

Baseline on `trace-mcp` v3.18.0, N=9:

1. **Idle memory.** Daemon-backed: 1,975.8 MB total (9 sessions + daemon), 141.5 MB per session.
   Daemonless: 4,433.6 MB, 481.8 MB per session — 2.2× the machine cost for the same nine agents.
2. **One-file change.** Daemon-backed: 0.73 s total CPU, effectively flat from N=1 (0.58 s) to
   N=9 — the daemon reindexes once and the sessions burn ~0.02 s between them. Daemonless: 15.68 s,
   a **19.1×** increase over N=1 (0.82 s), because each of the nine sessions reindexes the same
   file in its own process.
3. **Threads.** 126 (daemon-backed) vs 162 (daemonless) at N=9.
4. **Cold start** stays sub-second in both arms; what the daemonless arm pays instead is a full
   local index per session (6.9 s at N=9, 2,277 files each) before it can answer anything.

Every reindex number above is verified, not assumed: after the edit the harness polls each session
until the newly added symbol is returned by `search`, and records the time that took. A session that
never surfaces the symbol fails the run instead of contributing a number.

---

## Benchmark Corpus & Environment

- **Corpus:** `trace-mcp` at the pinned v3.18.0 commit
  [`9256cf184370cc7175e076baf2c142c4054d0d6c`](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9256cf184370cc7175e076baf2c142c4054d0d6c)
  — 2,277 indexed files (898 TypeScript files under `src/`), 11,156 symbols. Both counts are read
  out of the index at run time, never hand-written.
- **Fixture isolation:** extracted with `git archive` into a fresh temporary directory per run
  (path canonicalized — on macOS an uncanonicalized `/var` root makes watcher events miss).
- **Hardware & OS:** macOS Darwin arm64 (Apple Silicon).
- **Measurement primitives:**
  - RSS: `ps -o rss=` over the full process tree.
  - Threads: `ps -M -p <pid>`.
  - CPU: `ps -o cputime=`, accumulated user + system seconds.
  - Cold start: stdio JSON-RPC handshake (`initialize` → `notifications/initialized` →
    `tools/call: get_project_map`).
  - Index readiness (daemonless arm): `get_index_health` polled until the session's own index
    holds the corpus, so the idle sample is steady state and not a mid-indexing snapshot.
  - Reindex: `search` polled per session until the edit's marker symbol appears.

### What the two arms are

|                  | Arm A — daemon healthy                                  | Arm B — daemonless                                    |
| ---------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| Daemon           | one `serve-http` daemon, project registered and indexed | none; sessions point at a port nothing listens on     |
| Session data dir | shared with the daemon                                  | one private data dir per session, nothing pre-indexed |
| Indexing         | daemon only                                             | every session indexes the corpus itself               |
| Watcher          | daemon only                                             | one `@parcel/watcher` per session                     |

Arm B is the real daemonless configuration, and getting there took two fixes worth noting, because
both silently produced a benchmark that measured nothing:

- Sessions seeded from a _shared_ DB take the read-only fallback path — no `indexAll`, no watcher.
  Pointing all sessions at one pre-indexed directory therefore measures a daemon hiccup, not
  daemonless operation, and no reindexing happens at all.
- A session left on the default daemon port connects to whatever daemon the developer already runs
  on 3741, so a "daemonless" arm quietly becomes a second daemon-backed arm.

---

## Baseline Measurements (v3.18.0)

Data source: [`docs/perf/session-scaling.json`](./session-scaling.json), run `2026-09-06T01:21:27Z`.

### 1. Single session (N = 1)

| Metric                           | Arm A: daemon healthy        | Arm B: daemonless      |
| -------------------------------- | ---------------------------- | ---------------------- |
| Cold start to `get_project_map`  | 277 ms                       | 302 ms                 |
| Local index ready                | n/a (daemon already indexed) | 3,135 ms (2,277 files) |
| Cold-start peak RSS              | 165.7 MB                     | 215.8 MB               |
| Startup threads                  | 12                           | 14                     |
| Idle RSS at 60 s (per session)   | 140.5 MB                     | 398.1 MB               |
| Idle daemon RSS                  | 476.4 MB                     | n/a                    |
| Total RSS (idle)                 | 616.9 MB                     | 398.1 MB               |
| Total threads (idle)             | 30                           | 18                     |
| One-file change, time to visible | 466 ms                       | 879 ms                 |
| One-file change, daemon CPU      | 0.58 s                       | n/a                    |
| One-file change, sessions CPU    | 0.00 s                       | 0.82 s                 |

At N=1 the daemon is a net cost: it pays a 476 MB base to hold the shared index for a single
session. It stops being a cost at N=4 and is decisive at N=9.

### 2. Concurrency scaling (N = 1, 4, 9)

| N     | Mode             | Cold start (p50 / max) | Per-session idle RSS | Total idle RSS | Total threads | One-file change CPU (daemon / sessions) |
| ----- | ---------------- | ---------------------- | -------------------- | -------------- | ------------- | --------------------------------------- |
| **1** | `daemon_healthy` | 277 / 277 ms           | 140.5 MB             | 616.9 MB       | 30            | 0.58 s / 0.00 s                         |
| **1** | `daemon_absent`  | 302 / 302 ms           | 398.1 MB             | 398.1 MB       | 18            | — / 0.82 s                              |
| **4** | `daemon_healthy` | 410 / 439 ms           | 139.9 MB             | 1,119.8 MB     | 66            | 0.64 s / 0.01 s                         |
| **4** | `daemon_absent`  | 468 / 497 ms           | 411.5 MB             | 1,644.7 MB     | 72            | — / 4.04 s                              |
| **9** | `daemon_healthy` | 659 / 788 ms           | 141.5 MB             | 1,975.8 MB     | 126           | 0.71 s / 0.02 s                         |
| **9** | `daemon_absent`  | 1,036 / 1,334 ms       | 481.8 MB             | 4,433.6 MB     | 162           | — / 15.68 s                             |

Daemonless local index readiness: 3,135 ms at N=1, 4,366 ms at N=4, 6,879 ms at N=9 (median per
session, 2,277 files each time).

### 3. Multipliers (N=9 vs N=1)

| Dimension                 | Daemon healthy | Daemonless |
| ------------------------- | -------------- | ---------- |
| Total idle RSS            | 3.20×          | 11.14×     |
| Total threads             | 4.20×          | 9.00×      |
| One-file change total CPU | 1.26×          | 19.12×     |
| Cold start p50            | 2.38×          | 3.43×      |

---

## Reading the result

The daemon's value is not memory per session — a proxy session (140 MB) and a local session
(400–480 MB) differ by less than the daemon's own base cost. It is that **write work stays flat**.
Nine agents editing one file cost the daemon 0.71 CPU seconds once; the same nine agents daemonless
cost 15.68 CPU seconds, and that number keeps climbing linearly with the number of open sessions,
because each session parses the same file into its own database.

That is the number TRA-922, TRA-923, TRA-924 and TRA-925 have to move, and the number a regression
would put back.

---

## Reproduction

```bash
# Full run (N = 1, 4, 9, 60s idle hold) — about 20 minutes:
pnpm run bench:session-scaling

# Smoke run (N = 1, 4, 5s idle hold):
npx tsx scripts/bench-session-scaling.ts --quick

# Custom:
npx tsx scripts/bench-session-scaling.ts --steps 1,2,4,8 --idle 30 --port 37425

# Stream session logs while debugging the harness itself:
BENCH_VERBOSE=1 npx tsx scripts/bench-session-scaling.ts --quick
```

The script appends a version-stamped run to `docs/perf/session-scaling.json` and reports the delta
against the previous run. Absolute numbers and deltas only — there is no pass/fail threshold,
because we do not yet know what good looks like.
