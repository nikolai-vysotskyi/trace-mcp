---
layout: default
title: Embedding model eval (MiniLM vs e5-small vs bge-m3)
permalink: /perf/embedding-models/
description: Internal working document. Measured recall/cost of ONNX embedding candidates on a code corpus (TRA-1539) and the resulting default/opt-in decision.
noindex: true
---

# Embedding model eval — TRA-1539

**Decision: the default stays `Xenova/all-MiniLM-L6-v2` (q8).**
`Xenova/multilingual-e5-small` (q8, with automatic `query:`/`passage:` prefixes)
is the recommended opt-in for retrieval quality; `Xenova/bge-m3` (q8) is a
heavy opt-in only. mmBERT stays rejected (MLM backbone, no embedding
fine-tune — see issue). This doc records the numbers behind that call.

## Result (final run, Apple M5 Max / 128 GB, node 22, batch 16)

Corpus: 616 code-symbol docs auto-built from `src/` (`scripts/embedding-eval/corpus.mjs`,
same `kind + name + signature + comment` text the indexer embeds).
Queries: 24 hand-labeled description→code pairs (`scripts/embedding-eval/queries.json`).
Metric: in-memory cosine — isolates embedding quality from FTS/hybrid fusion.
Cold load/download measured on first (cold-cache) runs; recall on the final warm run.
Machine-readable: [`embedding-eval.json`](./embedding-eval.json).

| model | dim | cold load | download | ms/text | ms/query | R@1 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|---|---|---|
| MiniLM fp32 (old explicit setting) | 384 | ~14 s | 86 MB | 4.8 | 0.417 | 0.708 | 0.750 | 0.561 |
| **MiniLM q8 (default)** | 384 | ~5 s | ~23 MB | 4.7 | 0.458 | 0.708 | 0.708 | 0.581 |
| e5-small q8 **+ prefixes** (opt-in) | 384 | ~20 s | 129 MB | 13.8 | 0.625 | 0.875 | 0.875 | 0.737 |
| e5-small q8 bare (footgun demo) | 384 | — | — | 13.0 | 0.583 | 0.875 | 0.917 | 0.712 |
| bge-m3 q8 (heavy opt-in) | 1024 | ~90 s | 560 MB | 79 | 0.625 | 0.833 | 0.875 | 0.728 |

Reading the table:

- **q8 vs fp32 MiniLM: no quality change** (MRR 0.581 vs 0.561, within query noise).
  The earlier switch to q8 default stays justified — 4× smaller download, same recall.
- **e5-small clearly beats MiniLM**: R@5 0.875 vs 0.708 (+24% relative),
  MRR 0.737 vs 0.581 (+27%). Same 384 dim → drop-in, no storage migration.
- **Prefixes matter, modestly**: +0.04 R@1 / +0.03 MRR with `query:`/`passage:`.
  Small on English code, but free — and without plumbing a future E5 switch
  would silently eat exactly this. The provider now applies them automatically
  (`applyE5Prefix` in `src/ai/onnx.ts`, only for E5-family model ids).
- **bge-m3 is not worth it**: MRR on par with e5-small (0.728 vs 0.737) at
  6× encode cost, 4× download, 2.7× vector storage (1024-dim needs a
  dimension migration), and a ~1.75 GB RSS spike at load.

## Why the default does NOT change

e5-small wins on quality, but the default is also the first-run experience:
5 s / 23 MB (MiniLM-q8) vs 20 s / 129 MB (e5-small) before the first embedding
lands, plus a full re-embed for every existing user on switch. First run is the
only run most evaluators see. Quality-sensitive users can opt in with two config
lines; everyone else keeps the fast default. Revisit only with new measurements.

## Opt in

```jsonc
// .trace-mcp.json — recommended opt-in (384-dim, re-embed only, no migration)
{ "ai": { "enabled": true, "provider": "onnx",
  "embedding_model": "Xenova/multilingual-e5-small", "embedding_dimensions": 384 } }

// heavy opt-in (1024-dim — needs a dimension migration, see below)
{ "ai": { "enabled": true, "provider": "onnx",
  "embedding_model": "Xenova/bge-m3", "embedding_dimensions": 1024 } }
```

## Migration note (switching models)

Vectors from different models are semantically incomparable — dim match does
**not** save you (MiniLM↔e5 share 384 dim and still need a full re-embed).
The pipeline handles this: on the next `embed_repo` run a provider/model/dim
drift **auto-rebuilds** (drops the vector index, re-stamps meta, re-embeds —
with a warn log). Set `ai.autoRebuildOnProviderMismatch: false` for a hard
gate: the same drift then throws `ProviderMismatchError` instead of rewriting.
Both paths are pinned by `src/ai/__tests__/embedding-pipeline-provider-mismatch.test.ts`.

## Limitations (read before quoting these numbers)

- 24 queries ⇒ ±0.04 granularity per query; the MiniLM↔e5 gap (4+ queries at
  R@5) clears it, the e5↔bge gap does not — treat those two as tied.
- Description→code pairs only; production `hybridSearch` fuses FTS 50/50, so
  end-to-end gains will be smaller than this embedding-level delta.
- bge-m3 ran under mean pooling (what our provider does); its native CLS
  pooling may read slightly better.
- Absolute ms/load/RSS are M5 Max numbers — relative ranking transfers,
  absolute values don't. ΔRSS-load across separate processes was noisy
  (same-model runs differed 2×); only bge-m3's GB-scale spike is directional.

## Reproduce

```bash
pnpm eval:embeddings                        # all models → docs/perf/embedding-eval.{json,md}
pnpm eval:embeddings -- --models e5-prefix  # subset (any of minilm-fp32,minilm-q8,e5-prefix,e5-bare,bge-m3)
```

Harness: `scripts/embedding-eval/` (`corpus.mjs`, `queries.json`, `run.mjs`).
