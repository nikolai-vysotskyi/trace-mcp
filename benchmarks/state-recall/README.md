# State-recall A/B — result, 2026-09-07

The SKILL.state claim finally has an arm that can fail. Twelve tasks, twenty
turns each, six planted facts per task, exact-match grading, thresholds pinned
in `preregistration.md` before the first model call. Raw output: `results.json`.

| Arm | Recall | Pass@1 | Invented codes / task | Prompt tokens | Model calls |
|---|---:|---:|---:|---:|---:|
| `full` — whole transcript | **100.0%** | 100% | 0 | 6 683 | 1 |
| `truncated` — trimmed to 4 500 tok | **43.1%** | 0% | 0 | 4 584 | 1 |
| `state` — rewritten state block + last 2 turns | **76.4%** | 67% | 0.33 | 28 603 | 21 |

Against the preregistered thresholds: **H1 pass, H2 pass, H3 fail, H4 pass.**

## What holds

**The failure mode is real (H1).** At a budget generous enough to keep 13.8 of
20 turns, the truncating baseline recalls 43.1% — and that is exactly its
mechanical ceiling, task for task: 43.1% of the planted facts were still on
screen and the model reported every one of them. Nothing here is a reading
failure. Losing the early transcript loses the facts, full stop.

**The state block buys a lot (H2).** 76.4% against 43.1%, +33.3 points. The
architecture does what it says it does.

## What does not

**The state arm loses 23.6 points to the full transcript (H3, threshold −10).**
That is a larger gap than the −15 points TRA-568 measured on context packing,
and it is the reason nothing from this run lifts an embargo.

The shape of the loss matters more than its size. Of the 17 facts the state arm
lost across 12 tasks, **zero were never written down.** Every one was captured
into the state block on the turn it appeared and then erased by a later rewrite.
Capture is not the defect; retention across rewrites is.

It also does not degrade gracefully. Eight tasks scored a clean 100%; the loss
is concentrated in four where a rewrite discarded most of what was already
recorded (one dropped all six). A per-turn rewrite is a per-turn opportunity to
lose the whole session, and that is a worse risk profile than truncation, which
at least fails predictably from the oldest end.

The by-kind split contradicts the prediction: `detail` facts survived best
(79.2%), not worst. Compactness is not what is dropping them.

The result does not rest on the one confounded task below. Dropping `recall-08`
entirely still leaves the state arm at 83.3% against 100% — a 16.7-point gap,
still outside the −10 threshold. (Independently recomputed during review.)

**Invention appears, in one arm only.** 0.33 fabricated identifier codes per
task in the state arm, 0 in both transcript arms. Under the H4 threshold, but
the sign is one-directional and the mechanism is legible: the rewrite keeps an
identifier's trailing digits and swaps its prefix, turning `EDGE_RESOLVER_3557`
into `DEAD_END_3557`. The loop is not forgetting the fact so much as corrupting
its handle, which scores as a miss and an invention at once.

## The confound, named

The arm measured here rewrites its whole state block every turn. **The shipped
`trace_state_patch` does not — it applies an RFC 7396 merge patch, so a key the
turn does not name survives by construction.** A whole class of the erasures
above is structurally impossible under merge-patch semantics.

One collapse shows the mechanism directly. In `recall-08` the model noticed the
corpus was synthetic, reframed the entire block around that ("all tool results
are SYNTHETIC… do NOT call more tools"), and in reframing threw away six facts
it had already recorded. A full rewrite lets a single turn's change of mind
erase the session; a merge patch cannot.

So this run establishes that the failure mode exists and that a rewrite-based
state loop walks into it. It does not yet establish what the shipped loop does,
because it did not measure the shipped loop. That gap is the next arm, not a
caveat to wave at.

## Consequence

`docs/SKILL_STATE.md` stays `noindex` and the Phase-4 token numbers stay off
public surfaces. TRA-1008's condition was "an arm that can fail"; that now
exists, and the arm failed. Publishing the −66.8% now would repeat exactly what
`ops/positioning.md` was written to stop.

Next, in order:

1. Add a `state_patch` arm that emits RFC 7396 patches against the real
   `StateEngine` instead of rewriting prose. If it closes the 23.6-point gap,
   that is the strongest thing we can say about SKILL.state and it publishes
   with the token number beside it. If it does not, the loop has a defect the
   design was supposed to prevent, and that publishes too.
2. Re-run with a corpus the model cannot spot as synthetic, to remove the
   `recall-08` class of collapse from the measurement.
3. Only then reopen TRA-1008.

## Reproducing

```bash
tsx scripts/bench-state-recall.ts --generate      # rewrite corpus.json (seeded)
pnpm bench:state-recall --concurrency 4           # ~45 min, 276 model calls
```
