# Read/Bash mirrors and the prompt cache (TRA-860)

JetBrains Research published a paired A/B over 80 Claude Code tasks (July 2026)
in which `rtk`, a token-saving utility advertising 60–90% savings, **raised task
cost by 7.6%**. The mechanism reported was a cache-busting penalty: rewriting
what the model sees changes the prompt prefix, a cache read at $0.30/M turns
into a cache write at $3.75/M, and the 12.5× tariff eats the saving.

Our mirrors (`hooks/trace-mcp-mirror.sh`) rewrite the output of native `Read`
and `Bash` on the way to the model. That is the same sentence, so it deserved a
direct measurement rather than a reference to our own −14% in TRA-749 — which
was taken on 2–4-turn tasks, where the prefix never grows large enough to be
worth invalidating.

Measured 2026-09-05, Claude Code 2.1.239, `claude-sonnet-4-5`, macOS.

## Answer

**The mirrors do not break the prompt cache, and they cut cache writes by 95%.**
The effect runs opposite to the `rtk` finding, and it grows with session length
rather than shrinking.

## Why the mechanism cannot invalidate a prefix

`PostToolUse` / `updatedToolOutput` replaces a tool result *before* it is
appended to the conversation. The rewritten bytes are therefore always the
newest message — behind the last cache breakpoint, in the region that has never
been cached. Nothing already in the prefix is touched, and the hook never runs
again for that result: the compressed text is what the transcript stores from
then on.

`rtk` is not a hook. It is a command the agent invokes instead of the shell, so
it changes which calls happen and in what order — a behavioural change on top of
a textual one. The two tools share a description, not a mechanism.

Structural arguments are cheap, so both halves were measured.

## Corpus: 2,746 sessions, 113,501 API requests

`scripts/mirror-cache-continuity.mjs ~/.claude/projects` reads every transcript
on this machine (2026-05-28…2026-09-05) and, for each request, compares its
`cache_read_input_tokens` against the full input of the previous request *on the
same conversation branch*. A hit ratio near 1 means the whole prefix carried
over; a low one means part of it was re-billed at cache-write price.

| | requests | prefix breaks (<90% carried) | prefix mass re-written |
|---|---|---|---|
| no mirror | 101,921 | 1,793 (1.76%) | 1.84% |
| after a mirror rewrite | 41 | 1 (2.44%) | 0.40% |

Token classes over the whole corpus: **cache_read 92.6%, cache_write 2.8%,
uncached 4.6%** — TRA-714's 94% reproduces.

The single break after a mirror rewrite is one event out of 41; at that n the
95% interval spans the 1.76% baseline several times over, and the re-written
prefix *mass* is 4.6× lower than baseline. This is a bound, not a proof of
zero — which is why the live arm below exists.

Two artefacts inflate this analysis if you skip them, both by an order of
magnitude: one API request is written to the transcript as several records (one
per content block) and must be deduplicated by `requestId`; and a transcript
file interleaves parallel sub-agent branches, so the previous request has to be
found through `parentUuid`, not through file order. Before those two fixes the
same data reported a 9.12% baseline break rate.

## Live A/B: one task, hook on and off

Eight large `Read` calls in a fixed order, one per turn, 9 turns; empty MCP
config (`--strict-mcp-config`), per-arm `--settings`, everything else identical.

| arm | runs | cost | cache_read | cache_write | final prefix | breaks | min hit ratio |
|---|---|---|---|---|---|---|---|
| bare | 3 | $1.030 / $1.027 / $0.778 | 1.19 M | 191.7 K | 242 K | 1 (in the 3rd run) | 0.0 |
| mirror | 2 | $0.165 / $0.192 | 0.49 M | 8.7 K / 10.4 K | 59 K | 0 | 1.0000 |

**cache_write −95%, cache_read −59%, cost −83%**, and every mirror turn read
100% of its predecessor's prefix from cache. The one observed cache break in the
whole experiment happened in the *bare* arm.

The direction is not a surprise once stated plainly: the mirror shrinks the
suffix being appended, and the suffix is exactly what cache_write bills for. A
smaller suffix is written once at write price and re-read on every later turn at
read price. Both terms shrink together.

(A third mirror run is excluded: the model declined the task, citing this repo's
own CLAUDE.md rule against navigating source with `Read`. Arm-blind, but it
produced no reads to measure.)

## Break-even

There is no session length at which mirrors stop paying. For one output of `T`
tokens appended at a turn with `R` further requests to come, cost is
`T·W + T·R·Rd`; compressing it to `T′ < T` scales both terms down, so the saving
*grows* with `R`.

Corpus mean of `R`, weighted by where new tokens actually land:

| session length | sessions | mean remaining requests | value of one saved token (1 h cache, $/M) |
|---|---|---|---|
| 1–5 requests | 1,449 | 0.6 | 6.2 |
| 6–20 | 386 | 6.3 | 7.9 |
| 21–100 | 586 | 31.6 | 15.5 |
| 101–1,000 | 303 | 120.9 | 42.3 |
| >1,000 | 7 | 1,989.5 | 602.9 |

Last column is `W + R·Rd` at Sonnet 4.5 list prices with the 1-hour TTL the
corpus actually uses (`ephemeral_1h`): write $6/M, read $0.30/M.

A token removed from a 100–1,000-request session is worth roughly **7× more**
than the same token removed from a short one. TRA-749's −14%, taken on 2–4-turn
tasks, is therefore a floor for long sessions, not a ceiling — the opposite of
the direction the `rtk` result would predict.

The break-even that does exist is behavioural: how often the agent pulls the
spilled full output back. Each recall re-pays the original `T`, so mirrors stay
net-positive while the recall rate stays below the compression ratio — 90.4%
measured in TRA-749. Recalls in the corpus: **0 of 48 rewrites.**

## Two defects this measurement found

1. **The escape hatch did not work.** The footer says "Full output: `<spill>`",
   but a `Read` of that path was itself mirrored, returning the same 24/12
   window the agent already had, plus a wasted turn and a second spill file.
   Verified live on a 41 KB spill: back it came as the same 1,669 chars. Reads
   under `TRACE_MCP_MIRROR_HOME` are now exempt.
2. **The rewrite was not byte-deterministic.** The spill file was named
   `<epoch>-<pid>.txt`, so the same output produced a different replacement on
   every run — the exact non-determinism TRA-858 is removing from our own tool
   outputs. Spill names are now content-addressed (sha256 prefix), which also
   stops the same output being spilled twice.

Neither could cost anything through the prefix cache — both sit in the newest
message, like the rest of the rewrite. The first one could cost a turn and a
duplicate read, which is the only way this hook has to lose money.

## What this does not answer

One task, one model, one machine, five runs. It settles the cache mechanism,
which is a per-request property and needs no task variety. It says nothing new
about solve-rate or about average savings across task shapes — that is
TRA-749's 108-run three-arm measurement, and this changes none of it.
