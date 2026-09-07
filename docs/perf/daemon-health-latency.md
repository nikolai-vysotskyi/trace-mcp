---
layout: default
title: How long /health stops answering while the daemon indexes
permalink: /perf/daemon-health-latency/
description: Internal working document. The width of the daemon's health-check starvation window, and what bounds it.
noindex: true
---

# `/health` latency under an indexing burst (TRA-1127)

`better-sqlite3` is synchronous. In a CLI that is fine; in the process that also answers the
daemon's liveness check it means `/health` cannot be served while a batch is inside
`sqlite3_step`. TRA-1127 caught the consequence on the production daemon (v3.22.0, 21 projects
loaded): `/health` accepted the connection and never answered inside 5 s, at 99.3% CPU, with
61.9% of main-thread samples inside synchronous `better-sqlite3`.

That is worse than a slow endpoint. A session that cannot reach `/health` concludes the daemon
is dead and falls back to indexing the repo itself, so a daemon that is *merely busy*
manufactures N more indexers — the failure amplifies itself.

## What actually sets the window

`extractAndPersist` already yields one macrotask turn per persist batch, so a single project's
starvation is bounded: measured at **293 ms max** for one project (1 817 files) reindexing
725 files.

What was not bounded is how many projects do that at once. Initial `indexAll` runs under a
limiter (`indexer.parallel_initial_index`, default 2); watcher-driven `indexFiles` ran ungated,
so every registered project could have a synchronous batch queued ahead of `/health`. The
starvation window is therefore roughly *per-batch time × projects reindexing*, and it grows
linearly with the number of registered projects — which is exactly the 21-project shape of the
production report.

## Measured

`scripts/perf/daemon-health-latency.mjs`, macOS arm64, fixture = the pinned perf commit
(`fc47c10f44eb`, 1 817 files / 9 705 symbols) extracted N times into separate temp roots, all
registered at once. A probe hits `/health` every 100 ms throughout. The burst appends one new
exported symbol to 725 source files **in every project** simultaneously and holds until the
index settles.

`/health` during the burst:

| projects | arm | p50 | p95 | max | probes ≥ 2 s | burst window |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 8 | before | 1 ms | 439 ms | 1 214 ms | 0 | 34.6 s |
| 8 | after | 5 ms | 270 ms | **531 ms** | 0 | 35.8 s |
| 16 | before | 1 ms | 660 ms | **2 550 ms** | 1 | 64.1 s |
| 16 | after | 74 ms | 297 ms | **734 ms** | 0 | 74.1 s |

Before the fix the worst-case doubles when the project count doubles (1 214 → 2 550 ms) and
crosses the 2 s watchdog at 16 projects. After it, it stays in the same band (531 → 734 ms) —
the queue depth is capped, not the project count.

Initial indexing is unaffected (48 953 → 49 007 ms at N=16); it was already gated.

## What it costs

Catching up on 11 600 edited files across 16 repos takes **15% longer** (64.1 s → 74.1 s at
N=16, 3.5% at N=8), and the median probe during the burst rises from 1 ms to 74 ms because the
work is now spread over a longer window instead of stampeding. That is the trade: a bounded
worst case in exchange for a slower bulk catch-up. It is the right side to be wrong on, because
the failure the old shape produced was not "reindex is slow" but "every session decides the
daemon is dead and starts its own indexer".

## What this is not

This does not move SQLite off the main thread; the per-batch synchronous stretch is unchanged.
It bounds how many of those stretches can queue ahead of a health check. TRA-922 (move the
write path off the event loop) remains the structural fix; this is the cap that keeps the
symptom out of the 2 s watchdog until then.

## Reproduction

```bash
pnpm run build
node scripts/perf/daemon-health-latency.mjs --projects 16 --touch 900
```

Prints JSON: per-phase p50/p95/max `/health` latency and how many probes crossed 2 s. Every
number is a reading; nothing here is modelled.
