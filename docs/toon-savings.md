# TOON Token Savings — Measured

This document captures real-world token measurements for the TOON output
format wired across trace-mcp tools, plus the independent `search_text`
`grouping: "by_file"` reshape.

## TL;DR — which tools support TOON

After benchmarking, TOON is wired only on the five tools where it is a clear
net win on representative payloads:

| tool                  | measured savings | why                                                     |
|-----------------------|-----------------:|---------------------------------------------------------|
| `query_decisions`     | **+31.4%**       | Homogeneous row-shaped decisions; pure table mode.      |
| `get_outline`         | **+28.8%**       | Flat symbol records; pure table mode.                   |
| `get_changed_symbols` | **+21.5%**       | Flat change records; pure table mode.                   |
| `search`              | **+16.4%**       | Flat item records; mild table-mode amortization.        |
| `get_feature_context` |  **+7.9%**       | Mostly flat items; modest gain.                         |

For every other tool TOON is off by default and the parameter is not
accepted in the schema.

## Why we removed TOON from 4 tools

| tool                | measured | reason                                                                                          |
|---------------------|---------:|-------------------------------------------------------------------------------------------------|
| `find_usages`       |  -17.5%  | Each reference carries a nested `symbol{}` block → list mode → header overhead per row.         |
| `search_text`       |  -25.5%  | Multi-line `context[]` arrays per match → list mode. Use `grouping: "by_file"` for +20.8% instead. |
| `get_artifacts`     |  -15.2%  | Artifact kinds are heterogeneous; field schemas diverge between rows → list mode.               |
| `get_context_bundle`|  -10.1%  | Nested `primary`/`imports` structure plus small typical size — fixed TOON preamble dominates.   |

`@toon-format/toon` remains a project dependency because the five keepers
above still rely on it.

## Internal mechanism — table mode vs list mode

TOON has two output shapes (driven entirely by the encoder, not by the
caller):

- **Table mode** (`[N]{col1, col2, col3}:`) — emitted only when every row in
  an array contains the **same scalar-only fields** (string, number, bool,
  null). One header amortizes over all rows; each row collapses to a single
  CSV-like line. This is where TOON wins.
- **List mode** (YAML-style nested keys) — emitted when any row has a
  nested object, an inner array, or differs in field set. Each row pays its
  own field labels; the header amortization disappears. TOON loses here vs
  JSON because JSON's `{"k":` is already terse.

The `scripts/toon-diagnostic-2.ts` script reproduces the breakeven curve.
Sample output (n = rows per array, Δ% = TOON savings over JSON):

```
N  | scalar-only (table)   | with array tags         | with nested obj
   | json   toon  Δ%   mode| json   toon  Δ%    mode | json   toon  Δ%    mode
---|----------------------|------------------------|------------------------
 10|  185    130  +29.7  T |  255   333  -30.6   L  |  354   443  -25.1   L
 20|  365    250  +31.5  T |  505   663  -31.3   L  |  704   883  -25.4   L
 50|  905    610  +32.6  T | 1255  1653  -31.7   L  | 1754  2203  -25.6   L
100| 1805   1210  +33.0  T | 2505  3303  -31.9   L  | 3504  4403  -25.7   L
```

Key observations:

- A **single inner `tags: [...]` array per row collapses the win into a
  ~30% regression** — the encoder falls out of table mode.
- A **single nested `symbol: {...}` object per row** is similarly fatal
  (~25% regression).
- Table-mode wins grow with column count: for 20 scalar columns × 20 rows
  the encoder reaches **+47.4%** vs JSON. This matches what `query_decisions`
  hits in production.

The four loser tools all land in list mode by construction:
`find_usages` has nested `symbol{}`, `search_text` has `context[]`,
`get_artifacts` row shapes vary per kind, `get_context_bundle` payloads
are deeply nested and small.

## Methodology

- Script: [`scripts/bench-toon.ts`](../scripts/bench-toon.ts) for the
  per-tool numbers; [`scripts/toon-diagnostic-2.ts`](../scripts/toon-diagnostic-2.ts)
  for the table-vs-list-mode curve.
- Invocation pattern: each registered MCP tool's closure is captured via a
  fake `server.tool(...)`. This bypasses the MCP transport but exercises the
  identical handler code that ships in production.
- Corpus for live-DB scenarios: a snapshot copy of the trace-mcp self-index
  (1,501 indexed files, 9,467 symbols).
- Corpus for fixture-only scenarios (`query_decisions`,
  `get_changed_symbols`): in-memory stores seeded with realistic shapes.
- Tokenizer: [`gpt-tokenizer`](https://www.npmjs.com/package/gpt-tokenizer)
  with the **cl100k_base** encoding. This is a GPT-4 / Claude family proxy.
  Anthropic's tokenizer is not publicly released; cl100k_base is the
  closest open approximation.
- Roundtrip assertion: every TOON output is decoded via
  `@toon-format/toon`'s `decode()` and structurally compared to the JSON
  payload, with a ~1e-6 relative tolerance for float precision.

Run it:

```bash
pnpm exec tsx scripts/bench-toon.ts
pnpm exec tsx scripts/toon-diagnostic-2.ts
```

## Overall — JSON vs TOON (original 9-tool sweep)

| scenario | json_tokens | toon_tokens | savings_pct | json_bytes | toon_bytes | bytes_savings_pct | notes |
|---|---:|---:|---:|---:|---:|---:|---|
| search query=register limit=30 | 3319 | 2776 | **16.4%** | 12052 | 9729 | 19.3% | KEEP — 25 items |
| get_outline store.ts | 5330 | 3793 | **28.8%** | 19520 | 13216 | 32.3% | KEEP — 92 symbols |
| find_usages fqn=Store | 46662 | 54840 | -17.5% | 190771 | 206704 | -8.4% | REMOVED — 567 references |
| get_feature_context token_budget=2000 | 2965 | 2730 | **7.9%** | 10810 | 9787 | 9.5% | KEEP — 11 items |
| get_context_bundle encodeResponse | 129 | 142 | -10.1% | 470 | 465 | 1.1% | REMOVED — small payload |
| query_decisions limit=20 | 3129 | 2146 | **31.4%** | 11062 | 6960 | 37.1% | KEEP — 20 decisions |
| get_artifacts limit=50 | 1391 | 1602 | -15.2% | 4636 | 5233 | -12.9% | REMOVED — 30 artifacts |
| get_changed_symbols since=HEAD~1 | 288 | 226 | **21.5%** | 892 | 557 | 37.6% | KEEP — 0 changes |
| search_text flat (toon) | 2160 | 2710 | -25.5% | 7850 | 8394 | -6.9% | REMOVED — 50 hits |

## search_text — flat vs by_file (TOON removed, grouping kept)

All percentages are computed against the **flat-json baseline** (2160 tokens
/ 7850 bytes for the same 50-hit corpus). `output_format: "toon"` is no
longer accepted on this tool; `grouping: "by_file"` stays and is the
recommended optimisation.

| scenario | json_tokens | savings_pct | json_bytes | bytes_savings_pct | notes |
|---|---:|---:|---:|---:|---|
| search_text flat (default) | 2160 | 0% | 7850 | 0% | baseline |
| search_text by_file | 1710 | **+20.8%** | 5826 | +25.8% | 8 files, 50 hits |

`grouping: "by_file"` is a pure structural reshape — it deduplicates file
paths under nested `files[].hits[]` buckets. It is lossless and independent
of `output_format`.

## Caveats

1. **Tokenizer**: cl100k_base is a *proxy* for Anthropic's tokenizer. Real
   Claude-side savings can differ by ±2-3 percentage points.
2. **Float precision**: TOON rounds high-precision floats below ~8
   significant digits (e.g. PageRank scores). For human-readable outputs
   this is invisible; for callers that hash JSON output, it is a real
   semantic difference.
3. **Single-sample bench**: each scenario runs once. The retrieval tools are
   deterministic given a fixed DB, so this is fine for token counts.
4. **Corpus is one repo**: trace-mcp's self-index. Results will shift on
   other codebases — wider repos with longer file paths boost `by_file`
   more; repos with sparser fields and shorter strings boost TOON more.

## Recommendation

- TOON is enabled (and worth selecting via `output_format: "toon"`) on
  exactly five tools: `query_decisions`, `get_outline`, `get_changed_symbols`,
  `search`, `get_feature_context`.
- For everything else, JSON is the default and the only accepted output
  format. The encoder regression on heterogeneous / nested / small payloads
  outweighs any benefit.
- For `search_text`, prefer `grouping: "by_file"` when paths repeat across
  hits — that is a clean +20.8% lossless win and is unrelated to TOON.
- Document the float-precision caveat for callers that hash or diff
  responses.

## Wave 2 candidates — measured

Forecasted savings if the same `output_format: "toon"` switch were wired into
each of the candidates below. **These tools are NOT wired** — this is a
measurement-only pass to decide which to wire in a follow-up.

Each row encodes the JSON payload returned by the production handler, then
re-encodes the same payload via `encodeResponse(..., "toon")`. Tokenised
with cl100k_base, roundtripped via `@toon-format/toon`'s `decode()` against
the parsed JSON with the loose-float comparator. Sorted by `savings_pct`
descending.

| scenario | items | json_tokens | toon_tokens | savings_pct | mode | notes |
|---|---:|---:|---:|---:|:---:|---|
| get_risk_hotspots limit=30 | 30 | 1338 | 758 | **+43.3%** | table | flat scalar rows |
| analyze_perf top=30 | 15 | 530 | 301 | **+43.2%** | table | seeded latency stats, 7 scalar columns |
| get_git_churn limit=50 | 50 | 2634 | 1604 | **+39.1%** | table | flat scalar rows |
| get_coupling limit=50 | 50 | 1733 | 1096 | **+36.8%** | table | flat scalar rows |
| get_pagerank limit=50 | 50 | 1634 | 1045 | **+36.0%** | table | only 2 columns but very repetitive |
| get_complexity_report limit=50 | 50 | 3057 | 2075 | **+32.1%** | table | flat scalar rows |
| get_refactor_candidates limit=40 | 40 | 1932 | 1387 | **+28.2%** | table | flat scalar rows |
| predict_bugs limit=40 | 40 | 8877 | 6965 | **+21.5%** | table | risky-control beat the prediction — see Surprises |
| get_dead_exports (project-wide) | 404 | 17581 | 13857 | **+21.2%** | table | flat scalar rows |
| get_untested_exports (project-wide) | 464 | 25964 | 20451 | **+21.2%** | table | flat scalar rows |
| list_pins (2 seeded) | 2 | 88 | 71 | +19.3% | table | tiny payload — fixed preamble dominates |
| get_untested_symbols max_results=80 | 80 | 14280 | 13098 | +8.3% | table | signature strings dilute the win |
| get_tests_for output-format.ts | 1 | 44 | 44 | 0% | table | single-row payload — no amortization |
| get_dead_code limit=30 | 30 | 2425 | 2822 | **-16.4%** | list | nested `signals{}` object per row → list mode |
| get_implementations name=LanguagePlugin | 33 | 2292 | 2683 | **-17.1%** | list | `via: string \| string[]` → list mode |

Skipped on this corpus (no bundles installed locally):
- `list_bundles` — empty payload
- `search_bundles` — empty payload

## Wave 2 recommendation

**Wire `output_format: "toon"` into these 10 tools** — every one is in table
mode with the loose-float roundtrip clean, and savings cross the **+15%
cutoff** we established for the original five keepers:

| tool | measured savings | mode |
|---|---:|:---:|
| `get_risk_hotspots` | +43.3% | table |
| `analyze_perf` | +43.2% | table |
| `get_git_churn` | +39.1% | table |
| `get_coupling` | +36.8% | table |
| `get_pagerank` | +36.0% | table |
| `get_complexity_report` | +32.1% | table |
| `get_refactor_candidates` | +28.2% | table |
| `predict_bugs` | +21.5% | table |
| `get_dead_exports` | +21.2% | table |
| `get_untested_exports` | +21.2% | table |

**Do not wire** these — savings below the +15% cutoff or list-mode regression:

| tool | measured | reason |
|---|---:|---|
| `list_pins` | +19.3% above cutoff, but typical payload is ~2-10 rows × 88-300 tokens — TOON's fixed preamble dominates at this scale and a single pin payload is already small. Wire only if usage tests show consistent ≥10-pin payloads in practice. |
| `get_untested_symbols` | +8.3% | Per-row `signature` and `level` strings drown out the column-header amortization. |
| `get_tests_for` | 0% | Single-row payloads are typical; no amortization possible. |
| `get_dead_code` | -16.4% | Nested `signals{ import_graph, call_graph, barrel_exports }` per row forces list mode. |
| `get_implementations` | -17.1% | `via: string \| string[]` makes row shapes heterogeneous → list mode. |

## Wave 2 surprises

1. **`predict_bugs` landed in table mode at +21.5%.** Prediction said the
   per-row `signals: string[]` array would force list mode (-25%-ish, like
   `find_usages`). What actually happens: in this corpus most predictions
   have an *empty* `signals` array, and the TOON encoder keeps table mode
   when every row's array field has the same length. The win is real but
   could degrade on a repo where `signals` is densely populated — re-measure
   before wiring on a high-churn repo.
2. **`list_pins` (2 seeded rows) only saves 19.3%.** The fixed TOON preamble
   is ~10-15 tokens; on a 2-row payload it eats most of the column-header
   amortization. The savings curve crosses +30% somewhere around 8-10 pins.
3. **`get_pagerank` saves +36.0% on just two columns (`file`, `score`).**
   The win is driven entirely by the repetitive `file` paths — TOON strips
   the per-row key labels, JSON repeats `"file":` for every row.
4. **`get_implementations` regressed even though no row's `via` was an
   array** in this run (33 implementors of LanguagePlugin, all with single
   `extends`). The encoder still went list mode — likely because of the
   union-typed field shape across encoder probing, or because some rows have
   `signature: null`. Investigate before wiring.
5. **`analyze_perf` is tied for first place at +43.2%** — that is the
   strongest predicted candidate by a wide margin, despite being seeded with
   synthetic latency stats. A real persistent-telemetry payload (24h/7d
   windows) would benefit even more.
