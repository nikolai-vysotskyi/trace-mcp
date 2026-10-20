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

### Still open (2026-09-07)

`/health` returning nothing for 5 s while the main thread sits in synchronous SQLite is a
separate defect from the counter that hid it — a health endpoint starved by the work it
reports on. Not fixed here; filed separately as TRA-1763.

---

## 2026-09-21 — the counter covers the deferred paths too (TRA-1763)

TRA-1125 fixed the counter on the single-file paths only (HTTP handler +
`register_edit`). Field datum on daemon v3.31.0: a full storm window logged
`projects_indexing: 0` at 99% CPU and 926→1629 MB RSS — the deferred full
edge-reconcile (`fireEdgeReconcile` in `src/indexer/pipeline.ts`, timer +
`_lock`, outside every in-flight window) and the inline full-pass resolvers of
bulk indexes did the work, invisibly, after `status: ready`.

Fixed here: the pipeline holds a `beginReindex` mark for `indexAll`,
`indexFiles` (watcher batches included, so the >200-file bulk full-pass
fallback is covered), the deferred edge reconcile, and the deferred coverage
check. The registry moved to `src/indexer/reindex-inflight.ts` so the
pipeline can mark its own runs without an indexer→daemon import;
`daemon/reindex-file-handler.ts` re-exports it for the existing callers.
`getCounts` in `cli.ts` excludes marked roots from the status-based term, so
the initial load counts once, not twice. Guarded by
`src/indexer/__tests__/reconcile-in-flight-vitals.test.ts`.

> **Ceiling validity note:** `idle_rss_mb ≤ 250 + 75 × projects_loaded` is only
> meaningful on builds that include this fix. Any `projects_indexing == 0`
> sample taken on an older build can still mix idle and reconcile-busy, the
> same way pre-TRA-1125 samples mixed idle and reindex-busy.

### Still open: `/health` under a reconcile storm

The fair yields (TRA-1127) bound the wait *between* resolver stages to the
largest single synchronous span — but the spans themselves are whole SQLite
transactions on the main thread (the file-projection multi-JOIN
`INSERT…SELECT`, FTS rebuilds, `storeRawEdges` batches), each seconds long on
a large repo, back to back across a dozen projects. No handler-side change can
fix that: the loop is starved, not the handler. Honest options are a health
signal off the main thread or moving reconcile passes to a worker — the large
work this issue explicitly scopes out, tracked separately. Until then, a
`/health` latency spike during a reconcile storm is expected, and
`projects_indexing > 0` during the same window now says what it is: busy, not
idle.

---

## 2026-09-21 — reconcile passes time-slice (TRA-1764)

Follow-up to the TRA-1763 section above: the "Still open" health defect is
narrowed here, not closed. The fair yields (TRA-1127) bound the wait
*between* stages; this change bounds the stages themselves. The six heaviest
write passes (`esm-imports`, `ts/py/php-calls`, `test_covers`, file
projection) commit in chunks (`src/indexer/resolver-budget.ts`: 250 rows /
2000 id-span per transaction) with a fair yield between transactions, so the
longest synchronous span a health check can observe is one chunk, not the
whole pass. Guarded by `tests/indexer/resolver-budget.test.ts`, which asserts
a queued probe runs mid-pass, and by the unchanged full-vs-incremental edge
snapshot test (`tests/indexer/incremental-edge-resolution.test.ts`).

Field-style check (synthetic, not the 14-project original): 6000 src files +
300 test files, 30k edges, file-backed DB — worst event-loop block 71 ms
(bulk index), 12 ms (churn batch), 29 ms (deferred reconcile flush), all
under the 1 s health budget.

Residual: framework-plugin edges, `storeRawEdges`, FTS rebuilds, and the
smaller single-transaction resolvers still run whole-pass transactions — a
pathological single stage can still exceed 1 s on a very large repo. Moving
reconcile off the main thread remains the real fix, in its own issue.

---

## 2026-10-12 — Vue framework resolution stall (TRA-2352)

The v3.36.5 field log had repeated 22–26 s event-loop stalls during reindex.
The stalls fell between successive framework-edge storage logs. An isolated
process using a SQLite backup of the affected multi-workspace index (113
detected workspaces) attributed 17.5–17.6 s of one pass to
`vue-framework.resolveEdges`; `buildImportMap` alone took 13.3 s over about
3,000 Vue files. It rebuilt the complete component-path map for every Vue
file, an O(V²) walk, even when no template tag needed fallback resolution.
The main-thread timer could not run during that synchronous pass.

The resolver now builds the map once, retaining the last two distinct paths
per alias so excluding the current component keeps the prior collision
behavior. It also yields during the Vue-file and dynamic-reference loops.
On a separate backup of the same index, Vue resolution fell to 257 ms; the
whole framework pass's maximum observed event-loop lag was 614 ms, with no
20 s stall. Both backup runs ended with 139,129 edges. The regression test
queues a health-style timer during the pass and checks that the file list is
read only once. These are isolated measurements, not post-release field
evidence; repeat the live `lagMs` check after release without changing
`max_files` or treating `projects_indexing == 0` as proof of idleness.

---

## 2026-10-13 — exclude macOS sleep from stall attribution (TRA-2375)

`Slow SQLite statement blocked the event loop` reported
`ms: 368310` for `SELECT * FROM symbols WHERE file_id = ? ORDER BY byte_start`
at 01:59:00 +0400. The macOS power log shows sleep at 01:52:50 and dark wake
at 01:59:00, a 370-second gap. The slow-statement guard uses `Date.now()`
around the call, so its measurement includes suspended time. On the same
file-backed index, five read-only executions of that query for the file with
the most symbols (3,955) took 5.05–7.01 ms. The original call may have had
some real latency, but the 368-second warning is not evidence of continuous
SQLite work or an event-loop stall. Correlate any wall-clock stall with
`pmset -g log` before attributing it to indexing. TRA-2375 tracks a
sleep-aware diagnostic and a separate check of framework-plugin timeouts
observed around wake.

---

## 2026-10-15 — field baseline before the TRA-2434 release

Read-only observation of the installed v3.37.3 daemon (PID 93105, port 3741),
02:00–02:03:38 +0400. This build predates the merged scope-aware framework
resolution fix in TRA-2434 / PR #1603; the observation is **not** a verdict on
that fix.

In `~/.agy/3/.trace/daemon.log`, the window contains 15 `Event loop stall`
warnings (2,068–57,443 ms), all with `reindexInFlight: 2`; four
`resolveEdges` timeouts (Laravel 1, Blade 1, Vue 2); 501 watcher
`reindex-file` events; and two FSEvents drops. Vitals stayed near 1.94 GB RSS
with two projects indexing. A `GET /health` timed out after 3 s while the
process still owned the listening socket. `pmset -g log` has no sleep/wake
transition in that window, so the 57 s stall should not be dismissed as a
suspend-time artifact. The watcher events and FSEvents drops are concurrent
signals, not an established cause of the stalls.

After a release containing PR #1603 is installed, repeat the same bounded log
query and `/health` probe during comparable indexing work. Compare timeout
counts and stall duration, and keep `projects_indexing` in view: these are busy
samples and must not be used to test the idle RSS ceiling above.

---

## 2026-10-16 — the field daemon exceeds the idle RSS ceiling (TRA-2459)

Read-only observation of the installed v3.37.4 daemon, PID 74675. Between
2026-10-15 21:42:38 and 21:47:38 UTC, six consecutive one-minute vitals
samples had `projects_loaded: 3`, `projects_indexing: 0`, and RSS 1100–1102 MB
(heap used 584–587 MB). The stated ceiling at three loaded projects is
`250 + 75 × 3 = 475 MB`; this field window exceeds it by at least 625 MB.
The log contains no indexing start/completion or warning in the window. Its
seven watcher `reindex-file` telemetry records each indexed zero files and
took 0–1 ms. This is a stronger idle check than filtering a single vitals
sample, though it does not identify the retained objects.

`GET /debug/memory` later, after the daemon loaded five projects and resumed
indexing, reported 1509 MB RSS and 826 MB heap used. The session journal had
zero entries and its compact buffer used zero bytes; the tree cache reported
about 5.9 MB. Those later numbers are **not** an idle measurement. They only
rule out the already-capped journal and the visible tree cache as explanations
for the then-current heap size. TRA-2061 owns attribution of the remaining
growth. Until that investigation is resolved and the ceiling is remeasured on
a live build, treat `250 + 75 × projects_loaded` as an isolated-test target,
not an achieved field bound.

---

## 2026-10-17 — repeated no-change reindex stalls on v3.37.7

Read-only field observation of the installed v3.37.7 daemon (PID 69058,
port 3741). Five watcher events for the same `assetfeed` log file, spaced
about ten minutes apart, all reported `skippedHash: true`, `indexed: 0`, and
`queuedMs: 0–4`. Nevertheless, each `indexFiles` run took 11,829–14,345 ms.
Each run coincided with an `Event loop stall` warning of 6,939–9,126 ms and
`reindexInFlight: 1`. The repeated no-change input gives TRA-2456 a narrow
reproduction target: inspect why the postprocess shortcut is bypassed, then
profile the synchronous work that remains. The logs do not establish which
stage consumed the time or prove a client fallback in these five windows.

Memory remains above the field ceiling on this build. With three projects
loaded and `projects_indexing: 0`, consecutive one-minute vitals samples held
at 889–947 MB RSS and 342–348 MB heap used, versus the 475 MB target. These
samples were between the periodic reindexes, not during them. `/health`
returned HTTP 200 in 0.6 ms when probed outside a stall. TRA-2061 continues
to own memory attribution; these data do not identify retained objects.

---

## 2026-10-18 — idle RSS remains high on v3.37.8

Read-only observation of the installed v3.37.8 daemon (PID 19856). Four
consecutive one-minute vitals at 2026-10-17 21:55:58–21:58:58 UTC reported
`projects_loaded: 3`, `projects_indexing: 0`, and RSS 903–913 MB (heap used
389–399 MB). That is at least 428 MB above the `250 + 75 × 3 = 475 MB` idle
target. The next vitals sample at 21:59:59 had `projects_indexing: 1`, so it
is excluded from the idle window. The daemon was reachable at `/health` during
this run; no restart or configuration change was made. This confirms that the
field ceiling is still unmet after the v3.37.8 release, without identifying
the retained objects. TRA-2061 and TRA-2459 continue to own attribution and
remediation.

---

## 2026-10-19 — v3.37.10 field daemon remains above the idle target

Read-only observation of the installed v3.37.10 daemon (PID 41509). At
2026-10-18 21:56:32 UTC, the project sweeper logged five `Unloading idle
project` events. Vitals changed from eight loaded projects and 754 MB RSS
one minute earlier to three loaded projects and 737 MB RSS. Four consecutive
one-minute samples through 21:59:32 held at 737 MB RSS, 191–193 MB heap used,
`projects_loaded: 3`, and `projects_indexing: 0`. The three-project target is
`250 + 75 × 3 = 475 MB`, so the post-unload plateau exceeds it by 262 MB.
The log contains no full index in that interval. Its periodic `reindex-file`
records indexed zero files. These checks mean it is not the isolated 0% CPU
setup used to establish the target.

At 22:00 UTC, project loads and a dropped-event reconcile triggered full
indexing. The next vitals sample rose to 897 MB RSS / 327 MB
heap used; it is excluded from the quiet-window comparison. `/health` later
returned `ok` and version 3.37.10. The field gap predates that indexing burst.
TRA-2061 owns attribution; these observations do not isolate the retained
memory or demonstrate a new regression from v3.37.8. It does show that
unloading five idle projects released only 17 MB of RSS within four minutes.

---

## 2026-10-20 — session pins explain a higher project count, not the heap growth

Read-only observation of the installed v3.37.10 daemon (PID 58174) on
2026-10-19 21:46–22:03 UTC. The log's one-minute vitals rose from 13 loaded
projects / 3,479 MB RSS to 17 loaded / 3,960 MB RSS. In the final sample,
`projects_indexing: 1`, `sweep_pinned: 17`, and `sweep_evictable: 0`.
Several earlier samples had `projects_indexing: 0`, 15 loaded projects and
3,593 MB RSS. `GET /health` still returned `ok`. The 8-project setting is
a **soft eviction target**: `unloadIdleProjects` preserves projects with
live session references. A count above eight is therefore not, by itself,
proof that the sweep stopped working.

At 22:03 UTC, `GET /debug/memory` reported 17 resident projects, 74 MCP
session handles, 3,982 MB RSS and 2,313 MB main-thread heap used (V8 heap
used ratio 0.558). Its session-journal compact buffers totaled only 35 KB,
and the tree cache about 6.1 MB. Those two bounded caches cannot account
for the observed heap. The endpoint currently reports only aggregate session
and resource-pool counts, so this sample cannot establish which projects
were legitimately active or whether any session reference was leaked.
TRA-2061 remains the owner of heap attribution; use per-project refcounts
and session ages before treating the pins as a regression of TRA-1738.

These samples are **not an idle-memory baseline**: connected sessions pin
projects even while `projects_indexing` and instantaneous CPU are zero. Do
not apply the isolated `250 + 75 × projects_loaded` target to this window.
