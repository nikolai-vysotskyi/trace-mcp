---
layout: default
title: Per-session baseline cost
permalink: /perf/session-baseline/
description: Internal working document. What one trace-mcp stdio session costs before it does any work, and where that cost comes from.
noindex: true
---

# Per-session baseline cost (TRA-925)

What one stdio session costs before it does any real work, and where that cost
actually comes from. Measured on macOS 15 / M5 Max, Node 22.22, trace-mcp
v3.18.0 (`61ba971a`), on a machine also running the daemon and other sessions
(so absolute numbers carry a few percent of noise; the split between the
components does not).

Harnesses in this repo:

- `scripts/perf/local-backend-baseline.ts` — starts one `LocalBackend` and
  reports start latency, RSS and thread count once `start()` resolves.
- `scripts/perf/session-index-cost.ts` — full index of a project through the
  session's own pipeline at a given `WORKERS=` count; reports wall time, peak
  RSS (worker threads included — they live in the session's RSS) and threads.
- `scripts/perf/extract-worker-rss.mjs` — per-worker RSS (TRA-811).

## Measured baseline

| Scenario | RSS | Threads | start() |
|---|---|---|---|
| Fresh stdio session, trivial project, 15 s after `initialize` (`dist/cli.js serve`) | 216 MB | 12 | — |
| `LocalBackend` read-only (dangerous root), 2 s after start | 233 MB | 13 | 120 ms |
| `LocalBackend` full mode on this repo, 2 s after start | 349 MB | 14 | 84 ms |
| Full index of this repo (2 285 files, 11 180 symbols), peak | 390–450 MB | 11 | 9–15 s |

The 884 MB / 21 threads in the TRA-925 report is not the *baseline* — it is a
session that has been indexing. Sessions in the field were observed at
386–864 MB after minutes of work; a fresh one starts at ~216 MB.

## Where the baseline goes

Per-step RSS of the session bootstrap (`src/` via tsx; process boots at 73 MB):

| Step | ΔRSS | Δt |
|---|---|---|
| import config module | +20 MB | 62 ms |
| loadConfig() | +1 MB | 7 ms |
| import db + `initializeDatabase` + `Store` | +6 MB | 16 ms |
| **import PluginRegistry (pulls all language + integration plugins)** | **+65 MB** | **158 ms** |
| `PluginRegistry.createWithDefaults()` | +0.1 MB | 1 ms |
| `ProgressState`, `ExtractPool`, `IndexingPipeline`, `FileWatcher` | +0.2 MB | 3 ms |
| import indexing pipeline module | +6 MB | 32 ms |
| `createAIProvider` | +0.7 MB | 7 ms |

Same shape in the shipped bundle: `import('./dist/index.js')` alone costs
**116 MB RSS / 327 ms**, before a single object exists.

Two conclusions, both of which contradict the issue's original diagnosis:

1. **Eager construction of the full stack costs ~7 MB and ~21 ms**, not
   "~500 ms". Making it lazy behind the `readOnly` decision would buy ~3 % of
   the baseline. Not worth the branching.
2. **`ExtractPool` spawns no worker threads at construction** — spawn is lazy
   since TRA-811 (first `extract()`), so a read-only or proxying session never
   pays for workers at all. Guarded by
   `tests/perf/extract-pool-lazy-spawn.test.ts`.

The real per-session floor is **module-graph evaluation** — every session
evaluates the whole 11.8 MB bundle. The language-plugin barrel
(`src/indexer/plugins/language/all.ts`, ~120 plugins) is the largest single
slice: making it a dynamic import cuts `dist/index.js` load from 155 MB / 327 ms
to 145 MB / 218 ms.

Useful finding for whoever does that work: **esbuild wraps dynamically-imported
internal modules in a lazy `__esm` initializer even with `splitting: false`**,
so deferring evaluation does not require changing the bundle shape — only
turning the static import into `await import()` and threading the await through
the (few) language-plugin call sites.

## Worker count is not the lever on this corpus

`WORKERS=` 1 / 2 / 4 over 2 285 files: 9–15 s wall and 390–450 MB peak in every
configuration, with the spread dominated by machine noise. Peak RSS during a
real index is dominated by the main-thread pipeline, not by pool size — even
though an idle keepAlive worker holding parsed grammars costs ~62 MB
(`extract-worker-rss.mjs`, 4 workers: +154 MB spawned, +249 MB after one parse
each). Cutting the default pool size would trade throughput for nothing
measurable here.
