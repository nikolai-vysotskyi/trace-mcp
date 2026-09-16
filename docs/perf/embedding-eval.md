---
layout: default
title: Embedding eval results (TRA-1539)
noindex: true
---

# Embedding eval (TRA-1539)

- generated: `2026-09-16T09:41:56.137Z`
- machine: Apple M5 Max / 128GB / darwin arm64, node v22.22.3
- corpus: 616 code-symbol docs, 24 labeled description→code queries

| model | dim | load ms | dl MB | ms/text | ms/query | ΔRSS load MB | ΔRSS embed MB | R@1 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|---|---|---|---|---|
| minilm-fp32 | 384 | 94 | 0 | 6.43 | 2.67 | 195.8 | 172.3 | 0.417 | 0.708 | 0.75 | 0.561 |
| minilm-q8 | 384 | 66 | 0 | 6.02 | 2.63 | 52.1 | 107.8 | 0.458 | 0.708 | 0.708 | 0.58 |
| e5-prefix | 384 | 475 | 0 | 14.05 | 7.13 | 439.8 | 17.3 | 0.625 | 0.875 | 0.875 | 0.737 |
| e5-bare | 384 | 507 | 0 | 12.33 | 6.58 | 315.5 | 4.8 | 0.583 | 0.875 | 0.917 | 0.712 |
| bge-m3 | 1024 | 898 | 0 | 78.61 | 27.75 | 349.9 | 251.3 | 0.625 | 0.833 | 0.875 | 0.728 |

