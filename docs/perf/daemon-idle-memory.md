---
layout: default
title: Daemon idle memory attribution
permalink: /perf/daemon-idle-memory/
description: Internal working document. Where the trace-mcp daemon's resident memory goes while idle.
noindex: true
---

# Daemon idle memory attribution

Measured 2026-09-04 on darwin 25.5.0 / arm64, daemon v3.16.0 (`serve-http`, 8 projects
registered). TRA-811. Everything below is a reading, not an estimate — the commands are
in each section so the next run can repeat them instead of re-deriving.

> **Correction, 2026-09-07 (TRA-1125): the 949 MB below is not an idle measurement.**
> The `projects_indexing == 0` filter it relies on could never see incremental reindex
> work, so "idle" samples include the daemon at 99% CPU. The honest single-project idle
> figure is **301 MB**. See the 2026-09-07 section at the end before quoting anything here.

## The starting number

`Daemon vitals` in `~/.trace/daemon.log` reported, over 2 178 idle samples
(`projects_indexing == 0`): median `rss_mb` 949, median `heap_used_mb` 186. So ~760 MB of
the resident set is outside the V8 heap that `process.memoryUsage()` reports.

That gap is not mysterious once you know that **`heapUsed` is main-thread only**. Worker
threads have their own isolates and their own WASM memories; all of it lands in the
process RSS and none of it in `heap_used_mb`.

## Attribution

`vmmap -summary <pid>` on a live daemon, plus `vmmap <pid>` for the region detail:

| Region | Resident | What it is |
|---|---|---|
| `Memory Tag 255` | **642 MB** across 2 341 regions | V8 heap pages + WASM memories, main thread **and** all worker threads |
| `mapped file` | 196 MB across 8 `.db` files | SQLite `mmap_size`, 64 MB cap per connection |
| `MALLOC_SMALL` | 163 MB | native allocations (better-sqlite3, tree-sitter, node itself) |
| `__TEXT` / `__LINKEDIT` / `__OBJC_RO` | ~275 MB | shared, file-backed, mostly system libraries |

Named suspects from the issue, resolved:

1. **Extract worker pool — confirmed, and the largest reclaimable piece.**
   `scripts/perf/extract-worker-rss.mjs` spawns N workers against the built
   `dist/extract-worker.js` and reports RSS at four points. With N=8 and one TypeScript
   file parsed per worker:

   | Point | RSS |
   |---|---|
   | baseline | 41 MB |
   | after spawning 8 workers | 330 MB (+36 MB/worker) |
   | after 1 extract per worker | 461 MB (+52 MB/worker) |
   | after `terminate()` | 128 MB |

   So the pool costs ~420 MB resident at size 8, and ~333 MB of that comes straight back
   on terminate. Before TRA-811 the daemon pool was created with `keepAlive: true` and no
   idle timeout, so it paid that for the whole daemon lifetime whether or not anything was
   being indexed.

2. **SQLite page cache — real but second, and mostly clean pages.** The 196 MB above is
   `mmap_size` (64 MB per connection, `src/db/schema.ts`), not `cache_size` (16 MB per
   connection). It grows toward 512 MB as the eight DBs get touched. These are clean,
   file-backed pages the kernel can evict under pressure, so they inflate RSS at a lower
   real cost than the worker heaps. Left alone deliberately: lowering `index_mmap_mb`
   trades query latency for a number that is already evictable.

3. **ONNX runtime — not a suspect at all.** No `onnxruntime` image is mapped into the
   daemon process (`vmmap <pid> | grep -i onnx` returns nothing). Local embeddings load
   lazily and were never resident in any sample. Zero bytes.

## What changed

`KEEPALIVE_IDLE_TERMINATE_MS` (`src/indexer/extract-pool.ts`): daemon pools now release
their workers after 5 minutes with nothing in flight, instead of never. Warm-pool
behaviour across a burst of edits is unchanged — the window is far longer than any edit
burst — and the next `extract()` re-spawns lazily at the usual ~150-300 ms × N.

Expected steady-state effect on an idle daemon with 8 workers: about **-420 MB** resident,
taking the idle median from ~950 MB toward ~530 MB. Not yet confirmed in the field; the
daemon on the measuring machine restarts every ~3 min (TRA-809), so it never sits idle
long enough to cross the 5-minute window there.

**TRA-971 follow-up:** 5 minutes was still long enough that a daemon idle for under an
hour of a workday kept the pool warm the whole time. `KEEPALIVE_IDLE_TERMINATE_MS` is now
45 seconds — comfortably inside the 60s idle bar from the acceptance criteria — with a
per-instance `keepAliveIdleMs` override on `ExtractPoolOptions` so tests don't have to
wait out the real default.

---

## 2026-09-07 — the field confirmation, and why it took three weeks (TRA-1125)

Two results, and the second one invalidates how we had been reading the first.

### The prediction held. Idle RSS settles at 301 MB.

Measured on darwin 25.5.0 / arm64, daemon v3.22.0, built from `c148138e`, isolated
`TRACE_MCP_DATA_DIR` on port 3799 so nothing else on the machine could touch it. One
project (this repo, 2 240 files indexed in 3.8 s), then left alone:

| Since index finished | RSS | CPU |
|---|---|---|
| 0 s | 624 MB | — |
| 15 s | 410 MB | 0.0% |
| **45 s** | **301 MB** | 0.0% |
| 45 s → 255 s | 301 MB, flat | 0.0% |

The step at 45 s is `KEEPALIVE_IDLE_TERMINATE_MS` releasing the extract pool, exactly as
TRA-971 intended. It is flat afterwards to the sample resolution, at 0.0% CPU. The
`-420 MB` this document predicted in 2026-09-04 and could not confirm is real: **624 → 301
MB, -323 MB, and the remainder never accumulates.**

Repeating with four projects registered (four full trace-mcp checkouts):

| | RSS |
|---|---|
| peak during the concurrent index | 1 222 MB |
| settled, flat | 478 MB |

So, from two points: **base ≈ 242 MB + ≈ 59 MB per loaded project**, and a transient peak
during concurrent indexing of ~2.6× the settled floor.

### The ceiling

A flat number is the wrong shape — this daemon is asked to hold 1 project on one machine
and 23 on another. The ceiling scales with what it was asked to hold:

> **`idle_rss_mb ≤ 250 + 75 × projects_loaded`**, measured ≥ 45 s after the last indexing
> work finishes, with CPU at 0.0%.

Measured today: 301 MB against a 325 MB ceiling at N=1; 478 MB against 550 MB at N=4.
Both inside, with ~10% of headroom. The 75 MB slope is the measured 59 MB plus room for
repositories larger than this one — this corpus is 2 240 files, and field repositories run
several times bigger, so the slope is a floor and must be re-measured on a large repo
before it is quoted as a general law.

This replaces the flat `tree_rss_idle_mb > 500` trigger in the autopilot brief, which
cannot be right: at four ordinary projects a correctly-behaving daemon exceeds it.

### The number that was wrong for three weeks: 949 MB was never an idle measurement

The 949 MB median at the top of this document, and every figure since derived by filtering
`Daemon vitals` on `projects_indexing == 0`, is a mix of idle and busy samples.

`projects_indexing` was computed only from `ManagedProject.status`, which
`project-manager.ts` sets on the **initial load** path.
`reindex-file-handler.ts` — every incremental reindex, which is what a daemon on an active
machine spends its day doing — *requires* status `ready` to proceed (it returns 503
otherwise) and never changes it. By construction, incremental reindex work could not
appear in the counter.

Observed directly on 2026-09-07: daemon pid 2113 logged **264 vitals samples, 264 of them
reporting `projects_indexing: 0`**, over a 4.5 h window that includes the moment
`/health` timed out with no response at all after 5 s while the process burned 99.3% CPU
and held 1 454 MB. `sample(1)` on it put 4 652 of 7 519 main-thread samples — **62% of the
wall clock — inside synchronous `better-sqlite3` `sqlite3_step`** (`JS_run` 3 565,
`JS_all` 1 087) on the same thread that serves `/health`. The daemon called that idle.

Consequences worth stating plainly:

1. Filtered on the fixed counter, the honest single-project idle figure is **301 MB**, not
   949 MB. The old number was measuring indexing bursts and calling them rest.
2. The `922 MB` median this run first computed from the same filter is contaminated the
   same way, and is not published as an idle number here.
3. Any conclusion drawn from "idle" daemon RSS before v3.23.0 should be re-derived.

Fixed in this PR: `beginReindex()` / `countReindexingProjects()` in
`reindex-file-handler.ts` track in-flight single-file reindexes, and `getCounts` in
`cli.ts` adds them to `projects_indexing`. **Both** reindex paths are counted — the HTTP
handler and `register_edit` in `src/tools/register/core.ts`, which reindexes in-process on
the daemon's own MCP server and is the path CLAUDE.md tells every agent to call after
every edit. Covering only the HTTP path (as the first revision of this change did) would
have left the dominant share of a busy daemon's work still reporting idle. Guarded by
`src/daemon/__tests__/reindex-in-flight-vitals.test.ts`.

### Still open

`/health` returning nothing for 5 s while the main thread sits in synchronous SQLite is a
separate defect from the counter that hid it — a health endpoint starved by the work it
reports on. Not fixed here; filed separately.
