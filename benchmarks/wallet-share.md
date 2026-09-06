# What share of a subscription can trace-mcp actually save?

Every saving figure this project publishes — 90.6% on PR-review context, 67.4%
on mixed workloads — is a share of **tool output**. A subscription is billed on
the **whole prompt**, re-sent on every request. Those are not the same
denominator, and the ratio between them decides whether "cut your tool output by
two thirds" means "double your plan" or "buy back one task in eight".

This file measures that ratio on real transcripts, and then checks it against a
controlled experiment that never touches transcripts at all.

Measured 2026-09-07, corpus 2026-05-28…2026-09-06, macOS, Claude Code, Sonnet
list prices with the 1-hour cache TTL the corpus actually uses.
Reproduce: `node scripts/bench-wallet-share.mjs ~/.claude/projects`.

## Answer

**Roughly 10–12%, and the ceiling is structural.** Two thirds of what a session
bills is the fixed prompt surface — system prompt, tool definitions, injected
skill and tool listings — re-billed on every request. Tool output of every kind,
ours and native, is about 15% of billed input. Compressing 15% by two thirds
cannot produce a 2x plan no matter how good the compression gets.

Do not write "double your subscription limits". The honest wallet sentence is
"about 12% cheaper per task"; the honest headline stays the task-level one.

## Method

2,907 sessions, 120,969 API requests, $10,371 of billed input and $1,027 of
output at list price. For each request the real billed input is split across the
classes present in its context, in proportion to token mass; the part the prompt
bills beyond the reconstructed message mass is the fixed surface. That residual
is an upper bound — it absorbs every estimation error — so the tool-output
shares are a lower bound. Chars-per-token is calibrated per class against
`gpt-tokenizer` o200k (3.16 for assistant text through 4.39 for thinking) on a
15% block sample; images count 1,500.

## Where the money goes

| class | % of billed input | % of input + output |
|---|---:|---:|
| system prompt + tool definitions | 51.6% | 46.9% |
| injected tool / skill / agent listings | 15.1% | 13.7% |
| tool-call arguments | 7.2% | 6.6% |
| `Bash` output | 7.1% | 6.5% |
| `Read` output | 5.0% | 4.5% |
| injected hook output | 2.6% | 2.3% |
| injected files + CLAUDE.md | 2.6% | 2.3% |
| user text | 1.9% | 1.7% |
| other MCP servers' output | 1.7% | 1.5% |
| **trace-mcp tool output** | **1.6%** | **1.4%** |
| reminders, assistant text, thinking, other tools | 3.6% | 3.2% |
| output tokens | — | 9.0% |

The fixed surface is **66.7%** of billed input. Everything any tool-output
compression can ever touch — ours, native, other servers — is **15.4%**.

The first request of a session carries a median **59,040**-token prompt before
the conversation starts (p10 28.5k, p90 80.8k). That is what gets re-billed,
turn after turn.

## Counterfactual on the same corpus

Repricing every recorded trace-mcp call at its `docs/_data/response_tokens.json`
baseline — what a `Read`/`Grep` would have cost instead — adds **$387** to a
$10,371 bill. The tool surface that made those calls possible costs more than
that on any preset above `minimal` (`full` is 42–45k tokens, `standard` 16.3k,
`minimal` 8.6k, per `benchmarks/name-token-savings.md`). On this corpus, where
trace-mcp carries 1.55% of the context, the server does not pay for its own tool
list. That is a statement about this corpus's usage mix, not about the product —
see the next section for the controlled version.

## The controlled experiment agrees

`benchmarks/crawl-detector-three-arm.md` (TRA-773) ran 99 live runs, bare agent
vs trace-mcp, and measured end-to-end cost: **0.888x on light questions, 0.883x
on crawls**. That is ~11–12% cheaper per task, net of our own tool list, arrived
at without touching a transcript. Two independent methods landing at ~10–12%
is the load-bearing part of this file.

## What this changes

1. **No subscription-multiplier claim.** 40–50% "off your plan" has the same
   provenance problem as the 40–50% we retired in #915: nobody measured it.
2. **The task-level numbers stay.** 90.6% on PR-review context is measured,
   external and reproducible. It answers "how much context does this step cost",
   which is a real question — just not the wallet question.
3. **The biggest lever is our own surface, not our responses.** At 66.7% fixed
   and 1.6% ours, a kilotoken removed from the tool list outweighs a kilotoken
   removed from a response many times over. Tool consolidation and lean presets
   are worth more than further response compression.
4. **Turns, then tokens.** With a fixed per-turn surface this large, cutting the
   number of turns a task takes beats cutting the tokens each turn returns.

## What this does not answer

One machine, one user, one heavy configuration (many MCP servers, plugins and
skills — which is exactly what inflates the fixed surface). A vanilla install
has a smaller prompt, so tool output would be a larger share there and the
ceiling would sit higher. The direction of that bias is known; its size is not
measured. The 0.883x arm is the number that does not depend on this corpus.
