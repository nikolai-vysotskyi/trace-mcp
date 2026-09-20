---
layout: default
title: TRA-1608 ORT arena + watcher dedup measurements
permalink: /perf/tra1608-ort-arena-watcher/
description: Internal working document. ORT session-arena tuning and watcher-dedup measurements for TRA-1608.
noindex: true
---

# TRA-1608: ORT arena tuning + watcher dedup — measurements

Measurement-only note (no preregistration bar; raw rows in
[`tra1608-ort-arena.json`](./tra1608-ort-arena.json) and
[`tra1608-watcher-stand.json`](./tra1608-watcher-stand.json)).
Machine: darwin 27.0 arm64, node v22.22.3. Commit `23db2d8f` + this change.

## 1. ORT session tuning: negative result, shipped as a neutral default

Tuned mode passes `session_options: { enableMemPattern: false }` to the
transformers.js pipeline (rollback: `TRACE_MCP_ONNX_ARENA=default`).
Measured on Xenova/all-MiniLM-L6-v2 (q8) via @huggingface/transformers 4.2.0,
fresh process per sample:

- Short texts (50 × ~80 chars), n=5/mode: RSS loaded **292 vs 292 MB**,
  after batch **310 vs 310 MB**, **0.75 vs 0.75 ms/text**.
- Long texts (20 × ~6.8k chars, ~1.2k tokens), n=3/mode: peak RSS
  **~1129 vs ~1129 MB**, **18.1 vs 17.9 ms/text** — inside the 10% budget.

The 200–300 MB arena figure from external research does not reproduce on a
23 MB model with our shapes: the arena never grows past its initial chunk, so
there is nothing for the planner flag to save. The knob stays as a
latency-neutral default (it can matter for larger models with static large
shapes, e.g. bge-m3 1024-dim) with a tested rollback — not as a claimed win.

`arena_extend_strategy` was deliberately NOT passed: it is an `OrtArenaCfg` /
execution-provider option (CUDA/ROCM EPs, `CreateArenaCfg`), not a generic
session config entry — the JS `SessionOptions` surface has no field for it and
an `extra.session` entry would be silently ignored. Passing it would be a
placebo; the issue's premise was wrong on this point and the code comment in
`src/ai/onnx.ts` records why.

## 2. Watcher dedup: 6 → 5 subscriptions on a 5-root stand

Stand: real `ProjectManager` + real `@parcel/watcher`, 5 tmp projects
(umbrella + registered child + 3 singles); one root added twice
(`<root>/` and `<root>`). Before (stashed base): **6 managed projects /
6 subscriptions** — the alternate spelling created a second full project
(pipeline + DB handle + subscription) on the same directory. After:
**5 / 5** — subscriptions == distinct filesystem roots.

Two clauses of the issue needed no code: read-only local sessions already skip
the watcher entirely (pinned by
`tests/daemon/local-backend-readonly.test.ts`), and umbrella+child keep one
subscription per distinct root by design — descendant-exclude (TRA-209) already
prevents double-indexing, so the remaining duplicate is one idle FSEvents
stream, not double work. Cross-root event demux was deliberately not built.
