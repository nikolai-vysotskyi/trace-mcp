# E1′ — Read/Bash mirrors: prototype and first measurements

Experiment behind bet A1′ (TRA-725, following TRA-714): our own tool output is
6.4% of a transcript, while native `Read` and `Bash` are 26% of a human session
and 57% of an agent run. If we can compress *their* output, that is where the
tokens are.

This file records what the prototype does, what was measured, and which
harness facts the next run should not have to rediscover. Numbers here were
produced on Claude Code 2.1.239, macOS, 2026-09-03.

## The mechanism is a hook, not a pair of tools

TRA-725 was written assuming mirrors would be *tools* — an agent calls
`Read`, our lookalike answers, and the pre-registered death criterion was
"adoption below 30%". That framing does not survive contact with the harness.

A mirror tool cannot shadow the native one. MCP tools are namespaced
`mcp__<server>__<name>`, so ours would be an *additional* tool competing with
`Read` for the model's choice — which is exactly the competition TRA-705
already measured at 13–16%. Under that design the bet is dead before any
compression work starts.

The mirror does not need to be a tool. Claude Code's `PostToolUse` hook
carries a field whose documented purpose is precisely this:

> `updatedToolOutput` — Replaces the tool output before it is sent to the model.
> (`updatedMCPToolOutput` does the same for MCP tools only; prefer
> `updatedToolOutput`, which works for all tools.)

The native tool still runs; the hook rewrites its result on the way to the
model. **Adoption is therefore not a behavioural variable** — the hook sees
100% of `Read` and `Bash` calls by construction. The 30% death line and the
"stop if the 5-task pilot is under 15%" early stop were both written against
the tool design and do not apply to this one.

### The output envelope must be preserved exactly

The harness validates the rewrite against the tool's own output shape and
discards a mismatch *silently*, keeping the original output:

> PostToolUse hook returned updatedToolOutput that does not match `<tool>`'s
> output shape; using original output.

The first prototype returned a bare string and was rejected on every call —
the hook's own metrics log showed 92% compression while the transcript was
untouched. The envelopes, captured from live runs:

```jsonc
// Read
{ "type": "text",
  "file": { "filePath": "…", "content": "…", "numLines": 5, "startLine": 1, "totalLines": 1003 } }

// Bash
{ "stdout": "…", "stderr": "", "interrupted": false, "isImage": false, "noOutputExpected": false }
```

Only the text field may move. `tests/hooks/mirror.test.ts` pins both envelopes;
this is the "byte-identical contract" threat from the issue, and a shape test
is the only thing that catches it — the failure mode is invisible by eye.

## What the prototype does

`hooks/trace-mcp-mirror.sh`, installed as `PostToolUse` with matcher
`Read|Bash`. Deterministic, model-free, in this order:

1. spill the full result to `~/.trace-mcp/mirror/<session>/`, referenced by
   path in the compressed view so the agent can pull it back;
2. **Bash only** — drop package-manager progress noise (spinners, progress
   bars, `Progress: resolved`, npm notices);
3. collapse runs of identical lines into `… previous line repeated N more time(s)`;
4. head/tail window (80/40 lines) whatever is still oversized;
5. bail out unchanged if the rewrite, footer included, would not shrink.

Noise filtering never runs on a `Read`. Source code is full of lines those
patterns match — `...spread`, a `50% {` keyframe selector, a docstring that
begins "Resolving" — and filtering source through package-manager heuristics
deletes code silently. Spills older than a day are reaped on each write.

Outputs under 2000 chars pass through untouched. Every rewrite appends a row to
`metrics.jsonl` (`orig_chars`, `new_chars`, `spill`), so compression and call
counts are read off a real session rather than estimated. Knobs:
`TRACE_MCP_MIRROR_MIN_CHARS`, `_KEEP_HEAD`, `_KEEP_TAIL`, `_DISABLE`, `_HOME`.

No encoder-reranker. Step 1 of the issue's two-step plan only; the second step
is not justified until the deterministic pass is shown to be the bottleneck.

## Measured

**Live, end to end** (headless `claude -p`, Sonnet 4.5, synthetic noisy build log):

| tool | orig | compressed | saving | reached the model? |
|---|---|---|---|---|
| `Read` (30 KB) | 30140 | 2459 | −91% | yes, mirror note quoted verbatim |
| `Bash` (3.9 KB) | 3952 | 1212 | −69% | yes |
| `Bash` (30 KB) | 30000 | 2371 | −92% | **no** — superseded, see below |

In both successful cases the model still recovered the correct last line of the
file, i.e. the head/tail window kept what the question needed.

**Real command traffic in this repo** (five commands, hook applied offline):

| command | orig | compressed | saving |
|---|---|---|---|
| `pnpm install` | 1486 | — | pass-through (under threshold) |
| `pnpm run build` | 961 | — | pass-through |
| `pnpm exec vitest run tests/hooks/` | 2177 | — | pass-through (nothing to collapse) |
| `git log --stat -40` | 101717 | 6023 | −94% |
| `pnpm exec biome check src/` | 44 | — | pass-through |

## The finding that actually threatens A1′

It is not adoption, and it is not compression ratio. It is that **the
compressible mass is bimodal, and the harness already owns the fat end.**

Four of five real outputs were too small to be worth touching. The one fat
output compressed 94% — and sits in the size range where Claude Code already
persists the result to a file itself and shows the model a preview. That is the
crude version of this mirror, shipped, upstream of us. It is why the 30 KB
`Bash` row above shows a 92% compression in our metrics log and no change in
the transcript.

So the mirror's addressable band is outputs large enough to be worth
compressing but below the host's own persistence ceiling. That ceiling is
host-configurable (`persistenceThresholdCeiling`; the built-in default is
400 000 chars, but the agent-SDK host used by `claude -p` sets it far lower —
30 KB was already persisted). **Sizing that band on real traffic is the next
measurement, and it gates the bet more sharply than anything pre-registered.**

## What is not done

The three-arm solve-rate comparison (bare agent / trace as-is / trace with
mirrors) over 10–15 live tasks with repeats. Nothing here says what compression
costs in correctness, re-asks, or call-count inflation — and the issue's own
threat note is right that cheaper reads may simply buy more reads.

## Does the rewrite break the prompt cache?

No — it cuts cache writes by 95%. `updatedToolOutput` only ever alters the
message being appended, never one already in the prefix, so no cached prefix can
be invalidated by it. Measured on 113,501 requests of corpus and a live A/B:
`benchmarks/mirror-prompt-cache.md` (TRA-860).

## Revised gate

- ~~Death: adoption < 30%~~ — retired. Adoption is structural under the hook
  design, not a model choice.
- **Death (replacement): under 40% of Read/Bash *token mass* in a real session
  falls in the addressable band.** Below that, per-call compression cannot pay
  for the work whatever its ratio.
- Success: actual compression ≥40% over the addressable band, solve-rate drop
  ≤2pp, no rise in total Read/Bash call count.
- Quality failure: solve-rate drop >5pp at any compression — published in full,
  bet closed.
