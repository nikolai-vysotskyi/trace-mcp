---
layout: default
title: Daemon memory while serving one project
permalink: /perf/daemon-serving-memory/
description: Internal working document. What the trace-mcp daemon's resident memory does while a client drives it.
noindex: true
---

# Daemon memory while serving one project

TRA-651. Measured 2026-09-06 on darwin 25.5.0 / arm64, daemon v3.18.0 at `3e749a02`,
throwaway `TRACE_MCP_DATA_DIR`, private port, **one** registered project: this repo at the
pinned perf-fixture commit `fc47c10f44eb` — 1 817 files / 9 705 symbols. Reproduce with

```
pnpm run build
node scripts/perf/daemon-serving-rss.mjs --drive-seconds 120 --idle-seconds 120
node scripts/perf/daemon-query-alloc.mjs --calls 200
```

Raw runs: `docs/perf/tra651-before.json`, `docs/perf/tra651-after.json`.

## The reported number does not survive a settled measurement

TRA-651 filed "727 MB RSS **idle** while serving a single project". Sampling the same
fixture on the same harness, at one-second resolution and with `heapUsed` alongside RSS:

| Daemon state | RSS | `heapUsed` |
|---|---|---|
| Fresh, nothing registered | 166 MB | — |
| First seconds after the index finishes | 700–720 MB | 200 MB |
| **Median over the next 60 s, untouched** | **399 MB** | **91 MB** |
| Median while a client drives it | 856 MB | ~300 MB |
| Peak while driven | 894 MB | 428 MB |
| 20 s after the client stops | 416 MB | 88 MB |

727 MB is a real reading, but it is a reading taken inside the post-index window, not an
idle steady state. The settled idle figure is ~400 MB of RSS over 91 MB of live heap, and
it is reached about twenty seconds after the last request. Everything above that line is
garbage V8 has not collected yet plus pages the process has not handed back — in one run
RSS fell from 419 MB to 85 MB at t=80 s with `heapUsed` unchanged at 88 MB, which is the
macOS page-retention effect TRA-278 documented and not a change in what is live.

So there is no per-project leak to find here. What is real is the cost of *serving*: the
daemon transiently doubles, and it does so on the same thread that answers `/health`.

## Where the serving cost comes from

`scripts/perf/daemon-query-alloc.mjs` drives one endpoint at a time, 200 calls each:

| Endpoint | ms/call | response | RSS growth over 200 calls |
|---|---|---|---|
| `/api/projects/graph` | **544** | **1 268 KB** | +99 MB |
| `/api/projects/smells` | **426** | 118 KB | **+293 MB** |
| `/api/projects/graph-stats` | 8.5 | 2.2 KB | +1 MB |
| `/api/projects/files` | 3.2 | 2.1 KB | +4 MB |
| `/api/projects/stats` | 0.8 | 0.1 KB | ~0 |
| `/health` | 0.14 | 0.2 KB | 0 |

`/api/projects/graph` rebuilds the whole project graph from SQLite on every request — the
app refetches it on any scope/granularity/filter change, and the result for identical
parameters is byte-identical every time. 544 ms of that is synchronous `better-sqlite3`
work on the process that also serves `/health`, which is the starvation shape from
TRA-941.

Profiling `buildGraphData` directly (12 consecutive whole-project builds,
`node --cpu-prof`) put the time in two places, both of them work that did not need to
happen:

1. **`getSymbolsByFileIds` was a per-file loop** — 424 ms of self time. Despite the plural
   name it called the single-file statement once per file, so 1 507 statements to fetch
   9 705 symbol rows, `SELECT *` each, for a file-level graph that reads nothing but `id`
   and `file_id`. Every signature and metadata blob in the project was loaded and dropped.
2. **`getEdgesForNodesBatch` copied every row and re-parsed its SQL per chunk** — 442 ms
   self time plus 136 ms in `prepare`. `{ ...row, pivot_node_id }` allocated a second
   object for every edge in the project on every build, and each of the ~22 chunks
   prepared the same statement text again.

## What changed

- `getSymbolsByFileIds` is one chunked `IN` query per 900 files (`symbol-repository.ts`).
- New `getSymbolFileRefsByFileIds` selects only `(id, file_id)`; the file-level graph path
  in `visualize.ts` uses it.
- `getEdgesForNodesBatch` annotates `pivot_node_id` on the row instead of spreading into a
  copy, and caches the chunk statement by placeholder count (`graph-repository.ts`).

Nothing was cached at the response level and no result was memoized — this is the same
answer computed with fewer round trips and fewer allocations.

### Before → after

Whole-project `buildGraphData`, in-process, 12 consecutive builds, output byte-identical
(1 507 nodes / 5 070 edges / 922 738 bytes in both):

| | before | after |
|---|---|---|
| Median build | 152 ms | **85 ms** (−44%) |
| Top profile frame | `getSymbolsByFileIds` 424 ms | `getEdgesForNodesBatch` 290 ms |
| `prepare` | 136 ms | 36 ms |
| GC | 264 ms | 67 ms |
| RSS after 12 builds | 415 MB | **307 MB** |

End-to-end on the daemon, 120 s of the app's query mix against the fixture:

| | before | after |
|---|---|---|
| Queries served in 120 s | 1 492 | **2 150** (+44%) |
| Idle RSS after index (60 s median) | 399 MB | 404 MB |
| Idle `heapUsed` after index | 91 MB | 91 MB |
| Serving median RSS | 856 MB | 841 MB |
| Serving peak RSS | 894 MB | 865 MB |

**Resident memory while serving barely moved.** That is the honest result: 44% more work
per second for the same footprint, because the daemon's RSS under load is set by GC pacing
against a large young generation, not by how much each request allocates. The reason to
take the change is the latency and the throughput; the RSS number is unchanged and should
not be quoted as a memory win.

## Still open

- **`/api/projects/smells` at 426 ms and +293 MB per 200 calls** is the larger remaining
  allocator on the read path and was not touched here.
- **Seven handlers in `src/cli.ts` open `new TopologyStore(TOPOLOGY_DB_PATH)` per request**
  (lines 1548, 1621, 2032, 2096, 2140, 2186) while `ProjectResourcePool` exists to hold
  exactly one daemon-wide instance (TRA-938). Measured at 0.42 ms per open/close, so this
  is an fd-churn concern rather than a latency one — but it is the same file-descriptor
  exhaustion shape TRA-938 fixed elsewhere.
- **The regression guard is a query count, not a timing.** `tests/perf/graph-build-query-count.test.ts`
  asserts a whole-project graph build issues fewer statements than it has files. It fails
  on the pre-fix code (128 queries for 120 files) and is machine-independent.
