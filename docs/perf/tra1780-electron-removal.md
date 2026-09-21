---
layout: default
title: Electron removal-purge cost (TRA-1780)
permalink: /perf/tra1780-electron-removal/
description: Internal working document. Measured cost of the TRA-1780 electron removal purge.
noindex: true
---

# TRA-1780 — electron removal-purge cost

Measurement-only (no public-surface claim, no preregistration bar): how much
the two-part removal fix costs per indexing run.

## What changed

- Part A (`src/indexer/file-persister.ts`): the fast symbol path now deletes
  outgoing edges for the re-persisted file (previously only outgoing
  `imports`, and only when the new file still had imports) and re-saves
  persist-time `otherEdges` (Python `py_inherits`/`py_uses_decorator`), which
  no resolver re-emits. The resolve pass re-emits the rest of the current
  set, so comment-only edits land on row-identical edges.
- Part B (`src/indexer/edge-resolvers/electron-removals.ts`, new stage
  `resolveElectronRemovalEdges` right after framework Pass-2 emission):
  verifies electron cross-file edges whose precondition may have changed and
  deletes the stale ones, re-emitting a replacement when the channel pick
  moved to another live provider. No MCP contract change, no on-disk schema
  change (delete + insert of rows a full scan would produce).

## Setup

Corpus: `tests/fixtures/electron-app` (4 files), cold start, then scoped
`indexFiles` runs. Machine: MacBook Pro, arm64, bun/sqlite local.
Stage timing via `TRACE_MCP_LOG_LEVEL=debug` (`timed('electron-removals')`).

## Results (wall clock per pipeline run)

| run | indexed | duration |
| --- | --- | --- |
| cold `indexAll` | 4 | 58.8 ms |
| zero-change `indexFiles` (hash-skipped) | 0 | 15.8 ms |
| comment-only change (fast path + re-emit) | 1 | 12.4 ms |
| add invoke (scoped) | 1 | 12.0 ms |
| add handle (scoped) | 1 | 11.0 ms |
| remove handle (purge deletes 1 stale edge) | 1 | 11.4 ms |
| forced `indexAll(true)` | 4 | 21.4 ms |

`electron-removals` stage alone: 0.16–0.46 ms per run (0.4 ms on the cold
full pass, ~0.2 ms on scoped runs) — two indexed SELECTs over electron edge
rows plus content scans bounded by the files owning electron edges. Runs with
no electron edges exit after the first SELECT; zero-change runs never reach
the stage (`resolveAllEdges` short-circuits before the resolver stages).

## Correctness evidence (not just timing)

- New `tests/integration/electron-removal-parity.test.ts` (3 tests):
  remove-handler and remove-listener delete the cross-file edge in scoped
  runs with `scoped == indexAll(true)` edge sets; winner removal re-targets
  to the surviving provider, also `scoped == full`.
- Existing `electron-scoped-parity` (add-direction) + `electron-e2e` green;
  comment-stability case green (Part A re-emit is row-identical).
- Full suite: 1032 files / 11623 tests green. `replay:check`: nDCG/MRR/Recall
  1.0000 vs baseline 1.0000, Δ=0. `tsc --noEmit` clean, `biome check` clean.
