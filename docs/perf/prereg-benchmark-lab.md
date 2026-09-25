---
layout: default
title: Preregistration — Benchmark Lab arms
permalink: /perf/prereg-benchmark-lab/
description: What the Benchmark Lab figure set out to measure, the bar it had to clear, and the verdict against that bar.
noindex: true
measurement: benchmark_lab
data_file: docs/_data/benchmark_lab.json
preregistration: retrospective
written_on: 2026-09-26
verdict: MET
---

# Preregistration — Benchmark Lab arms

**This file is retrospective.** The Lab battery ran on 2026-09-26 and this was
written the same day, after the numbers were known. It was not preregistered.
The bar below binds the next run; it is not evidence about this one.

The response-tokens preregistration ([prereg-response-tokens](./prereg-response-tokens/))
retrospectively bound an aggregate over one machine's call mix. The Lab binds
something narrower and re-runnable in the app: the same eight pinned fixtures,
three arms, one command (`tsx scripts/bench-lab.ts`), comparable by battery
sha.

## Question

Do the shipped index arms answer the pinned battery for fewer tokens than raw
file reads — and does the wider surface earn its extra tokens with answers the
narrow one misses?

## Metric

Per arm, over the same fixtures: `total_tokens` (exact `o200k_base` counts of
what the arm returned), `total_calls`, `success` (recall@k ≥ the fixture's own
baseline for the tool arms; every expected file read for the control), and
`savings_vs_baseline_pct` against the file-reading arm. Pricing is
`claude-sonnet-4-5` input at $3/Mtok, named in the record. The record is
`docs/_data/benchmark_lab.json`, written by `scripts/bench-lab.ts`; the script
also prints the table `src/benchmark-lab/markdown.ts` renders for the app's
export button, so the app and the site quote one computation.

## Corpus

- `tests/recall-harness/fixtures/` — 8 fixtures (4 symbol, 2 file, 2 decision),
  content-hashed per run (`battery.fixtures_sha`); two runs are comparable when
  the hashes match.
- `trace-mcp`'s own repository at the measured build, indexed from scratch into
  a temp DB — no registry writes, no daemon, no network.

## Control

The `file-reading` arm: raw files from disk (defining files of the expected
symbols, the expected files themselves, the seeded decision texts), no index
calls. It is the price of answering without trace-mcp, and the only arm that
may not use the index to locate its reads — it resolves basenames to indexed
paths, then prices the raw bytes.

## Pass bar

The `standard` arm answers **8/8 fixtures while spending at most half** the
control arm's tokens (`savings_vs_baseline_pct ≥ 50`).

## Prediction

The minimal arm is expected to be the cheapest by far (single index call per
fixture) with full or near-full success; the standard arm is expected to cost
more per fixture (packed envelopes, top-hit source reads) and to convert the
fixtures where raw FTS ranking misses. A minimal-arm miss on a file fixture is
a real measurement of that strategy's limits, not a harness failure — it is
published, not re-run until it passes.

## Verdict — MET (2026-09-26, 3.33.0@4e1ac4fd)

Control: 82,412 tokens, 13 calls, 8/8. Minimal: 512 tokens, 8 calls, 7/8
(−99.4%). Standard: 13,657 tokens, 12 calls, 8/8 (−83.4%). The one minimal
miss is `06-context-pipeline`: raw `search_text` for "IndexingPipeline" does
not rank `src/indexer/pipeline.ts` in its top 10 (too many files mention the
class); the packed envelope does. Re-run: `tsx scripts/bench-lab.ts` — the
2026-09-26 re-run was bit-identical (same battery sha, same tokens, same
success), which is the comparability claim the Lab exists to make.
