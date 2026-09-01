# `trace-mcp` → `trace`: measured token savings (TRA-613)

Measured 2026-09-01 on `trace-mcp@3.10.0` (`b6b02ae4`), macOS 15 / M-series, Node 22.22.3.
Reproduce with `pnpm run build && node scripts/bench-name-tokens.mjs`.

Tool counts and schemas come from a **real `initialize` + `tools/list` round-trip** against the
built server (one spawn per preset, `client_profile: "off"`, a bare TypeScript project so no
framework-gated tools register) — not from a hand-written list.

Tokenizers: `gpt-tokenizer` for `o200k_base` (GPT-4o) and `cl100k_base` (GPT-4);
`@anthropic-ai/tokenizer` for Claude; `@lenml/tokenizer-gemini` for Gemini. The last two are
optional dev installs, not repo dependencies — see the script header.

> Caveat, stated once: Anthropic does not publish a tokenizer for Claude 3+, so the Claude column
> is the Claude 1/2 vocabulary from `@anthropic-ai/tokenizer`. It is the closest offline proxy
> available; treat it as indicative, not exact. The GPT columns are exact.

## Headline

Renaming the MCP server key saves **2 tokens per tool (GPT) / 3 tokens per tool (Claude, Gemini)**,
which is **0.74–1.23% of the advertised tool surface** depending on preset and tokenizer.

The per-mention claim in TRA-610 is correct: `trace-mcp` is 3 tokens (GPT) or 4 (Claude, Gemini),
`trace` is 1 — a 67–75% cut **on the substring**. The "hundreds of tokens per turn" claim is also
correct in absolute terms on the `full` preset (332–498 tokens). What the numbers do not support is
reading that as a large relative win: against the ~42–45k tokens the `full` tool surface already
costs, the rename is a ~1% cut. It is worth doing — it is free and it compounds — but it is not a
lever comparable to tool consolidation (TRA-210).

## The string, in isolation

| text | GPT-4o (o200k) | GPT-4 (cl100k) | Claude | Gemini |
|---|---:|---:|---:|---:|
| `trace-mcp` | 3 | 3 | 4 | 4 |
| `trace` | 1 | 1 | 1 | 1 |
| `mcp__trace-mcp__` | 7 | 7 | 8 | 8 |
| `mcp__trace__` | 5 | 5 | 5 | 5 |
| `` `trace-mcp` `` | 5 | 5 | 6 | 6 |
| `` `trace` `` | 3 | 3 | 3 | 3 |
| `.trace-mcp.json` | 4 | 4 | 7 | 7 |
| `.trace.json` | 2 | 2 | 4 | 4 |

o200k splits `trace-mcp` as `trace` + `-m` + `cp`; `trace` is a single token in all four.

## Tool-name prefix (`mcp__trace-mcp__x` → `mcp__trace__x`)

Names only, one per line.

| preset | tools | tokenizer | before | after | saved | % of names |
|---|---:|---|---:|---:|---:|---:|
| minimal | 28 | GPT-4o | 302 | 246 | 56 | 18.5% |
| minimal | 28 | GPT-4 | 299 | 243 | 56 | 18.7% |
| minimal | 28 | Claude | 360 | 276 | 84 | 23.3% |
| minimal | 28 | Gemini | 359 | 275 | 84 | 23.4% |
| standard | 55 | GPT-4o | 619 | 509 | 110 | 17.8% |
| standard | 55 | GPT-4 | 612 | 502 | 110 | 18.0% |
| standard | 55 | Claude | 727 | 562 | 165 | 22.7% |
| standard | 55 | Gemini | 722 | 557 | 165 | 22.9% |
| full | 166 | GPT-4o | 1895 | 1563 | 332 | 17.5% |
| full | 166 | GPT-4 | 1855 | 1523 | 332 | 17.9% |
| full | 166 | Claude | 2220 | 1722 | 498 | 22.4% |
| full | 166 | Gemini | 2210 | 1712 | 498 | 22.5% |

## Whole advertised tool surface (`tools/list`: names + descriptions + schemas)

The denominator that matters. Includes the literal `trace-mcp` mentions inside tool descriptions
(5 in `standard`, 17 in `full`), which the names-only table above misses.

| preset | tokenizer | before | after | saved | % |
|---|---|---:|---:|---:|---:|
| minimal | GPT-4o | 8627 | 8561 | 66 | 0.77% |
| minimal | GPT-4 | 8466 | 8400 | 66 | 0.78% |
| minimal | Claude | 8957 | 8858 | 99 | 1.11% |
| minimal | Gemini | 8999 | 8900 | 99 | 1.10% |
| standard | GPT-4o | 16303 | 16183 | 120 | 0.74% |
| standard | GPT-4 | 16013 | 15893 | 120 | 0.75% |
| standard | Claude | 16988 | 16808 | 180 | 1.06% |
| standard | Gemini | 16997 | 16817 | 180 | 1.06% |
| full | GPT-4o | 42835 | 42469 | 366 | 0.85% |
| full | GPT-4 | 42004 | 41638 | 366 | 0.87% |
| full | Claude | 44468 | 43919 | 549 | 1.23% |
| full | Gemini | 44595 | 44046 | 549 | 1.23% |

## Prose mentions

| corpus | mentions | tokenizer | before | after | saved | % |
|---|---:|---|---:|---:|---:|---:|
| `initialize` instructions (verbosity=full) | 2 | GPT-4o | 930 | 926 | 4 | 0.43% |
| `initialize` instructions (verbosity=full) | 2 | Claude | 1051 | 1045 | 6 | 0.57% |
| CLAUDE.md / AGENTS.md routing block | 11 | GPT-4o | 2212 | 2184 | 28 | 1.27% |
| CLAUDE.md / AGENTS.md routing block | 11 | Claude | 2424 | 2382 | 42 | 1.73% |
| repo CLAUDE.md | 12 | GPT-4o | 4429 | 4405 | 24 | 0.54% |
| repo CLAUDE.md | 12 | Claude | 4911 | 4875 | 36 | 0.73% |
| repo AGENTS.md | 5 | GPT-4o | 492 | 482 | 10 | 2.03% |
| repo AGENTS.md | 5 | Claude | 574 | 559 | 15 | 2.61% |

The `initialize` instructions block barely moves: it names the server twice. It is already under a
1455-token budget (`tests/server/instructions.test.ts`), so there is nothing to reclaim there. Its
absolute counts drift ±1 token between runs because the block embeds the detected-framework string
of the throwaway project the script spawns against; the delta (4 / 6) is stable.

Full four-tokenizer tables: run the script.

## Over a session

Tool definitions and the CLAUDE.md routing block live in the system prompt, so a client re-bills
them on every turn — as a *cache read* where prompt caching is on, at full price where it is not.

| preset | tokenizer | per turn | 10 turns | 30 turns | 50 turns |
|---|---|---:|---:|---:|---:|
| minimal | GPT-4o | 94 | 940 | 2 820 | 4 700 |
| minimal | Claude | 141 | 1 410 | 4 230 | 7 050 |
| standard | GPT-4o | 148 | 1 480 | 4 440 | 7 400 |
| standard | Claude | 222 | 2 220 | 6 660 | 11 100 |
| full | GPT-4o | 394 | 3 940 | 11 820 | 19 700 |
| full | Claude | 591 | 5 910 | 17 730 | 29 550 |

## Retrieval regression check

Both retrieval evals were run on an indexed clone of `b6b02ae4`:

- recall harness (`pnpm run test:recall:report`): 8/8 fixtures pass, aggregate recall@k **1.000**,
  precision@k **0.775**.
- replay eval (`pnpm run replay:check`): nDCG@10 **1.0000**, MRR **1.0000**, Recall@5 **1.0000**,
  Δ 0.0000 against baseline on all three.

Both measure *code retrieval*, which the server key cannot affect — no ranker, index, or scoring
weight is involved. Whether shortening the prefix changes an **agent's tool-selection** accuracy is
a model-behaviour question, and no offline suite in this repo measures it. Do not read these
numbers as evidence for that.

Note: `pnpm run test:recall` (the vitest entry point) auto-skips on every machine — the vitest
setup file redirects `TRACE_MCP_DATA_DIR` to a per-worker temp home, so the registry lookup the
suite gates on never finds an index, and the run reports "1 test passed". Only the `test:recall:report`
runner exercises the fixtures. Filed separately.
