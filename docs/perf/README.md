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

## Current numbers (3.11.0, `e8a0dd7c`, darwin 25.5.0 / arm64, median of 3)

Two passes on 2026-09-02, by the same autopilot, reconciled into one series: the
2026-09-01 entry that first filled the workload metrics, and this one, which repeats them
on the merged harness and adds the two rows marked new. Where they overlap they agree —
`ui_p95_ms` 668 / 690, `heap_growth_mb_per_hour` 1.39 / 0.19, `rss_after_index_settle_mb`
383 / 316 — which is the first independent confirmation these numbers have had.

The `artifact_mb` rows are from a separate artifact-only pack (3.11.0, `64b14a12`). Sizes
are deterministic, so they do not need a median.

| Metric | Value | Ceiling | Status |
|---|---|---|---|
| `renderer_first_content_ms` | 97 | — | **the startup metric of record** (new, new series) |
| `renderer_fcp_ms` | null | — | structurally unavailable offscreen — see below |
| `cold_start_ms` | 393 | 3000 | ok, load-sensitive |
| `window_interactive_ms` | 129 | — | load-sensitive, do not trend it |
| `ui_p95_ms` | 690 | — | search p95 690, open p95 144, switch p95 130 |
| `renderer_cpu_idle_pct.overview` | 2.9 | — | new |
| `renderer_cpu_idle_pct.graph` | **29.3** | — | **new — the Graph tab never idles**, TRA-683 |
| `heap_idle_mb` (5 min idle) | 15.4 | — | ok — see note below, not comparable to 9.5 |
| `heap_after_workload_mb` | 7.8 | — | ok |
| `heap_growth_mb_per_hour` | +0.19 | 50 | ok — no leak over 521 cycles |
| `tree_rss_idle_mb` (app + daemon) | 920 | — | ok vs 955 |
| `tree_rss_peak_mb` (app + daemon) | 1250 | 2000 | ok |
| `tree_cpu_peak_pct` (combined, sums cores) | 180 | — | ok |
| `rss_after_index_settle_mb` (daemon only) | 316 | 500 | ok settled — **but ~700 MB while serving, see below** |
| `main_cpu_idle_pct` | 0.1 | 2 | ok |
| `renderer_eager_kb` | 2131 | — | **the size metric of record** |
| `renderer_bundle_kb` | 2301 | — | +1.4% vs 2270 — noise |
| `artifact_mb.mac_app_unpacked` | 346.2 | x1.5 growth | re-anchored 2026-09-02, was 478.2 |
| `artifact_mb.mac_server_payload` | 77 | **100 MB, absolute** | ok |
| `artifact_mb.mac_asar` | 6 | x1.5 growth | ok |

**Open finding — the daemon costs ~700 MB to serve one small project.** With a fresh data
dir, a private port and exactly one registered project (this repo at the pinned fixture
commit, 1817 files / 9705 symbols), `serve-http` sat at 727 MB RSS idle and peaked at
1014 MB, dropping to 383 MB only after the app disconnected and ten minutes passed. That
reproduces, under control, the 884 MB the 2026-08-30 run saw on an ambient daemon and did
not file because that daemon's history was unknown. It is not history: one small project
really does cost that much resident while it is being served.

### The run never shows a window

Every pass launches the app with `TRACE_MCP_AGENT_RUN=1`, which leaves the window unmapped
(`HIDDEN_WINDOWS` in `src/main/tray.ts`). A 55-minute pass runs on the machine somebody is
working on and must not steal their screen or drag them off their Space.

The cost is that `first-contentful-paint` does not exist: Chromium emits a paint entry only
for a frame the compositor presented, and an unmapped window presents none. So
`renderer_fcp_ms` is null on every agent run. The replacement is
**`renderer_first_content_ms`** — a `performance.mark('app-first-content')` the renderer
sets itself when React commits the first content under `#root`
(`src/renderer/main.tsx`). Same clock, same absence of CDP round-trip, one step earlier in
the pipeline. **It starts a new series: 97 ms here is not comparable to the 136 ms
`renderer_fcp_ms` of the 2026-09-01 entry, which ran with a visible window.**

### The Graph tab burns 29.3% of a core with nobody touching it

`renderer_cpu_idle_pct` is renderer CPU over a 60 s window with **no input**, per view,
taken from `cputime` deltas — `ps -o %cpu` is a decaying lifetime average and cannot answer
"busy right now". Overview reads 2.9% of a core, Graph 29.3%; measured three times across
two harness versions on 2026-09-02 (27.0 / 27.7 / 29.3).

This is the `.cosmos-gpu-label` finding priced. The settle detector had to stop counting
that layer because it mutates every animation frame forever (~730 mutations/second with no
input); that established the tab never goes quiet, and this metric says what the quiet
costs. Tracked as TRA-683, not fixed here.

### `heap_idle_mb` moved 9.5 to 15.4 and it is not a leak

The runs before 2026-09-01 idled with no daemon reachable at all, so the renderer sat on an
empty app. This harness serves the fixture on a private port, so the idle window now holds
a real project's state. Compare `heap_idle_mb` only within a series that had a daemon.

### Which artifact number to trend

`mac_app_unpacked` is 76% Electron: `Contents/Frameworks` alone is 262.9 MB and no change
in this repo moves it. A x1.5 rule on that total tolerates the embedded daemon roughly
doubling before it fires, which is exactly what it did — TRA-438's server payload went in
at 209 MB and the growth only registered as "the app got 1.78x bigger". So
**`mac_server_payload` carries an absolute ceiling instead: 100 MB.** It is the only large
part of the bundle the repo controls, it is measured directly by the harness, and it is
the number to look at first when the total moves.

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
on a machine at load average 11–22 and none of it was the product. `renderer_first_content_ms` is
read off the renderer's own clock after the fact and carries none of that, so **compare
`renderer_first_content_ms` across runs**; treat the other two as a sanity check against
the 3 s ceiling only. `renderer_fcp_ms` is kept in the JSON for continuity with the runs
recorded before 2026-09-02, but is null on any run that does not show a window — which is
every agent run.

When a run has to happen on a loaded machine, an interleaved A/B — alternating one sample
of each build, several rounds — cancels the drift that a back-to-back A-then-B run does not.

### The workload no longer needs port 3741 (TRA-617)

For four consecutive runs `ui_p95_ms`, `heap_after_workload_mb` and
`heap_growth_mb_per_hour` were recorded as `null` with the same reason: a foreign daemon
owned 127.0.0.1:3741 for the whole run. The renderer's `BASE` is hardcoded to that port in
six files, so the harness used to wait up to four minutes for the port to come free and
then measure against whatever daemon held it — on a machine that runs a dozen agent
checkouts and a 20-project registry, that port is never free, and "wait for an
uncontended host" is a precondition that never arrives.

The harness now does what `tabs-scale.mjs` already did: it runs **its own daemon on a
private port (37412) against a throwaway `TRACE_MCP_DATA_DIR`**, and rewrites every
renderer request to `:3741` onto it over CDP (`Fetch.requestPaused` →
`Fetch.continueRequest` with a swapped port). Only daemon requests are intercepted;
assets and the `file://` document are untouched. The app's own watchdog still polls the
real 3741, so `TRACE_MCP_BIN` points at a no-op shim to stop it starting anything.

The consequence for reading the numbers: the daemon under test serves **one** project, the
pinned fixture, and nothing else. That is the point — it isolates the app from the
machine's registry — but it means `tree_rss_*` here are not comparable to the 2026-08-28
daemon-memory entry, which measured a daemon holding 40 to 110 real projects.

**The same trap, one layer up: the CDP port.** The harness used to hardcode
`--remote-debugging-port=9333` and attach to the first page target it found there. A Chrome
started by `chrome-devtools-mcp` with the same debugging port already owned it, so the run
attached to a *Chrome tab*, drove that, and reported `cold_start_ms: 23` and
`window_interactive_ms: 16327` without complaining once. Each launch now takes a free port
from 9333–9353 and then checks that the process listening on it is inside its own child's
process tree, failing the run outright if it is not. A perf harness that silently measures
the wrong process is worse than one that does not run.

## How to take a measurement

```bash
pnpm run build                          # repo root — the workload indexes the fixture with this CLI
pnpm -C packages/app install            # packages/app is a separate package, not a pnpm workspace
pnpm -C packages/app run build          # required — the harness measures the prod bundle
pnpm -C packages/app run pack           # optional — needed for artifact_mb
PERF_COMMIT=$(git rev-parse --short HEAD) \
  pnpm -C packages/app run perf -- --samples 3 --idle-seconds 300 \
                                     --workload --workload-minutes 30 --opens 10
```

Drop `--workload` for a startup-only pass (~6 min). With it the run takes ~55 min
(30 min of cycles plus a 10-minute daemon settle, `--settle-minutes`) and adds
`ui_p95_ms`, `heap_after_workload_mb`, `heap_growth_mb_per_hour` and the process-tree
set below.

### The process-tree metrics

Sampled every 5 s for the whole workload, across both trees under test — the Electron app
(main + renderer + GPU/network helpers) and the daemon (`serve-http` plus its index worker
processes; worker *threads* are counted inside their host process's RSS by `ps`).

| Metric | What it is |
|---|---|
| `tree_rss_idle_mb` | app + daemon RSS with the fixture indexed and served and nothing driven — a 60 s hold taken before the first project open |
| `tree_rss_peak_mb` | highest app + daemon RSS seen at any point in the run |
| `tree_cpu_peak_pct` | highest combined `%cpu` (sums over cores, so >100 is normal) |
| `rss_after_index_settle_mb` | daemon RSS after the app is gone and it has sat idle for `--settle-minutes`, still holding the fixture's index |

`workload.tree_series` keeps every fifth sample, so the shape over the run survives in
`baseline.json` without carrying 500 rows.

The harness ([`packages/app/scripts/perf-measure.mjs`](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/packages/app/scripts/perf-measure.mjs))
launches the built app against a throwaway `--user-data-dir`, drives it over CDP, and
prints a ready-to-paste `runs[]` entry. `cold_start_ms` is process spawn → `#root` has
painted real content; `window_interactive_ms` is the renderer's own share of that.

## The fixed workload

The three workload metrics are only comparable if the scenario is byte-identical
between runs, so the harness does not improvise one. It checks this repo out into a
detached git worktree at the commit pinned in
[`packages/app/scripts/perf-fixture.json`](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/packages/app/scripts/perf-fixture.json),
indexes it with this checkout's own `dist/cli.js`, registers it with the daemon, drives
it, and unregisters it again at the end. The worktree lives at
`~/.trace/perf-fixture/<commit12>` — deliberately outside any checkout, because the
daemon reroutes a registration for a path under an already-registered project to that
parent, which would silently point the workload at the wrong repo. Remove it with
`git worktree remove ~/.trace/perf-fixture/<commit12>` when you want a cold fixture.

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
- **Mutations inside `.cosmos-gpu-label` do not count** (pin `revision` 2, TRA-617). The
  GPU graph repaints its HTML label overlay every animation frame — measured at ~730
  mutations/second, unbroken, with no input at all — so the whole-document observer never
  saw 120 ms of quiet and every Graph-tab action ran to the cap. The first run to reach
  this code reported `ui_p95_ms` as exactly 5000 with a search median of 4987: the
  harness's ceiling, not the app. Scoping the observer past a permanent animation is not
  a leniency — an animation that never stops cannot signal that anything finished.
  The limit this leaves: WebGL drawing is invisible to a `MutationObserver` either way, so
  `switch_view` into Graph times the surrounding DOM, not the graph's own render. "The
  graph has actually loaded" is enforced separately, by the `matchCount() > 0` gate before
  the cycle loop starts.
- The **search median reads near zero and that is not a bug**: the graph typeahead filters
  nodes the renderer already holds, so the list updates within a few milliseconds of the
  keystroke. `ui_p95_ms` takes the worst per-action p95 precisely so a cheap action cannot
  hide an expensive one.
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

**2026-09-02 — four secondary tabs were sitting in the startup chunk (TRA-593).**
`Activity`, `Insights`, `MemoryExplorer` and `Notebook` were static imports in `App.tsx`, so
every window paid for them at cold start even though none of them is a default view. Moving
them behind `React.lazy` — the same treatment `AskTab` already had — took the entry chunk from
1,204.25 kB (gzip 345.32) to 1,114.87 kB (gzip 322.64), so 89.4 kB raw / 22.7 kB gzip leaves
the eager path (`renderer_eager_kb` 2184 to 2095, -4.1%). Both figures come from a clean
production `vite build` of the parent commit and this one on the same tree. The measurement
that matters here is the build output, not a trace: this moves bytes off the startup path, and
the tabs load on click instead. The guard is `lazy-tabs.test.ts` — `lazy()` names the export as
a string, so a rename type-checks fine and only breaks when a user clicks the tab.

**2026-09-02 — the harness may not take the user's screen, and that cost the startup metric.**
Two runs of this autopilot overlapped: one landed the private daemon port, the other found
the same `.cosmos-gpu-label` cause independently and priced it. They are merged rather than
one being discarded (#744 closed into #781) — the third time two agents have implemented the
same issue in parallel, and the first time the second copy was not thrown away. The lasting
change is that the app is now launched unmapped, because a 55-minute pass on a machine
somebody is working on cannot be allowed to steal focus. That deleted `renderer_fcp_ms`:
Chromium emits a paint entry only for a presented frame. The lesson generalises — a metric
read from the compositor cannot survive a harness that must not composite, and the fix was
to move the measurement into the app (`performance.mark('app-first-content')`) rather than
to show the window.

**2026-09-01 — the three workload metrics were never blocked on a quiet machine.**
Four entries in a row recorded `ui_p95_ms` / `heap_after_workload_mb` /
`heap_growth_mb_per_hour` as null, each blaming a foreign daemon on 3741 and each deferring
to a future uncontended host. That host does not exist on this machine and the wait was the
wrong fix: the harness needed to stop asking for a port it does not own. Giving it a private
daemon port plus a CDP request rewrite filled all three, and the process-tree set with them,
on a machine at load average 21.9 with the ambient 22-project daemon still holding 3741
throughout. Two harness defects fell out of finally running it end to end: `ui_p95_ms` read
exactly 5000 (the settle cap — see the `.cosmos-gpu-label` note above), and a hardcoded CDP
port let the harness attach to somebody else's Chrome and report a 23 ms cold start. Both
had been latent since TRA-258. The lesson is not about ports: a metric that has never once
produced a value is not a measurement, it is a plan, and it should be treated as untested
code until it prints a number.

**2026-09-02 — the embedded daemon was 209 MB, two thirds of it unreachable (TRA-605).**
`stage-server.mjs` staged whole npm packages, and npm packages carry things a packaged app
never runs. 92 MB were tree-sitter grammars the daemon cannot load: `tree-sitter-wasm`
ships 112, `LANG_GRAMMARS` in `src/parser/tree-sitter.ts` names 32, and systemverilog alone
— a language trace-mcp does not support — was 21 MB. 24 MB were better-sqlite3's sqlite3
amalgamation, its C++ sources and seven other platforms' prebuilds; unlike the
`@ast-grep/napi-*` packages, which the closure already narrows by `os`/`cpu`,
better-sqlite3 keeps all eight in one package and picks at runtime, so nothing was cutting
them. 10.3 MB were `dist/index.js`, which tsup emits as a second self-contained bundle for
the npm library entry and which nothing inside the payload can reach — the app enters it
only through `dist/cli.js`. Payload 209 → 77 MB, bundle 478.2 → 346.2 MB (−27.6%).
`PAYLOAD_GRAMMARS` in `stage-server.mjs` is the list, and `stage-server.test.ts` fails if
`LANG_GRAMMARS` grows past it — shipping a DMG with a grammar missing is invisible, because
every file in that language indexes as zero symbols rather than erroring (TRA-330).

**2026-09-02 — compressing the grammars is not worth it (negative result).**
The remaining 43 MB of `.wasm` brotli to 3.2% — 133 MB of the original set went to 4.3 MB —
because 98% of a grammar is its parse-table data section, which is enormously repetitive.
Spending that needs a decompressing shim around `getWasmPath` and a decision about where
the decompressed bytes live. Not taken: after pruning, the whole set is 43 MB against
262.9 MB of Electron, so the shim would buy ~11% of the bundle for a permanent runtime
indirection on every parser load. Reconsider only if the grammar set grows several times
over. `wasm-opt` is a separate dead end on the same files: there is no debug info to strip
and only 7.4 MB of the 133 was code section at all.

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
