---
layout: default
title: /health starvation during indexing
permalink: /perf/health-starvation/
description: Internal working document. Why the trace-mcp daemon stopped answering /health while indexing, and what bounds it now.
noindex: true
---

# /health starvation during indexing (TRA-1127)

Measured 2026-09-07 on an M-series MacBook Pro, Node 22, `trace-mcp` at
v3.22.0 + this change. Reproduce with `npx tsx scripts/probe-health-stall.ts`
(`PROBE_N=<projects>`); the regression guard is
`tests/daemon/health-starvation.test.ts`.

## What the field saw

The production daemon (21 projects loaded) did not answer `/health` for 5 s+
while reindexing, at 99% CPU. `sample` on the live process put 61.9% of main
thread samples inside synchronous `better-sqlite3` (`sqlite3_step` under
`Statement::JS_run` / `JS_all`), doing index seeks during writes. Once the
burst ended `/health` answered in 0.6–1.5 ms.

That matters beyond latency: a session that cannot reach `/health` concludes
the daemon is dead and starts its own full local index. A merely busy daemon
manufactures N independent indexers, which makes it busier — the failure
amplifies itself.

## The mechanism is not "SQLite is synchronous"

The indexing paths already yielded with `setImmediate` between chunks. But
Node drains the whole check-phase queue before returning to poll, so N
concurrent indexers that each yield still stack N chunks into a single turn.
The window a pending health request waits for is the **sum** of every
project's chunk, not the largest one.

Isolated harness — a bare HTTP server plus N workers doing 40 × 50 ms
synchronous chunks with a yield between chunks. The table is from an ad-hoc
harness; the same property (window flat as N grows) is what the guard test
asserts:

| N workers | plain `setImmediate` p50 / max | fair yield p50 / max | wall |
|---:|---:|---:|---:|
| 1 | 100 / 151 ms | 100 / 152 ms | 2.0 s both |
| 5 | 500 / 753 ms | 100 / 152 ms | 10.0 s both |
| 21 | 2 100 / 3 152 ms | 100 / 152 ms | 42.0 s both |

Latency scaled linearly with the number of indexers; throughput is identical
either way, because they were sharing one thread regardless. 21 projects × the
real (larger) chunks is the 5 s the field measured.

## The fix

`yieldToEventLoopFair()` / `runInOwnTurn()` in `src/utils/event-loop.ts`: a
process-wide FIFO chain so each event-loop turn carries exactly one caller's
synchronous unit. Applied to the three units that dominate a reindex — the
persist transaction, each edge-resolver stage, and in-process extraction
chunks. The yield has to sit *immediately before* the unit; placed after it,
an intervening `await` (extraction workers) lets two projects' units share a
turn anyway.

## What it buys, on this repo (2 584 files, worker pool active)

| | before | after |
|---|---:|---:|
| 1 project, `/health` p99 / max | — | 241 / 322 ms |
| 4 projects, `/health` p99 / max | 420 / 768 ms | 379 / 640 ms |
| 4 projects, max loop delay | 757 ms | 637 ms |

The scaling term is gone; what remains is one monolithic unit. At N=4 every
observed stall is now attributable to a *single* call, the largest being
`EdgeResolver.resolveEdges` (~260–300 ms) and `resolveEsmImportEdges`
(~220 ms) — both single `db.transaction()` passes over the whole pending set.

## What is not fixed

`/health` p99 is bounded, not yet under 100 ms. The floor is the largest
single resolver transaction, and lowering it means chunking those
transactions, which changes when partial edge writes become visible. Tracked
separately — do not raise the client-side timeout instead.
