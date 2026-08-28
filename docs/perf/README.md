# Desktop app performance baseline

Machine-readable history lives in [`baseline.json`](./baseline.json) — append one `runs[]`
entry per measurement pass, never rewrite an old one. This file is the human summary.

## Current numbers (1.51.1, `9459d4ce`, macOS 26.5 / arm64, median of 3)

| Metric | Value | Ceiling | Status |
|---|---|---|---|
| `cold_start_ms` | 349 | 3000 | ok |
| `window_interactive_ms` | 121 | — | ok |
| `heap_idle_mb` (5 min idle) | 9.5 | — | ok |
| `main_cpu_idle_pct` | 0 | 2 | ok |
| `renderer_bundle_kb` | 1461 | — | ok |
| `artifact_mb.mac_asar` | 1.6 | ×1.5 growth | ok |
| `artifact_mb.mac_app_unpacked` | 264.8 | ×1.5 growth | ok (Electron framework is ~263 MB of it) |

Not yet measured: `ui_p95_ms`, `heap_after_workload_mb`, `heap_growth_mb_per_hour`.
All three need a fixed indexed-project fixture so the workload scenario is identical
across runs — that's the next run's job.

## How to take a measurement

```bash
pnpm -C packages/app run build          # required — the harness measures the prod bundle
pnpm -C packages/app run pack           # optional — needed for artifact_mb
PERF_COMMIT=$(git rev-parse --short HEAD) \
  pnpm -C packages/app run perf -- --samples 3 --idle-seconds 300
```

The harness ([`packages/app/scripts/perf-measure.mjs`](../../packages/app/scripts/perf-measure.mjs))
launches the built app against a throwaway `--user-data-dir`, drives it over CDP, and
prints a ready-to-paste `runs[]` entry. `cold_start_ms` is process spawn → `#root` has
painted real content; `window_interactive_ms` is the renderer's own share of that.

Every number is a median of 3 samples. A single sample is never a regression.
Compare against the median of the last 5 runs: >+10% is a warning to note, >+25%
(or two consecutive warnings) is a regression worth an issue.

## Changes worth remembering

**2026-08-28 — artifact 286 MB → 265 MB, `app.asar` 21.8 MB → 1.6 MB.**
`electron-builder` auto-includes the production `node_modules` tree even when `files`
doesn't list it. That shipped 27.5 MB of `@luma.gl`, `@cosmos.gl`, `d3-*`, `micromark`
and friends into every release — all of which Vite had already bundled into
`dist/renderer`. The main process imports nothing but Node builtins and `electron`, so
`!node_modules/**` is safe. The `menubar` dependency was unused and was dropped.

**2026-08-28 — lazy-loading the graph view is not worth it (negative result).**
`@cosmos.gl/graph` is 702 KB and loads eagerly: `GraphExplorerGPU` is a static import
of `App.tsx`, so Vite hoists the chunk into the entry graph with a `modulepreload`.
Replacing the built chunk with a stub moved cold start 439 → 417 ms (~5%, ~22 ms) and
the renderer share 154 → 144 ms. Not enough to justify splitting the ref-carrying
component behind `React.lazy`. Revisit only if cold start approaches the 3 s ceiling.
