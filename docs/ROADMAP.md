---
layout: default
title: Product Roadmap
description: Internal working document. Strategic view of trace-mcp, revised roughly weekly.
noindex: true
---

# Product Roadmap

Strategic view of trace-mcp, revisited roughly weekly by the Product Roadmap
& Vision autopilot, which also writes that week's operational focus — one
substantive item per topical autopilot — into the "This Week's Focus" section
of the trace-mcp Operations project description. This file tracks *why*
something should move the product forward — not day-to-day bugs, tool tweaks,
or indexing hygiene (those live as regular issues, tracked by other
autopilots). An item is removed here once it ships, is superseded, or turns
out not to matter.

## Where the product stands

**Shipping is not the constraint.** In the seven days to 2026-09-01 the
repository took 358 commits and published 31 releases, going from v1.48.4 to
v3.11.0. In the same window the adoption metric of record moved from ~0 to 61
monthly active installs, and GitHub stars sat at 102 — the same flat line
they have held since the April launch burst decayed. Every item below is
written against that asymmetry: the product gains capability far faster than
it gains users, so a capability item now has to answer "who finds out" before
it earns a slot.

The last revision's "ready to start" item — scoping tool consolidation into
per-tool migration issues — is **closed, and by a better answer than the one
it proposed.** TRA-193 did the scoping (TRA-210 was cancelled as its
duplicate), and the conclusion was that consolidation is not the right lever:
v3.3 shipped **tool presets** instead (`tools.preset`, default `standard`,
progressive disclosure via `load_tools`), which cuts what a session pays for
schemas without breaking a single tool name. Schema cost is now a solved,
regression-guarded problem. What has never been measured is the other half —
what our tools *return* per call, turn after turn.

Two things changed the product's shape this week, and both need a decision,
not just a follow-up ticket:

- **We can finally prove the core claim on somebody else's code.** TRA-534
  measured input-token cost over 60 merged bug-fix PRs from six OSS repos
  (`docs/pr-context-benchmark.md`, generated into
  `docs/_data/pr_context_bench.json`): median **13,595 → 1,326 tokens, 90.6%
  saved**, p90 44,246 → 3,667, and affected call sites readable rising 20% →
  60% with 100% at least located. Until this, every reduction figure we
  published came from our own estimators. See item 1 and item 2.
- **The State Engine makes trace two things.** TRA-596 (phases 1-3 shipped,
  phase 4 open) added `trace_state_*`, a SQLite task-state store with RFC
  7396 merge patches and a `trace://state/{task_id}` resource — agent working
  state, not code structure. That is a second product pillar arriving without
  a positioning decision behind it. See item 3.

The standing question is unchanged and now sharper: **who trace-mcp serves,
and how far the single-developer, single-repo model stretches before it needs
to change shape.**

## Adoption — metric of record

The adoption metric of record is **active installs**, from the anonymous
daily ping in `src/telemetry/usage-ping.ts` (one event per install per UTC
day, opt-out via `TRACE_MCP_TELEMETRY=off`). Read it in the GA4 property
`G-WSYYT2WZJV` (account `Nikolai`, property `551114458` — note the login also
holds unrelated properties; do not write to those).

**Do not refresh this by hand.** `.github/workflows/ga4-snapshot.yml` pulls the
numbers daily via the GA4 Data API — active users by day/week/month, and the
breakdown by version, country and MCP client — and publishes them to the
[`adoption-data`](https://github.com/nikolai-vysotskyi/trace-mcp/blob/adoption-data/adoption.yml)
branch, plus each run's job summary. That branch is the durable record: GA4
keeps event data for 14 months at most, so anything older survives only there.
It is deliberately not on `master`: a PR opened by `GITHUB_TOKEN` never
triggers CI, so it could never satisfy the required checks.

| Date | Active installs | Notes |
| --- | --- | --- |
| 2026-09-01 | **61 monthly, 61 weekly, 54 daily** (310 events/28d) | First read with real data. Day ≈ week ≈ month means the install base is small and nearly all of it pings every day — an active core, not a decaying tail. |
| 2026-08-28 | _pending GA4 read access_ | Ping verified end to end: published `trace-mcp@2.0.0` carries baked credentials, payload validates against the Measurement Protocol debug endpoint. |

Caveat when citing it: the ping's credentials ship in plaintext inside the
published npm package (public by design — see SECURITY.md "Telemetry
Credentials"), so the events are **unauthenticated and can be inflated by
anyone**. Active installs is the best adoption signal we have, not an
auditable one; read it as a trend, and treat a sudden step change as
suspect until corroborated. The same branch carries a cumulative
`tokens_saved` counter with a sanitized and a raw figure side by side — quote
the sanitized one, and read a widening gap between them as someone flooding
the endpoint.

**npm weekly downloads are not an adoption metric** and should not be cited
as one. Measured 2026-08-28 (TRA-273): 9,013 downloads over 92 days, but
every daily peak is a publish day — 226 on 08-10 (v1.47.0), 344 on 08-17
(v1.47.1), 1,322 on 08-27 (nine releases). Strip publish days and the
baseline is flat at 20–45/day for the whole quarter. The graph measures our
release cadence and registry mirrors, not users. If it must appear in a
report, annotate the publish days.

Re-confirmed 2026-08-29 (TRA-413) with a stronger tell than publish-day
peaks: `https://api.npmjs.org/versions/trace-mcp/last-week` shows all 104
published versions clustered at a near-uniform 136–198 weekly downloads
while the median version is 2, and day-old releases hit parity with
month-old ones instantly. That is a mirror sweeping the version history,
not users — nobody installs `1.48.0`, `1.48.1` and `1.48.2` in equal
measure. Decision: the npm-downloads badge is removed from the homepage
trust strip and no download figure is cited on any public surface.

The same caveat covers **git clones** (measured 2026-08-30, TRA-540):
16,006 clones / 928 uniques in 14 days, ramping 166 → 8,736 per day across
08-24…08-29 while human page views stayed flat at ~20/day. Unique *cloners*
inflated along with the raw count (62 → 300), so clone uniques are no safer
than clone totals. Whatever swept the npm version history swept git too. The
supporting metrics are therefore GitHub stars plus traffic **views** uniques
only — clones are excluded. Channel-by-channel state lives in
`ops/user-signal.md`.

GitHub, 2026-09-01: **102 stars, 15 forks** — 100 on 08-28, 102 on 08-30, so
the star line is flat to within noise while releases ship daily. Traffic
(measured 08-30): 568 views / 175 uniques per 14 days, ~13–23 uniques/day,
top referrer reddit.com.

## Ready to start

### 1. Put the measured number where people arrive
`docs/pr-context-benchmark.md` is the only original, reproducible evidence
the project has ever produced, and it is reachable from exactly one place:
`docs/_data/docs_nav.yml`. It is named **zero times** in `docs/index.html`
and zero times in `README.md`. Both of those are being rewritten right now
(TRA-607, TRA-608, TRA-609) — which makes this the week the number either
lands above the fold or misses the rewrite entirely.

**Why it matters:** the site's whole pitch currently rests on figures our own
estimators produced about our own repository. "90.6% median saving across 60
merged pull requests in six open-source repositories, reproducible with a
script in the repo" is a categorically different claim, and it is the one
argument a skeptical reader cannot wave off. **Why now:** the hero rewrites
are in flight, and retrofitting evidence into a finished hero is a second
redesign.

### 2. Second arm of the benchmark: does the cheaper context review as well?
TRA-568 sits in backlog. Item 1's number invites one obvious rebuttal — *you
saved 90% of the tokens by showing the model 90% less code* — and the current
benchmark answers it only structurally (affected call sites readable 20% →
60%, all located). The missing arm is quality: run an LLM reviewer over the
same 60 PRs on both context arms and compare the findings against what the
merged PR actually fixed.

**Why it matters:** a token number without a quality number is an efficiency
claim, not a value claim, and every competitor's inflated "95% reduction" is
exactly that. Publishing both — including a result where we lose — is the
credibility position no peer on `docs/comparisons.md` currently occupies.
Promote it out of backlog.

### 3. Decide what the State Engine makes us
`trace_state_*` (TRA-596) stores agent task state: init, patch, get,
checkpoint, rollback, plus a `trace://state/{task_id}` resource. That is not
code intelligence. It is a bet that the expensive thing in an agent session
is re-establishing *what the task is*, alongside re-establishing what the
code is — a real and defensible position, but a different product from
"precomputed code graph", and it arrived through an implementation epic
rather than a positioning decision.

**Scope:** a short design pass, not code. (a) Does phase 4's A/B (TRA-600)
show state cutting tokens *and* holding task success, or only the first?
(b) Do the two pillars share one sentence a user can repeat, or is the tool
surface now two products in one binary? (c) If the answer is one product,
`docs/comparisons.md` and the homepage need the second pillar in them —
today neither mentions it. **Why now:** phases 1-3 are already in
`waiting_for_release`; the positioning question gets harder to answer the
more surface ships around it.

## Big bet — needs a design pass before any code

### 4. Team-shared graph — parked, needs Nikolai's go-ahead (TRA-128)
trace-mcp's whole pitch is "reuse instead of recompute" — but today reuse
only happens *within one developer's laptop, across turns*. A team of five
engineers on the same repo each index it separately, each mine their own
decisions separately, and never see each other's "why was this built this
way" answers. That's the same recomputation leak the product exists to
close, one level up.

The design pass (TRA-128) is done. Two things have strengthened it since:
the decision store now prunes stale roots (TRA-595), and the State Engine
(item 3) adds a *second* per-developer store with the same team-level leak —
task state is at least as re-derivable across a team as code structure is.
But the design's smallest viable slice is still a network-reachable server
component, which is the one category this project's rules reserve for
Nikolai's explicit call (no hosted backend or paid infra on an autopilot's
own authority). **Status: correctly parked, not stalled.** Nothing to do here
until there is a go-ahead or an actual team asking for it.

## Explicitly not doing right now

- **Consolidating tools to shrink the schema surface.** Settled: TRA-193
  scoped it, presets (v3.3) achieved the goal without breaking a tool name,
  and `tool-schema-budget.test.ts` guards the result. Reopen only if preset
  sizes start drifting past their budgets.
- **Chasing competitor feature/tool-count parity for its own sake** — see
  `comparisons.md`'s "deliberately NOT chasing" list. Item 1 is the sharper
  version of why: count was never the metric, evidence is.
- **Rewriting CFG/taint analysis onto a real AST/dataflow engine** — real
  gap, correctly filed as a known ceiling, not a roadmap item until
  something forces it (e.g. a security-critical false negative in the wild).
- **Solving Reddit's anti-bot gates** to read our largest referrer — settled
  in `ops/user-signal.md`. It needs a human with a logged-in browser, and
  working around those gates is not something we do.
