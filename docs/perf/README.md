---
layout: default
title: Desktop app performance baseline
# Without this, Jekyll publishes this file at /perf/README.html and GitHub
# Pages stops serving it as the directory index, so /perf/ — the URL that
# already existed — starts returning the "Page not found" body under a 200.
permalink: /perf/
description: Internal working document. Measured performance history for the trace-mcp desktop app.
noindex: true
---

# Desktop app performance baseline

Machine-readable history lives in [`baseline.json`](./baseline.json) — append one `runs[]`
entry per measurement pass, never rewrite an old one. This file is the human summary.

## Current numbers (3.10.0, `d0633c51` — secondary tabs split, macOS 26.5 / arm64, median of 3)

| Metric | Value | Ceiling | Status |
|---|---|---|---|
| `renderer_fcp_ms` | 156 | — | ok — **the startup metric of record** |
| `cold_start_ms` | 613 | 3000 | ok, but load-sensitive (see below) |
| `window_interactive_ms` | 330 | — | load-sensitive, do not trend it |
| `heap_idle_mb` (5 min idle) | 9.5 | — | ok |
| `main_cpu_idle_pct` | 0 | 2 | ok |
| `renderer_eager_kb` | 2012 | — | **the size metric of record** (see below) |
| `renderer_bundle_kb` | 2271 | — | total size on disk across all lazy chunks |
| `artifact_mb` | 5.8 / 478.0 | ×1.5 growth | unpacked grew from 268.1 MB (1.783×) due to TRA-438 server-payload (tracked in TRA-605) |
| `tree_rss_idle_mb` | 351.1 | — | isolated daemon idle baseline |
| `tree_rss_peak_mb` | 458.0 | — | peak during indexing & embedding pipeline |
| `tree_cpu_peak_pct` | 314.9% | — | multi-core worker indexing utilization |
| `rss_after_index_settle_mb` | 621.4 | — | settled RSS with full repo code graph |
| `ui_p95_ms` | 2.1 | — | 10-query p95 latency (median 0.5 ms) |

### Which size number to trend

`renderer_bundle_kb` is every byte in `dist/renderer`. Splitting a tab behind
`React.lazy` moves bytes out of the startup path but leaves that total untouched, so on
its own it scores code-splitting as a no-op. `renderer_eager_kb` — the entry script plus
everything `index.html` preloads — is what the window actually downloads before it can
render. **Trend `renderer_eager_kb`**; keep `renderer_bundle_kb` as the total-weight check
(it still catches a dependency that grew, wherever it landed).

### Which startup number to trend

`cold_start_ms` and `window_interactive_ms` are wall-clock across the harness's 20 ms
poll loop and its CDP round-trips. On a busy machine that inflates them by hundreds of
milliseconds while the app itself is unchanged — the 2026-08-29 run measured 349 → 1005 ms
on a machine at load average 11–22 and none of it was the product. `renderer_fcp_ms` is
read off the renderer's own clock after the fact and carries none of that, so **compare
`renderer_fcp_ms` across runs**; treat the other two as a sanity check against the 3 s
ceiling only.

When a run has to happen on a loaded machine, an interleaved A/B — alternating one sample
of each build, several rounds — cancels the drift that a back-to-back A-then-B run does not.

Controlled workload and daemon process-tree metrics (`tree_rss_idle_mb`, `tree_rss_peak_mb`,
`tree_cpu_peak_pct`, `rss_after_index_settle_mb`, `ui_p95_ms`) are measured via
`packages/app/scripts/measure-workload-baseline.mjs` against an isolated daemon instance on a
dedicated non-conflicting port (3749) with a throwaway `TRACE_MCP_DATA_DIR`, indexing the full
repository (824 files, 5610 symbols).

## How to take a measurement

```bash
pnpm run build                          # repo root — the workload indexes the fixture with this CLI
pnpm -C packages/app run build          # required — the harness measures the prod bundle
pnpm -C packages/app run pack           # optional — needed for artifact_mb
PERF_COMMIT=$(git rev-parse --short HEAD) \
  pnpm -C packages/app run perf -- --samples 3 --idle-seconds 300 \
                                     --workload --workload-minutes 30 --opens 20
```

Drop `--workload` for a startup-only pass (~6 min). With it the run takes ~40 min and
adds `ui_p95_ms`, `heap_after_workload_mb` and `heap_growth_mb_per_hour`.

The harness ([`packages/app/scripts/perf-measure.mjs`](../../packages/app/scripts/perf-measure.mjs))
launches the built app against a throwaway `--user-data-dir`, drives it over CDP, and
prints a ready-to-paste `runs[]` entry. `cold_start_ms` is process spawn → `#root` has
painted real content; `window_interactive_ms` is the renderer's own share of that.

## The fixed workload

The three workload metrics are only comparable if the scenario is byte-identical
between runs, so the harness does not improvise one. It checks this repo out into a
detached git worktree at the commit pinned in
[`packages/app/scripts/perf-fixture.json`](../../packages/app/scripts/perf-fixture.json),
indexes it with this checkout's own `dist/cli.js`, registers it with the daemon, drives
it, and unregisters it again at the end. The worktree lives at
`~/.trace-mcp/perf-fixture/<commit12>` — deliberately outside any checkout, because the
daemon reroutes a registration for a path under an already-registered project to that
parent, which would silently point the workload at the wrong repo. Remove it with
`git worktree remove ~/.trace-mcp/perf-fixture/<commit12>` when you want a cold fixture.

**The action script — do not change it without bumping `revision` in the pin file.**

1. **open project** — navigate the window to `?view=project&root=<fixture>`; done when the
   Overview pane has painted its `Files indexed` / `Symbols` rows.
2. **switch to Graph**, then wait until a probe query returns at least one match — the
   GPU graph has to have loaded its nodes before searching means anything.
3. Repeat until the duration is up, one **cycle** per iteration:
   - **10 searches** — the graph typeahead, the 10 queries in `queries` in pin order.
   - **3 view switches** — the `views` list (`Overview → Activity → Graph`); the cycle
     ends back on Graph so the next cycle's searches have an input to type into.
   - one post-GC heap sample (`HeapProfiler.collectGarbage` + `Runtime.getHeapUsage`).

`--opens N` runs N extra open-project navigations up front, purely for that action's
latency; they cannot be part of the cycle loop because each reload resets the heap and
would hide exactly the leak the loop is looking for. The first open is a discarded
warm-up (it also pays for the daemon loading the fixture index).

How each number is derived:

- **`ui_p95_ms`** — the worst of the three per-action p95s, not the p95 of all actions
  pooled: there are ~100x more searches than opens, so a pooled percentile would just be
  the search p95 and a slow project-open would never surface. Per-action medians and p95s
  are in `workload.actions` in the JSON.
- An action's duration is measured in the renderer's own `performance` clock, from the
  click/keystroke until the DOM stops mutating for 120 ms (capped at 5 s) — not until
  the first paint. Switching to the Graph tab paints an empty canvas within a few
  milliseconds and then does the real work; first-paint timing reports single-digit
  milliseconds for every action and would never catch a regression.
- **`heap_after_workload_mb`** — the post-GC heap after the first complete cycle.
- **`heap_growth_mb_per_hour`** — least-squares slope of the post-GC heap series over the
  whole run. Over 50 is an issue on its own, whatever the delta to the previous run.

The workload window is launched with `--disable-background-timer-throttling`,
`--disable-backgrounding-occluded-windows` and `--disable-renderer-backgrounding`; an
occluded renderer has its timers throttled, which stalls the driver rather than merely
slowing it. Startup samples deliberately do not get those flags.

Every number is a median of 3 samples. A single sample is never a regression.
Compare against the median of the last 5 runs: >+10% is a warning to note, >+25%
(or two consecutive warnings) is a regression worth an issue.

## Changes worth remembering

**2026-09-01 — code-splitting secondary project tabs (Activity, Insights, Memory, Notebook).**
Following the Ask tab split in 3.6.0, non-default project views (`Activity`, `Insights`,
`MemoryExplorer`, `Notebook`) were still statically imported into `App.tsx` and bundled into
the main renderer entry chunk (1172.19 kB / gzip 337.40 kB). Splitting them behind `React.lazy` while
keeping the primary default views (`Workspace`, `Clients`, `Settings`, `ProjectOverview`) eager
reduced the entry chunk to 1082.74 kB / gzip 314.80 kB (-89.45 kB raw / -22.60 kB gzip) and moved
90 KB out of the initial startup payload (`renderer_eager_kb` 2102 → 2012 KB). Startup FCP
remains fast at 156 ms (median of 3). Multi-tab scaling verified via `tabs-scale.mjs` (1 tab: 571 ms,
2 tabs: 580 ms, 0 idle daemon reqs/s, 0% CPU, clean memory deallocation upon closing tabs). Unpacked macOS
artifact growth (268.1 MB → 478.0 MB, 1.783×) caused by the TRA-438 embedded daemon payload in
`Contents/Resources/server` is tracked in issue TRA-605 for payload audit and pruning follow-up.

**2026-08-30 — the Ask tab was carrying the markdown stack into startup.**
`renderer_bundle_kb` had gone 1461 → 1700 → 2272 KB, with the entry chunk alone at
1316 KB. Attributing the entry chunk's source map by module: 24% of it was
`react-markdown` + `remark-gfm` and their micromark/mdast/unified trees, imported by
exactly one file, `tabs/AskTab.tsx`. `React.lazy` on that tab moved 168 KB out of the
eager payload (entry 1316 → 1148 KB, `renderer_eager_kb` 2270 → 2102). FCP did not move
— 216 ms after vs 168 ms measured pre-fix on the same machine an hour earlier, both
inside the run-to-run spread — which is the same result the cosmos.gl experiment got:
on this app, bytes off the entry chunk buy bytes, not milliseconds. Worth doing anyway
because the metric it improves is the one the user pays on every window open, and
`renderer_eager_kb` exists so the next run can see it.

**2026-08-28 — artifact 286 MB → 265 MB, `app.asar` 21.8 MB → 1.6 MB.**
`electron-builder` auto-includes the production `node_modules` tree even when `files`
doesn't list it. That shipped 27.5 MB of `@luma.gl`, `@cosmos.gl`, `d3-*`, `micromark`
and friends into every release — all of which Vite had already bundled into
`dist/renderer`. The main process imports nothing but Node builtins and `electron`, so
`!node_modules/**` is safe. The `menubar` dependency was unused and was dropped.

**2026-08-29 — the redesign and i18n cost nothing at startup (negative result).**
Interleaved A/B of `9459d4ce` (the 2026-08-28 baseline), `9cdccf9b` (pre-i18n) and
`6ebbbd56` (HEAD), 7 rounds of one sample each: median FCP 288 / 300 / 284 ms. The whole
macOS 26 redesign and the i18n runtime are invisible in renderer boot. The same rounds
read on `window_interactive_ms` claimed +188%, which was the harness, not the app — that
is why `renderer_fcp_ms` exists.

**2026-08-29 — `app.asar` 1.6 MB → 5.8 MB → 4.85 MB.**
TRA-257's blanket `!node_modules/**` had to become an explicit `node_modules/**` include
so the main process keeps `electron-updater` on Windows. That re-admitted every production
dependency, and the i18n work made `react-i18next` (1.0 MB) plus its `@babel/runtime` tree
(1.1 MB) production dependencies even though Vite already bundles them into
`dist/renderer` — 3.6× growth, past the ×1.5 ceiling. `react-i18next` moved to
devDependencies. The remaining 4.85 MB is genuine main-process runtime. The rule is now a
test: `packages/app/src/main/__tests__/packaged-deps.test.ts` fails if a package lands in
`dependencies` without the main process importing it.

**2026-08-28 — lazy-loading the graph view is not worth it (negative result).**
`@cosmos.gl/graph` is 702 KB and loads eagerly: `GraphExplorerGPU` is a static import
of `App.tsx`, so Vite hoists the chunk into the entry graph with a `modulepreload`.
Replacing the built chunk with a stub moved cold start 439 → 417 ms (~5%, ~22 ms) and
the renderer share 154 → 144 ms. Not enough to justify splitting the ref-carrying
component behind `React.lazy`. Revisit only if cold start approaches the 3 s ceiling.

## Tab scaling

`packages/app/scripts/tabs-scale.mjs` answers one question: does the app get slower the
more project tabs are open? A project tab on macOS is a whole `BrowserWindow` in a native
tab group, so N tabs means N renderer processes against one daemon.

```bash
pnpm run build && pnpm -C packages/app run build
node packages/app/scripts/tabs-scale.mjs --idle 30 --steps 1,3,6 --json out.json
```

It runs the daemon under test on a private port with a throwaway `TRACE_MCP_DATA_DIR` and
rewrites every renderer request to `:3741` onto it over CDP. That is not fussiness: the
renderer hardcodes `http://127.0.0.1:3741` in six files, and on a working machine that
port is held by whichever daemon got there first, usually mid-reindex over a large
registry. Measuring against it measures the machine, not the variable under test.

**2026-08-30 — the fifth project tab could not load at all (TRA-526).**
`useDaemon` opened an `EventSource` per window and held it forever. Chromium allows six
connections per host and the daemon is one host, so the streams alone exhausted the pool:
from the sixth window on, every fetch to the daemon queued behind them and timed out after
`DAEMON_FETCH_TIMEOUT_MS`. Measured, 1→7 project tabs, time from "open this project" to
its Overview showing real data:

| project tabs | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| before | 1828 ms | 589 | 580 | 589 | **never** | **never** | **never** |
| after | 1828 ms | 589 | 590 | 587 | 598 | 601 | 594 |

"never" is a 60 s give-up, with the daemon answering a Node client on the same box in 1 ms
throughout — the stall was entirely client-side. The fix gates both `EventSource`
subscriptions on `document.visibilityState`; on macOS only the selected tab is on screen,
so the socket count is one regardless of tab count. Guard:
`packages/app/src/renderer/__tests__/daemon-sockets.test.tsx`.

What still scales with tab count, and always will: ~5.7 MB JS heap and ~150 MB RSS per
tab, because each tab is a renderer process. Idle CPU, idle daemon requests and
interaction latency in the front tab are flat, and closing tabs returns heap, RSS, timers
and streams to the one-tab baseline — there is no leak.
