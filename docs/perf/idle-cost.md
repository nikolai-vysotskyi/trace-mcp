---
layout: default
title: Idle cost
permalink: /perf/idle-cost/
description: Internal working document. What trace-mcp costs while nothing is happening.
noindex: true
---

# Idle cost

An app that costs nothing when nothing is happening is a feature the user notices directly —
battery, fan, laptop temperature. TRA-935 made that a measured state instead of an assertion.

## How to repeat it

```bash
node scripts/perf/idle-cost.mjs --seconds 300 --interval 30 \
  --pattern "serve-http --port 3741" --json idle.json
```

It samples `ps` for every matching process and reports CPU seconds consumed and RSS growth over
the window. Watchers, poll loops, revalidation timers and telemetry flushes are inside the
measurement by construction — it reads the OS's accounting, not ours. It starts and kills
nothing; open the app, touch nothing, and read the numbers.

Match the pattern to what you mean. `--pattern trace-mcp` on a working machine catches every
stdio session and the desktop app as well as the daemon, and none of those are idle while an
agent is driving them.

## Measured 2026-09-05 — darwin 25.5.0 / arm64, v3.18.0 + TRA-935

Daemon (`serve-http`) over an isolated `TRACE_MCP_DATA_DIR`, one registered project (899 TS
files / 7 750 symbols), five minutes with nothing touching it:

| | |
|---|---|
| CPU consumed | **0.11 s over 301 s** — 0.04 % of one core |
| RSS | 303 MB → 33 MB (the idle-unload sweep evicting the project) |

Flat, and the RSS curve points down rather than up.

## Idle is not the only zero-work state

The expensive case was never a daemon with nothing to do — it was a daemon handed work that
turns out to be nothing. Every git-ignored write, every `config.exclude` match, every file
owned by a more-specific registered project arrives as a watcher/hook event and used to run
the whole incremental pipeline: ignore-matcher rebuilds, a change-scope build, a full search +
PageRank cache invalidation, and a wait on the pipeline lock behind whatever real indexing was
in flight.

Same machine, same project, 275 git-ignored writes over 60 s, daemon CPU consumed:

| | Before | After |
|---|---|---|
| CPU seconds | 0.26 | **0.13** |

And in isolation, with a full project pass holding the pipeline lock, one such event:

| | Before | After |
|---|---|---|
| median | 2 424.5 ms | **0.1 ms** |
| max | 3 013.5 ms | **2.7 ms** |

The before/after gap is dominated by lock-queue wait, which is also why `reindex-file`
telemetry used to report elapsed times in the hours: `elapsedMs` summed the wait with the work.
It is now the work alone, with the wait beside it as `queuedMs` (`daemon stats` renders it as
`queued p95`).
