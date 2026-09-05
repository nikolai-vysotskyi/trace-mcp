---
layout: default
title: Per-session baseline cost
permalink: /perf/session-baseline/
description: Internal working document. What one trace-mcp stdio session costs before it does any work, and where that cost comes from.
noindex: true
---

# Per-session baseline cost (TRA-925)

What one stdio session costs before it does any real work, what it costs once
it starts indexing, and where each of those goes. Measured on macOS 15 / M5
Max, Node 22.22, trace-mcp v3.18.0 (`61ba971a`), on a machine also running the
daemon and other sessions — absolute numbers carry a few percent of noise, the
split between components does not.

Harnesses in this repo (all require `pnpm run build` first — unbundled runs
resolve no extract-worker entry and silently measure in-process extraction
instead):

- `scripts/perf/local-backend-baseline.ts` — one `LocalBackend`; start latency,
  RSS and threads at the instant `start()` resolves and again 2 s later.
- `scripts/perf/session-index-cost.ts` — full index at a given `WORKERS=`;
  wall time, peak RSS (worker threads included — they live in the session's
  RSS) and peak threads.
- `scripts/perf/extract-worker-rss.mjs` — per-worker RSS (TRA-811).

## Measured baseline

| Scenario | RSS | Threads | start() |
|---|---|---|---|
| Session proxying to a healthy daemon, peak over 65 s (`dist/cli.js serve`) | 166–174 MB | 12 | — |
| `LocalBackend` read-only (dangerous root), at `start()` and 2 s later | 217–276 MB | 12–13 | 87–144 ms |
| `LocalBackend` full mode on this repo, **at `start()`** | 222 MB | 14 | 101 ms |
| Same, 2 s later — background `indexAll()` in flight, not a baseline | 350 MB | 14 | — |
| Full index of this repo (2 285 files / 11 180 symbols), 4 workers, peak | 836–881 MB | 15–20 | 4.3–5.6 s |

**The 884 MB / 21 threads in the TRA-925 report reproduces exactly — but it is
not a baseline.** It is a session in the middle of indexing with a four-worker
extract pool. A session that has not indexed sits at ~170–220 MB / 12–14
threads.

## Where the baseline goes

Per-step RSS of the session bootstrap (`src/` via tsx; process boots at 73 MB):

| Step | ΔRSS | Δt |
|---|---|---|
| import config module | +20 MB | 62 ms |
| `loadConfig()` | +1 MB | 7 ms |
| import db + `initializeDatabase` + `Store` | +6 MB | 16 ms |
| **import PluginRegistry (pulls all language + integration plugins)** | **+65 MB** | **158 ms** |
| `PluginRegistry.createWithDefaults()` | +0.1 MB | 1 ms |
| `ProgressState`, `ExtractPool`, `IndexingPipeline`, `FileWatcher` | +0.2 MB | 3 ms |
| import indexing pipeline module | +6 MB | 32 ms |
| `createAIProvider` | +0.7 MB | 7 ms |

Same shape in the shipped bundle: `import('./dist/index.js')` alone costs
**116 MB RSS / 327 ms**, before a single object exists.

So the two mechanisms TRA-925 blamed for the baseline are not it:

1. **Eager construction of the full stack costs ~7 MB and ~21 ms**, not
   "~500 ms". Deferring it behind the `readOnly` decision would buy ~3 % of the
   baseline; the comment claiming otherwise is corrected in
   `src/daemon/router/local-backend.ts`.
2. **`ExtractPool` spawns no worker threads at construction** — spawn is lazy
   since TRA-811 (first `extract()`), so a read-only or proxying session never
   pays for workers at all. Guarded by
   `tests/perf/extract-pool-lazy-spawn.test.ts`.

The per-session *floor* is module-graph evaluation: every session evaluates the
whole 11.8 MB bundle. The language-plugin barrel
(`src/indexer/plugins/language/all.ts`, ~120 plugins) is the largest single
slice — making it a dynamic import cut `dist/index.js` load from 155 MB /
327 ms to 145 MB / 218 ms in a throwaway build. Useful finding for whoever does
that work: **esbuild wraps dynamically-imported internal modules in a lazy
`__esm` initializer even with `splitting: false`**, so deferring evaluation
does not require changing the bundle shape — only turning static imports into
`await import()` and threading the await through the call sites.

## Worker count is the lever once a session indexes

Full index of this repo, two runs per configuration:

| Workers | Wall time | Peak RSS | Peak threads |
|---|---|---|---|
| 4 (previous session default) | 4.3 s / 5.6 s | 836 MB / 881 MB | 15 / 20 |
| 2 (**current session default**) | 6.2 s / 7.6 s | 630 MB / 634 MB | 13 / 13 |
| 1 | 9.8 s / 10.7 s | 448 MB / 450 MB | 12 / 12 |

Each live worker holds its own V8 isolate, tree-sitter WASM and every grammar
it has touched — ~62 MB after one parse (`extract-worker-rss.mjs`: 4 workers,
+154 MB spawned, +249 MB after one parse each). Those threads are inside the
session's RSS, which is why a four-worker session reaches 880 MB.

`LocalBackend` therefore runs **2** workers instead of `min(4, cpus/2)`
(`SESSION_EXTRACT_WORKERS`): −205 MB and −7 threads per indexing session for
+1.9 s of one-off indexing on this corpus. A fallback session indexes one
project for one client, and during a daemon outage every client runs one — nine
of them at 4 workers is ~7.9 GB, which is the ~6 GB originally reported. The
daemon, which indexes on behalf of everyone, keeps its 4-worker pool, and an
explicit `indexer.workers` still wins over both.

Cost of the trade: on a repository several times this size the extra wall time
scales with it (roughly +40 % of index time), and it is paid once per session
start in the daemonless path only. Sessions proxying to a healthy daemon index
nothing and are unaffected.

## Earlier revision of this document was wrong here

The first version of this page reported "worker count is not the lever: 1 / 2 /
4 all land at 9–15 s and 390–450 MB". That measurement ran under `tsx`, where
`resolveWorkerEntry()` finds no `extract-worker.js` next to the source module,
so `pool.available` was `false` and all three configurations silently ran
single-threaded in-process extraction — the numbers were three repeats of the
same run. Caught in review by Reviewer B. The harness now requires an explicit
built worker entry and throws when the pool is unavailable, so that failure
cannot recur silently.
