---
layout: default
title: Bulk indexing event-loop stalls
permalink: /perf/tra-2305-event-loop/
description: Internal measurements for TRA-2305.
noindex: true
---

# TRA-2305: bulk indexing event-loop stalls

Measured 2026-10-10 on a separate temporary project. The harness creates 2,701 TypeScript files and 30,000 empty directories, indexes them into a temporary SQLite database, and probes a same-process HTTP `/health` endpoint from a child process. It does not use the registered projects or the live daemon. Run with:

```sh
TRACE_MCP_LOG_LEVEL=error pnpm exec tsx scripts/bench-tra-2305.ts 2701 30000
```

| Code | Longest event-loop lag | Longest `/health` request |
| --- | ---: | ---: |
| v3.35.0 baseline | 1,647 ms | 1,630 ms |
| After cooperative package-entry discovery, before async context discovery | 923 ms | 922 ms |
| After both changes | 282 ms | 280 ms |

The figures are individual local runs, not statistical estimates. Repeated runs varied with filesystem state: the baseline also measured 458 ms with 10,000 directories; the final code measured 337 ms with 30,000. The synthetic tree reproduces the same class of `/health` starvation, but it does not prove which call caused the 24,397 ms field stall in the user's project.

Phase timing identified two synchronous directory walks before file extraction: implicit workspace detection and `buildProjectContext` directory discovery. The latter also reopens every discovered directory while looking for manifests, including empty ones. The cold `findPackageJsonEntries` walk was another blocking span (646–778 ms across two runs with 30,000 directories). The pipeline now discovers relevant context directories with asynchronous filesystem calls, reuses that result for implicit workspace detection, and yields during package-entry discovery. Sync APIs remain for existing non-indexing callers. Blade plugin detection still holds one turn for roughly 270–310 ms on this synthetic tree; it is the largest remaining measured unit.

The regression tests compare async and sync context/workspace results on a nested project and verify that pending `setImmediate` callbacks run during directory discovery. The harness is intended for manual latency measurements, since a fixed millisecond assertion would depend on filesystem and host load.
