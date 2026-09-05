# TRA-861 — skeletonisation gate: structural units instead of lines

TRA-758 measured a line-level relevance selector inside the Read/Bash mirror
hook and failed the recall gate (55.6% evidence recall at a 50% cut, threshold
0.85). Its own post-mortem named the failure mode: *line-level selection
fragments code and destroys syntactic connectivity*. TRA-861 tests whether the
unit of selection was the thing that failed, by re-running the same gate with
exactly one variable changed — a **structural unit** (a symbol with its body)
instead of a line, the way HCP (AAAI 2025) does it: focal code keeps its body,
everything else keeps its signature.

**Verdict: the gate fails again, and this time the ceiling is measured rather
than inferred. The direction is closed.**

## Corpus

TRA-758's dataset was never committed (it is 10 MB of private source), so it is
re-extracted here with the documented methodology — `extract.py`, same corpus
(`~/.claude/projects`, 2 416 transcripts), same working band (2 000–64 000
chars), same evidence labelling (a line counts when it reappears in the next 12
assistant turns as a quote, inside an `Edit`'s `old_string`, or as a path /
identifier carried into a later tool call), same strata.

493 calls (243 Read, 250 Bash) against TRA-758's 497 (247/250). The baseline arm
reproduces to within 2 pp of the published numbers (53.6% mean recall vs 55.8%),
which is what makes the two runs comparable.

Labels are heuristic, as they were in TRA-758. They were spot-checked here, not
audited at the 50-example depth of the original — the conclusion below does not
rest on label precision, because its decisive arm is an oracle.

Recall is scored by substring containment, which is slightly optimistic where a
file repeats a line: review re-scored the heuristic structural arm by exact line
index and got 55.6% against the 60.6% below. The optimism runs in the
structural arm's favour and it still misses 0.85, and the oracle scores 100.0%
under both methods, so neither number that carries the verdict moves.

## Results

`TARGET_CUT=0.2 pnpm exec tsx benchmarks/skeleton-gate/eval.ts`

| arm | n | mass cut | mean recall | median | recall<0.85 | ms/call |
|---|---|---|---|---|---|---|
| window 24/12 (shipped) | 493 | 67.8% | 53.6% | 50.0% | 65.1% | <0.01 |
| window 24/12 + cap 3000 | 493 | 78.4% | 46.7% | 41.9% | 76.3% | <0.01 |
| **structural units** | 493 | 53.2% | 62.3% | 72.1% | 55.0% | 0.9 |
| structural units, Read subset | 180 | 51.2% | 60.6% | 73.5% | 54.4% | 0.9 |
| window 24/12, same subset | 180 | 86.1% | 36.7% | 26.9% | 82.2% | <0.01 |
| skeleton floor (signatures only) | 180 | 71.6% | 34.8% | 25.0% | 82.8% | <0.01 |
| **window at the same budget** | 180 | 50.7% | **63.9%** | 84.6% | 50.6% | <0.01 |
| ORACLE structural focus | 180 | **16.7%** | 100% | 100% | 0% | — |
| ORACLE line focus | 180 | 92.0% | 100% | 100% | 0% | — |

Gate condition: recall ≥0.85 at a ≥50% cut. Best structural result: **0.61 at
51%**. Sweeping the budget does not reach it — 0.61 / 51% cut, 0.52 / 57%,
0.48 / 62%, 0.41 / 68%.

## What actually killed it

**1. At equal mass, structure loses to a dumb window.** Trim a head/tail window
to exactly the number of characters the structural arm spends and it scores
63.9% against 60.6%. All of the structural arm's gain over the shipped 24/12
comes from spending more mass, none from choosing better. The selection unit is
not carrying the result.

**2. The ceiling is 16.7%.** Give the structural selector a perfect ranker —
keep every unit that contains any evidence, discard the rest — and it cuts
**16.7%** of the mass at 100% recall. That is the physical ceiling of this unit
of selection on this workload, independent of any ranker, any model, any
budget. The gate asks for 50%. No amount of better focus scoring closes a gap
that the granularity itself forbids.

Decomposing classes into their methods — an oracle at the finest structural
granularity that still keeps bodies whole — moves the ceiling to 22.2%. Still
less than half of what the gate asks.

The reason is in the spread: evidence touches 1.88 of 4.68 units per file, and
those units hold 83% of the file's bytes. The agent reads a file and uses lines
from its *largest* functions — keeping those whole means keeping the file.

**3. HCP's own compression comes from the part we do not have.** HCP cuts 50K→8K
because most of its context is *dependencies*, which it reduces to signatures.
Inside a mirror hook there are no dependencies: the file the agent just read is
by definition the focal file. Our skeleton floor — every body dropped, only
signatures and top-level code kept, i.e. HCP's dependency representation — scores
34.8% recall at 71.6% cut, worse than a same-mass window. HCP's result is real;
it just does not transfer to a per-call output rewriter, because the ratio it
exploits does not exist here.

**4. The two oracles bracket the whole design space.** Perfect line selection
cuts 92%; perfect structural selection cuts 16.7%. Both hit 100% recall. That
gap is the price of syntactic coherence, and it is the entire argument in one
number: you can have compression or coherence, and the workload does not leave
room for both. TRA-758 bought compression and lost coherence. This bought
coherence and lost compression.

## Cost, measured separately

The item TRA-758 was right to insist on. `footprint.ts`, 27 KB TypeScript file:
grammar load + first parse 15.3 ms, warm parse p50 2.16 ms, RSS +49 MB for one
grammar; Node boot ~20 ms on top, so ~40 ms per call in a per-call hook process.
Against the encoder's +1 616 ms and +198 MB this is cheap. The direction died on
headroom, not on cost — which is the useful half of the negative result.

Prefix-cache impact was not measured here and is not this arm's to answer: any
rewrite of tool output has the same exposure, and TRA-860 owns it.

## Conclusion

Two different units of selection have now failed the same gate, for two
different and now-named reasons, with the second one bounded by an oracle rather
than by a heuristic. "Compress tool output more cleverly than a deterministic
window" is closed. The shipped deterministic selection (TRA-730 / TRA-750)
stays.

One observation belongs to whoever tunes that window, not here: on the Read
subset the 24/12 window cuts 86% and drops to 36.7% recall, while a budget-based
window at 50% cut holds 63.9%. The line window is over-compressing large source
files. That is a parameter question for TRA-750, not a new mechanism.

## Independent re-run

Reviewer B re-extracted the corpus from scratch (7 921 candidates, 493 sampled)
and reproduced every arm: baseline window 54.7%, oracle 16.0%, footprint +48.1 MB.
The 2.2 pp gap between our baseline and TRA-758's published 55.8% is inside the
sampling noise (SEM 1.78%, 95% CI [50.1%, 57.1%]).

## Reproducing

```sh
python3 benchmarks/skeleton-gate/extract.py      # rebuilds dataset.json (gitignored: private source)
pnpm exec tsx benchmarks/skeleton-gate/eval.ts   # TARGET_CUT env sweeps the budget
pnpm exec tsx benchmarks/skeleton-gate/footprint.ts
```
