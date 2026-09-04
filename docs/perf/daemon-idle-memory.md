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
