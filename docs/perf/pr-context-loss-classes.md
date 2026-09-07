---
layout: default
title: Where the trace-mcp review context lost — the 13 PRs, classified
permalink: /perf/pr-context-loss-classes/
description: Diagnosis of the 13 pull requests where a review from trace-mcp context missed the fix a review from the full files caught, and what turned out to be missing from the context.
noindex: true
measurement: pr_context_quality
written_on: 2026-09-07
---

# Where the review context lost, on the 13 PRs that lost

[The quality arm]({{ '/perf/prereg-pr-quality/' | relative_url }}) of the PR
benchmark found 13 pull requests out of 60 where a model reviewing the naive
context (diff + every file it touches) named the defect being fixed and the
same model reviewing the trace-mcp context did not. This page is the diagnosis
of those 13, run before any tuning.

The expected answer was a distribution: some unresolved import edges, some
symbols dropped under the bundle's 8,000-token budget, some file never pulled
in. The actual answer has no distribution in it.

## Finding: the context contained no source code at all — in all 13

Dumping both arms' prompts (`bench-pr-context.ts --only <prs> --dump-prompts`)
and reading them shows the same thing 13 times out of 13. The trace-mcp arm's
"context bundle" was a list of signatures. Not truncated bodies, not partial
bodies — zero lines of source, in every section, on every PR. In full, this was
the entire context axios#11073 was reviewed from, after the diff:

```
=== Primary Symbol ===
[namespace] __module__:server — sandbox/server.js
(module body) sandbox/server.js

[function] requestHandler — sandbox/server.js
function requestHandler(req, res)
## Impact — call sites this change can break
```

The PR changes `const pathname` to `let pathname`. Deciding whether that is a
fix or a regression requires seeing the later reassignment inside the function
body — which the naive arm had and this arm did not. The pattern repeats: every
one of the 13 judge notes describes speculation ("focuses on hypothetical
scenarios", "treats the fix as a behavior change", "falsely claims XSS"), which
is what a reader does when it has names and no code.

## Root cause: a bare `require()` under ESM, swallowed by a catch

`FileReadCache.readSymbolSource` in `src/tools/navigation/context-bundle.ts`
read file bytes through `require('node:fs')`. The package is
`"type": "module"`, so under real ESM that is a `ReferenceError` — caught by the
`catch {}` next to it, cached as "file unreadable", and reported as a bundle
that assembled fine. `assembleContext` then degraded every item to
`no_source`, its documented behaviour when a body is unavailable.

It worked in the two places we look:

- **the shipped build** — `tsup.config.ts` injects a `createRequire` banner, so
  installed users get a working `require` and full bodies. **No released
  version served signature-only bundles.**
- **the test suite** — vitest defines `require` in every module it transforms,
  so all 10k+ unit tests, including this tool's own behavioural suite, exercised
  the working path.

It failed in exactly one place: a consumer that imports `src/` as real ESM.
The published package ships `dist` only (`bin` → `dist/cli.js`), so no install
path reaches that code; the two consumers that do are
`scripts/bench-pr-context.ts` under `tsx` — which is how the benchmark measured
a context with the source removed — and `pnpm serve`, the contributor's
run-from-source path.

This is the second instance of the class; TRA-542 was the same bare `require`
in `dropDecisionRows`, also behind a non-fatal catch, also reporting success.

## What it cost

Both halves of the benchmark measured the degraded arm, so both numbers were
wrong, in opposite directions.

**The token number was too good.** Re-running the same 60 PRs, same corpus,
same pinned SHAs, with bodies restored:

| | before | after |
|---|---:|---:|
| median input tokens, trace arm | 1,326 | 3,951 |
| median saving | 90.6% | 70.5% |
| PRs where the index did not pay off | 5 | 23 |
| — of those, costing *more* than reading the files | 0 | 13 |

The baseline arm is untouched (13,595 median, identical), which is the control
this correction rests on.

Per PR, on the 13:

| PR | baseline | trace before | trace after | saving before → after |
|---|---:|---:|---:|---:|
| [axios/axios#11073](https://github.com/axios/axios/pull/11073) | 960 | 227 | 1,184 | 76% → −23% |
| [axios/axios#11118](https://github.com/axios/axios/pull/11118) | 3,551 | 1,502 | 5,198 | 58% → −46% |
| [expressjs/express#5555](https://github.com/expressjs/express/pull/5555) | 46,454 | 524 | 1,550 | 99% → 97% |
| [expressjs/express#7265](https://github.com/expressjs/express/pull/7265) | 3,514 | 237 | 3,527 | 93% → −0% |
| [honojs/hono#5236](https://github.com/honojs/hono/pull/5236) | 44,246 | 3,813 | 8,594 | 91% → 81% |
| [honojs/hono#5250](https://github.com/honojs/hono/pull/5250) | 5,846 | 561 | 4,446 | 90% → 24% |
| [honojs/hono#5283](https://github.com/honojs/hono/pull/5283) | 19,517 | 1,583 | 4,751 | 92% → 76% |
| [honojs/hono#5291](https://github.com/honojs/hono/pull/5291) | 19,866 | 1,753 | 4,213 | 91% → 79% |
| [pallets/flask#5808](https://github.com/pallets/flask/pull/5808) | 8,617 | 1,331 | 2,040 | 85% → 76% |
| [psf/requests#6806](https://github.com/psf/requests/pull/6806) | 6,017 | 995 | 3,207 | 83% → 47% |
| [sindresorhus/got#2362](https://github.com/sindresorhus/got/pull/2362) | 18,777 | 526 | 1,363 | 97% → 93% |
| [sindresorhus/got#2454](https://github.com/sindresorhus/got/pull/2454) | 55,721 | 2,502 | 6,075 | 96% → 89% |
| [sindresorhus/got#2471](https://github.com/sindresorhus/got/pull/2471) | 31,642 | 2,222 | 5,446 | 93% → 83% |

**The quality number was too bad.** The re-run, same 60 PRs, same
preregistered bars, same judge protocol. Each run is its own pair — the naive arm was re-measured alongside the trace
arm, so the struck run's numbers are only comparable to the struck run's naive
column, not to this one:

| 60 PRs | struck run: naive | struck run: trace | re-run: naive | re-run: trace |
|---|---:|---:|---:|---:|
| understood the change | 65.0% | 50.0% | 65.0% | **66.7%** |
| false positives per PR | 0.65 | 1.20 | 0.58 | **0.80** |
| PRs only the naive arm understood | — | 13 | — | **3** |
| review latency, median | 90.0 s | 74.5 s | 93.0 s | 92.9 s |

Read across the pairs: comprehension went from −15 pp to +1.7 pp, false
positives from +0.55 to +0.22, and latency from 17% faster to level. The naive
arm scored 65.0% in both runs — measured twice, independently, at the same
value.

One row of the re-run needed a second attempt: `honojs/hono#5283` failed with a
transport error (`claude exited 1`) and was filled by re-invoking the same
script, which re-runs only the directories with no cached judgement. Nothing
inspects a row's outcome before deciding to keep it — the retry closed a gap in
the artifact, it did not re-roll a result.

Both bars are met (≤10 pp comprehension loss, ≤+0.5 false positives): the trace
arm lands 1.7 points *above* the naive one, which the bar never asked for and
which 60 pull requests cannot make significant — parity is the honest reading.
The struck run's latency advantage was the speed of a context with the code
removed, and it is gone.

## Why no test caught it, and what does now

Nothing asserted that a body ever reached the caller. The behavioural suite for
this tool checked the result *shape* — `{ primary, dependencies, callers,
totalTokens, truncated }` — and the markdown branch was covered only by
existence, not content. A signature-only bundle satisfies every one of those
assertions.

Two gates were added:

- `tests/tools/behavioural/get-context-bundle.behavioural.test.ts` now asserts
  the markdown output contains the primary symbol's body, not its signature.
  This is the assertion the coverage was missing; it does not catch the ESM
  mechanism, because vitest defines `require`.
- `tests/ci/no-bare-require.test.ts` scans `src/` and fails on any bare
  `require(` outside a stated allowlist. This is the gate for the mechanism —
  static, because neither runtime we test in can reproduce it.

Two further latent instances of the same bug were fixed while the rule was
being written: `python-modules.ts` (`readdirSync` for src-layout detection,
which silently returned "not a src layout" under ESM) and `install-app.ts`.

## The other lesson: `changed_symbol_readable` measured nothing

The token benchmark reported changed-symbol readability of 100% in both arms —
including on all 13 of these PRs, while the trace arm contained no code. The
metric recorded a span whenever the bundle *listed* a symbol, never checking
that the bundle carried its body. It was the one indicator that should have
caught this and it was structurally incapable of it.

**Fixed, not renamed (TRA-1100).** `get_context_bundle` now reports a `detail`
field (`'full' | 'no_source' | 'signature_only'`) per symbol — the same
classification `assembleContext` already computed internally but never
surfaced. `changed_symbol_readable` and `dependent_readable` in
`scripts/bench-pr-context.ts` now count a span as readable only when
`detail === 'full'`; `dependent_pointed` is unchanged, since "named with a
location" was always the honest claim for that one. The same field backs a
cheap CI gate (`tests/ci/context-bundle-body-coverage.test.ts`) that fails on
partial body loss, not just total loss — see the [preregistration's release
gate section]({{ '/perf/prereg-pr-quality/' | relative_url }}#release-gate-tra-1100).
