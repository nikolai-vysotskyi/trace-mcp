# GEO-battery: trace-mcp in AI answers

Weekly tracker of whether AI assistants name trace-mcp when users ask for
things it does. The GEO counterpart of a rank tracker: instead of SERP
positions we record presence in generated answers.

Issue: TRA-1947 (parent: TRA-1946). Runner: `scripts/geo-battery.mjs`.
History (machine-readable): `ops/geo-ranks-history/YYYY-MM-DD.json`.

## Procedure (frozen)

| Parameter | Value |
|---|---|
| Surfaces | 4: ChatGPT, Claude, Gemini, Perplexity — via DataForSEO AI Optimization `llm_responses/live` |
| ChatGPT model | `gpt-5.5` |
| Claude model | `claude-sonnet-4-5-20250929` |
| Gemini model | `gemini-2.5-pro` |
| Perplexity model | `sonar-pro` |
| Region / language | United States / English (`web_search_country_iso_code: US`) |
| Web search | on (we measure citability, not closed-book memory) |
| `max_output_tokens` | 1024 |
| Frequency | weekly (Monday) + on demand after major docs/positioning changes |
| Cost discipline | live run ≈ 80 calls, a few USD (2026-09-25 desk: chat_gpt ~$0.10, claude ~$0.05, gemini ~$0.05, perplexity ~$0.01 per call). Dry-run by default: `run` without `--yes` spends nothing. History file caches (prompt, model) so re-runs only pay for gaps. No 500+ batch ever without a human go-ahead. |

If a pinned `model_name` stops resolving, update it in
`scripts/geo-battery.mjs` and note the swap here with its date — a silent
model change breaks the trend.

## The 20 prompts (frozen, ask verbatim, fresh session, no follow-ups)

Verbatim copy of `PROMPTS` in `scripts/geo-battery.mjs`
(`tests/docs/geo-battery.test.ts` fails if the two drift apart):

| ID | Prompt |
|---|---|
| P01 | What is the best MCP server for code graph navigation? |
| P02 | Which MCP server is best for code intelligence in AI coding agents? |
| P03 | What is the best code graph MCP server for large monorepos? |
| P04 | What is the best tool to reduce Claude Code token usage? |
| P05 | How can I reduce context window usage in Claude Code? |
| P06 | What is the best MCP server for Claude Code to save tokens? |
| P07 | What is the best MCP server for Laravel codebases? |
| P08 | What is the best MCP server for Vue and Nuxt projects? |
| P09 | What is the best MCP server for Django projects? |
| P10 | What is the best MCP server for Spring and Java projects? |
| P11 | Which MCP server understands frameworks like Laravel, Vue, Django and Spring? |
| P12 | What is the best tool for impact analysis before refactoring code? |
| P13 | Which tool shows the blast radius of a code change for AI agents? |
| P14 | What is the best MCP server for PR review context? |
| P15 | What tool gives AI agents dependency graph context for code review? |
| P16 | Repomix vs Serena vs trace-mcp: which should I choose? |
| P17 | What is the best Serena alternative for large repositories? |
| P18 | What is the best Repomix alternative for AI coding agents? |
| P19 | Which MCP servers should I install for Claude Code? |
| P20 | What is the best MCP server for framework-aware code search? |

Coverage map: P01–P03 code graph / code intelligence · P04–P06 Claude Code
token usage · P07–P11 framework lanes (Laravel / Vue+Nuxt / Django /
Spring+Java / all four) · P12–P15 impact / blast radius / PR-review context ·
P16–P20 comparative intent (repomix / serena / install lists).

## Metrics

Per (date, prompt, model): `mentioned` (named in prose or a cited source),
`cited` (a trace-mcp.com URL among cited sources), `position` (1-based number
of the enumerating list item naming trace-mcp; null when mentioned in prose
outside a list or not mentioned). Run level: `share_top10` = runs with
position ≤ 10 / all runs; `share_top50` = mentioned / all runs (AI answers
almost never enumerate 50 tools, so any mention counts — the column keeps the
contract stable if answers get longer).

Cell legend in the tables below: `✓#n` named at list position n · `~`
mentioned in prose, no list position · `—` not mentioned · `·` not measured.

## Baseline — 2026-09-25 (honest zero)

Sampled live, 1 prompt (P01) × 4 models + the aggregate mentions database.
Recorded here exactly as returned; raw texts live in
`ops/geo-ranks-history/2026-09-25.json`.

- **ChatGPT (`gpt-5.5-2026-04-23`)**: recommends Serena (#1 default),
  codesight-mcp, Codebase-Memory / CodeGraphContext, codebadger, @ttsc/graph.
  trace-mcp: not named, not cited. —
- **Claude (`claude-sonnet-4-5-20250929`)**: lists repo-graph, code-graph-mcp
  (sdsrss), CartographAI mcp-server-codegraph, CodeGraphContext. trace-mcp:
  not named, not cited. —
- **Gemini (`gemini-2.5-pro`)**: Sourcegraph, CodeGPT Deep Graph, LobeHub
  code-graph-mcp, CodeGraphContext, GitHub MCP, repowise, Serena. trace-mcp:
  not named, not cited. —
- **Perplexity (`sonar-pro`)**: code-graph-mcp, Sourcegraph MCP, Serena.
  trace-mcp: not named, not cited. —
- **DataForSEO LLM Mentions, domain `trace-mcp.com` (EN/US, all platforms)**:
  0 mentions, 0 AI search volume — the aggregate database has no record of us
  being cited either. Cost of that check: $0.101.

Readiness context (same day, CONFIRMED by fetch): `robots.txt` allows `/`
for all user-agents — no AI-search crawler (OAI-SearchBot, Claude-SearchBot,
PerplexityBot) is blocked; `/llms.txt` exists and lists the docs surface
including the `/vs/` comparison pages and the token-usage guide. Absence from
answers is a mention/authority gap, not a crawlability gap.

| date | prompt | chat_gpt | claude | gemini | perplexity |
|---|---|---|---|---|---|
| 2026-09-25 | P01 | — | — | — | — |
| 2026-09-25 | P02 | · | · | · | · |
| 2026-09-25 | P03 | · | · | · | · |
| 2026-09-25 | P04 | · | · | · | · |
| 2026-09-25 | P05 | · | · | · | · |
| 2026-09-25 | P06 | · | · | · | · |
| 2026-09-25 | P07 | · | · | · | · |
| 2026-09-25 | P08 | · | · | · | · |
| 2026-09-25 | P09 | · | · | · | · |
| 2026-09-25 | P10 | · | · | · | · |
| 2026-09-25 | P11 | · | · | · | · |
| 2026-09-25 | P12 | · | · | · | · |
| 2026-09-25 | P13 | · | · | · | · |
| 2026-09-25 | P14 | · | · | · | · |
| 2026-09-25 | P15 | · | · | · | · |
| 2026-09-25 | P16 | · | · | · | · |
| 2026-09-25 | P17 | · | · | · | · |
| 2026-09-25 | P18 | · | · | · | · |
| 2026-09-25 | P19 | · | · | · | · |
| 2026-09-25 | P20 | · | · | · | · |

Summary: 2026-09-25 — runs 4 · mentioned 0 · cited 0 · top10 0 ·
share_top10 0.0% · share_top50 0.0%.

The first *full* 20×4 run is still ahead; when it lands, its summary row goes
in Dynamics and the `·` cells above stay as-is (baseline is append-only —
never rewritten, only superseded by newer dated rows).

## Dynamics (append-only, newest last)

- 2026-09-25 — baseline (sampled P01×4 + mentions DB): 0/4 mentioned, 0 cited,
  share_top10 0.0%, share_top50 0.0%. Full 20×4 pending.

## Runbook

```sh
# 1. What to ask (no cost, no network):
node scripts/geo-battery.mjs prompts

# 2. Full live run for a date (needs DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD):
node scripts/geo-battery.mjs run --date YYYY-MM-DD        # dry run: estimate only
node scripts/geo-battery.mjs run --date YYYY-MM-DD --yes  # spend, cached gaps only

# 3. Score hand-collected answers (deterministic, free):
node scripts/geo-battery.mjs score --in responses.json

# 4. Table + summary for this file:
node scripts/geo-battery.mjs report
```

After each run: append the dated rows + summary to Dynamics, keep the
baseline section untouched, and surface the weekly delta to TRA-1946.

## What this battery is not

Not mention farming, not paid links, not review spam. It only measures.
If a cell ever flips to `✓`, the follow-up question is "what earned it"
(citable passage? comparison page? third-party write-up?) — answered in the
open, in the issue — never "how do we fake more of it".
