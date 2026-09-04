# Mechanical share of real agent edits — the TRA-862 gate

TRA-862 proposed building deterministic codemods on the strength of TRA-705's
"~30% of agent work is mechanical". TRA-705 flagged that number as unproven: it
was the share of Edit **payloads** among tool calls, so it counted that an edit
happened and never what the edit **was**. TRA-862 made the number the basis of a
~2.5 week bet and required it be earned before any code.

It was measured. **The gate fails**, and it fails for a reason the framing did
not anticipate.

Measured 2026-09-05 over `~/.claude/projects` — 2,766 transcripts, of which 935
contain edits: 8,826 Edit/MultiEdit payloads (4,568 Write calls excluded, a
whole-file write has no old→new transform to classify).

Reproduce: `node scripts/codemod-corpus-audit.mjs`. The classifier is pinned by
`tests/ci/codemod-corpus-audit.test.ts`.

## Method

Every edit's `old_string` → `new_string` is tokenized (whitespace dropped,
string/number literals kept whole) and the token diff classified into the
transform that would have produced it. Two numbers, and the second decides:

- **expressible** — the diff *is* an exact tree transform: a consistent
  identifier substitution, a literal swap, a small argument insert/removal, a
  pure deletion. A generous upper bound; it never asks whether invoking a
  codemod would have been *worth it*.
- **payoff** — expressible **and** repeated: ≥3 edits of the same shape across
  ≥2 files in one session. A one-off rename in one file saves nothing — the
  agent still reasons about it once, and one `Edit` is cheaper than one codemod
  call. The value claim was only ever about the repetition.

Classification is conservative by construction: anything the differ cannot prove
is a clean transform lands in `novel`, so classifier error pushes the result
**down** — the direction that protects against talking ourselves into the
feature. Two rounds of correction went the other way and are included below.

## Result

| class | n | share |
|---|---:|---:|
| novel | 7,603 | 86.1% |
| literal-swap | 460 | 5.2% |
| pure-delete | 312 | 3.5% |
| arg-insert | 293 | 3.3% |
| rename | 82 | 0.9% |
| arg-delete | 35 | 0.4% |
| token-swap | 27 | 0.3% |
| formatting | 14 | 0.2% |

**expressible 13.7%** (1,209 edits) — less than half of the 30% assumed.

**payoff 0.8%** (71 edits), in 16 of 935 sessions (1.7%), 20 groups total.

Threshold sweep, because a single pair of cutoffs is not an argument
(min-group × min-files → payoff share):

| | files ≥1 | ≥2 | ≥3 |
|---|---:|---:|---:|
| **group ≥2** | 2.6% | 1.6% | 0.6% |
| **group ≥3** | 1.1% | 0.8% | 0.6% |
| **group ≥5** | 0.2% | 0.1% | 0.1% |

The most generous cell in the table — "the same transform happened twice
anywhere at all" — is 2.6%. There is no threshold at which this becomes a
2.5-week bet.

## Why it fails is not why we expected

The interesting part is *where* the loss happens. Mechanical edits are not
especially rare — 13.7% is a real slice. They just **do not repeat**. Of 1,209
expressible edits only 71 belong to a repeated cross-file group; the other 94%
are one-offs, and a one-off mechanical edit is precisely the case where a
codemod is *more* expensive than the Edit it replaces (a pattern to compose, a
dry-run to read, an apply call — against one string swap).

The largest repeated group in 935 sessions is **6 edits across 6 files**. That is
the ceiling of the entire opportunity.

Note also what the mechanical slice is made of: `literal-swap` is the biggest
class at 5.2%, and a literal swap (`'Email Templates'` → `'Email'`, `900` → `888`)
is the case where the codemod saves the *typing* but not one token of the
*deciding* — which value, and why, is the whole task. `rename`, the flagship
transform and the one where a codemod genuinely replaces reasoning about import
sites, is **0.9%**.

## The capability already exists, and is unused

TRA-862's premise — "не хватает применения правки, а не её вычисления", and the
niche claim that every competitor is read-only — is factually wrong about this
repo. `src/tools/refactoring/` already ships seven applying tools, all with
dry-run preview: `apply_rename`, `apply_codemod`, `change_signature`,
`apply_move`, `extract_function`, `remove_dead_code`, `plan_refactoring`.

Their invocation counts across the same 935 sessions:

| tool | calls |
|---|---:|
| `apply_codemod` | 20 |
| `apply_rename` | 0 |
| `change_signature` | 0 |
| `apply_move` | 0 |
| `extract_function` | 0 |
| `remove_dead_code` | 0 |
| `plan_refactoring` | 0 |

This is against a `CLAUDE.md` that mandates them in the strongest language in
the file ("NEVER use Edit for the same mechanical change 2+ times — this is a
HARD RULE, not a guideline. Even 'just 3 edits' is a violation."). Built,
documented, mandated, unused.

Two readings, and the corpus decides between them: either agents ignore the
tools, or the situations the tools are for barely occur. The 0.8% payoff share
says it is mostly the second. 20 `apply_codemod` calls against 71 payoff-shaped
edits is not a large adoption gap to close.

## Verdict

**Fail, published in full per the issue's own gate.** Do not build the codemod
engine — it exists. Do not extend it on this rationale: the mechanical work it
would capture is 0.8% of edits, and the 1.45×-on-edit-tasks projection from the
TRA-855 reconnaissance has no support in the corpus.

The measurement did surface three real gaps in the tools that already exist, all
of them safety rather than capability, and all of them cheap next to a 2.5-week
build:

1. **No post-apply verification.** Nothing reparses, typechecks, or runs tests
   after an apply. A codemod that leaves the repo broken costs more than every
   token it saved.
2. **No undo.** There is no single command that reverts an apply.
3. **No dirty-tree check** before a multi-file write.

These are worth a small focused issue. They are not worth TRA-862's scope.

## Corrections made during the measurement, and their direction

Both were found by sampling the `novel` bucket and by the pinning test, and both
are recorded because the first version of a classifier is never the one to trust:

1. Argument insertion was detected from the token *preceding* the insertion
   point, which misses an argument appended after a nested call (`f(g(a))` →
   `f(g(a), b)`, preceded by `)`) and a parameter added across a line break. Now
   tested on the inserted run's own delimiters. Moved expressible 10.9% → 13.7%,
   payoff unchanged.
2. Substitution totality was checked only inside the changed span, so
   `f(x, x)` → `f(y, x)` classified as a rename — the surviving occurrence was
   eaten by the common suffix. That is a judgement call about *which* occurrence,
   not a transform. Now checked across the full window.

Correction 1 raised the number, correction 2 lowered it, and the payoff figure
that decides the gate did not move under either.
