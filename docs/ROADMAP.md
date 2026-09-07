---
layout: default
title: Product Roadmap
description: Internal working document. Strategic view of trace-mcp, revised roughly weekly.
noindex: true
---

# Product Roadmap

Strategic view of trace-mcp, revisited roughly weekly by the Product Roadmap
& Vision autopilot, which also turns the items below into that week's
operational focus (see the "This Week's Focus" section of the trace-mcp
Operations project). This file tracks *why* something should move the
product forward — not day-to-day bugs, tool tweaks, or indexing hygiene
(those live as regular issues, tracked by other autopilots). An item is
removed here once it ships, is superseded, or turns out not to matter.

## Where the product stands (revised 2026-09-07)

The 2026-09-05 revision said honest measurement was the only unoccupied
position in this category and that we held the artefacts to take it. We then
ran the measurement it demanded, and it came back against us. That is the
week, and it reorders everything below.

**The quality arm of our one external benchmark missed both preregistered
bars** (TRA-568, PR #1017, merged, shipped in v3.21.0). Same 60 merged
bug-fix PRs from six other people's repositories, same model, same settings,
byte-identical prompts dumped from the token run:

| 60 PRs | naive file loading | trace-mcp | Δ (bar) |
| --- | ---: | ---: | ---: |
| understood the change | 65.0% | **50.0%** | **−15 pp** (allowed −10) |
| false positives per PR | 0.65 | **1.20** | **+0.55** (allowed +0.50) |
| error density | 18.6% | **29.3%** | |
| review latency, median | 90.0 s | 74.5 s | −17% |

**Struck on 2026-09-07 by TRA-1090 — this run measured a defect, not the
product.** The 13 pull requests behind that gap had exactly one thing in
common: the trace arm's context contained no source code at all.
`get_context_bundle` read symbol bodies through a bare `require('node:fs')`,
which throws under ESM and was swallowed by a catch, so the harness — which
imports `src/` as real ESM — assembled signatures only. The shipped build was
never affected. Re-run on the same 60 PRs against the same unmoved bars:
comprehension **65.0% naive vs 66.7% trace** (parity; the sign is in our favour
and 60 PRs cannot make that significant), false positives **0.58 vs 0.80**,
naive-only losses **13 → 3**, latency level at 93 s both ways. Both bars met.
The token figure moved the other way in the same correction: **90.6% → 70.5%**,
median 13,595 → 3,951. Diagnosis: `docs/perf/pr-context-loss-classes.md`.

Everything below that was written from the struck numbers — item 1 in
particular — needs re-deciding on the corrected ones at the next revision of
this file.

Read it precisely, because both over-readings are wrong. It is one task
(reviewing a merged bug-fix PR, where the defect is inside the diff), one
packing strategy (default bundle budget, no `pack_context` tuning — excluded
by that issue's own scope), one judge. It is **not** a verdict that trace-mcp
makes agents worse in general. But it is the only end-to-end quality number
this project has, it is measured better than anyone in this category measures
themselves, and it is the exact failure mode we documented in a competitor
(Codebase-Memory's 10× costing 9 pp of answer quality, TRA-859). Having caught
it in ourselves is worth nothing if we only publish it.

**So the roadmap stops being a publishing problem and becomes a retrieval
problem.** Restating the savings numbers on the corrected basis is done
(TRA-904, TRA-880); the category sentence is written (`ops/positioning.md`,
TRA-906); the counter measures responses instead of multiplying a constant.
The remaining edge is not another honest number — it is the first product
programme aimed at what the numbers say is broken: *what does our packer drop
that a naive read keeps, and can it be fixed to inside the bar?* The levers are
already named and already measured elsewhere: unresolved import edges
(TRA-451 — 13 languages extract imports that never become graph edges),
per-language `resolution_tier` depth, `pack_context` budgeting, and the
over-baseline tool shaping that TRA-952 / TRA-1026 / TRA-1049 started. The
harness that found the gap is the gate that closes it. Item 1.

**The business model got its first real analysis, and its answer is growth
before pricing** (TRA-1047, deepened in TRA-1061, corrected in TRA-1076). At
127 monthly active installs any price yields tens of dollars a month, so
pricing today is a distribution plan with a checkout at the end. Two measured
facts frame it. Demand in the adjacent category is enormous and proven: eleven
free Claude-quota meters hold **38,199 stars** between them, two of them
already native macOS menu-bar apps. Willingness to pay in that same category is
approximately zero: **75,183 stars across eight of those authors, one public
sponsor**. And paid acquisition is closed by arithmetic — measured
impression→install of 0.199% puts CAC at $9.90–80 against $1.51–3.02 of
expected revenue per install. What none of those 38,199 stars does is *give
anything back*: every one of them **measures** consumption, and the only tool
in the lane that **reduces** it is unrelated to code (`pxpipe`, 7,349★,
rendering text as images). We are the only product positioned to say how much
of your weekly limit it handed back. That is a growth wedge, not a paywall —
see "Business model" below, where the decision and its expiry conditions are
written down.

**We can finally name an acquisition channel and count it through to
installs** (TRA-1036). The 2026-09-05 star burst traced to an unsolicited X
post by Dan Kornas (98,495 followers) at 00:28:56 UTC, first burst star at
00:52:39 UTC: 5,003 views → 38 stars → roughly **+10 installs above a +14/day
baseline** (`installs_28d.new` differenced on `origin/adoption-data`), with
`active_users.week` moving 107 → 120 across the same step. That is the first
external event this project has ever traced to the metric of record — and a
correction to the previous run, whose search for a common source could only see
inside GitHub, where a tweet leaves no trace. Directory listings still show
zero attributable arrivals. The listings moratorium stands; effort belongs
where the one measured conversion actually happened.

**The daemon does not currently pay for itself** (TRA-931 baselines, TRA-941).
At nine concurrent sessions the system *with* the daemon holds 804 MB more RSS
(2,449 vs 1,645) and reaches its first answer 1.7× later (3,608 ms vs
2,164 ms; 2.9× at N=1). The daemon costs 528 MB resident while a proxied
session saves only 36 MB, because a proxied session still builds nearly the
whole stack. Its one genuine win is the growth rate — 3.64× versus 9.06× RSS
from N=1 to N=9. This is the same class of finding as the quality gap: a
component whose cost we shipped for months without being able to state it.

**Presets are still 3.5% of the problem**, and the 2026-09-05 decomposition
(TRA-726) stands unchanged: client native tools 41%, client system prompt 14%,
third-party MCP servers 17%, instruction files 16%, hooks and skill listings
11%, trace-mcp schemas 3.5%. The Read/Bash mirrors (77% of the paid band, 52%
compression, 0 pp solve-rate change over 108 live runs) and the startup-text
compressor remain the larger levers.

**The rename stays closed.** TRA-879's search data — 83% of organic clicks are
some spelling of the name, zero clicks from any query describing what the
product does — is unchanged, and TRA-974/TRA-1025 turned the second-largest
impression source into a page instead of a collision. Nothing public moves.

## The two numbers this roadmap is now about

**50% and 127.**

The first is comprehension in the quality arm — half the PRs where the agent,
given our context, did not understand the change, against 65% for a naive
read. Everything downstream of install is capped by it. An install that
reaches value and is served a worse answer is worse than no install, and no
amount of reach fixes it. Item 1.

The second is monthly active installs (2026-09-06 snapshot: 34 day / 120 week /
127 month, `days_observed: 9`, `month_window_full: false` — still filling, so
not growth and not to be graded as such). 89 first-ever pings in 28 days. It is
the denominator every business-model number divides by, and the reason the
answer to monetization this quarter is "grow first".

Between them sits the funnel, and **four of its five stages still read
`null`** for reasons entirely outside our code: six event fields the ping
already sends are unregistered in the GA4 property and one PAT is unset
(TRA-886, which owns the ask — do not open another). GA4 does not backfill, so
every day of waiting is deleted rather than delayed. One thing did improve on
its own: `client_reporting.readable` is now **true at 51%** (was false at 37%),
because the field is finally upgrading past v3.12.0. The client-portability
question is now readable-in-principle and blocked only on the `calls`
dimension.

The production ratio is unchanged and still the argument: 28 autopilots
shipping at a rate almost nothing else matches, for roughly 127 users.

## Adoption — metric of record

The adoption metric of record is **active installs**, from the anonymous
daily ping in `src/telemetry/usage-ping.ts` (one event per install per UTC
day, opt-out via `TRACE_MCP_TELEMETRY=off`). Read it in the GA4 property
`G-WSYYT2WZJV` (account `Nikolai`, property `551114458` — note the login also
holds unrelated properties; do not write to those).

**Do not refresh this by hand.** `.github/workflows/ga4-snapshot.yml` pulls the
numbers daily via the GA4 Data API and publishes them to the
[`adoption-data`](https://github.com/nikolai-vysotskyi/trace-mcp/blob/adoption-data/adoption.yml)
branch, plus each run's job summary. That branch is the durable record: GA4
keeps event data for 14 months at most, so anything older survives only there.
It is deliberately not on `master`: a PR opened by `GITHUB_TOKEN` never
triggers CI, so it could never satisfy the required checks.

**`by_preset` / `by_tools_advertised` — pending, one manual step** (TRA-643).
The ping now reports the resolved preset and the size of the surface it
advertised, on the same basis `preset-surface-budget.test.ts` measures (preset
members plus the ten ungated meta-tools; verified against a live `tools/list`
at minimal 28 / design 21 / standard 55). That turns the published "67-86%
preset saving" from a bench claim into a field one, and makes the silent
`full` → `standard` default migration (TRA-538) observable for the first time.
Both sections stay empty until `preset` and `tools_advertised` are registered
as **event-scoped custom dimensions** in GA4 property `551114458` (Admin →
Custom definitions → Create custom dimension; event parameter names exactly
`preset` and `tools_advertised`). GA4 does not backfill, so the series starts
at registration, not at release. Until then the snapshot degrades to two empty
sections rather than failing — the reports are wrapped so an unregistered
dimension cannot take the daily snapshot down with it.

**How to read `by_client`, and why `unknown` is not a share of installs**
(TRA-643, 2026-09-02). Two separate things produce a missing client, and the
snapshot used to hide one of them:

- `"unknown"` is a value the install *sent* — its telemetry state had no client
  name when the ping fired. Until this issue that was mostly our own bug: the
  ping's final `saveState` persisted a snapshot taken *before* the HTTP request,
  so the name `recordUsagePingClient` wrote while the request was in flight was
  erased. The client's `initialize` lands mid-flight on essentially every
  session, so an install whose only session of the day was the one that pinged
  never recorded a client at all, and reported `unknown` again the next day,
  forever. Only installs that opened a *second* session on some day — after
  that day's ping had already been sent and the ping short-circuited — ever
  escaped. Fixed and covered by a regression test in
  `src/telemetry/__tests__/usage-ping.test.ts`.
- `(not set)` is GA4 having no value at all. The snapshot script silently
  dropped those rows, which is why the 2026-09-01 file shows `by_client`
  summing to 36 against 61 monthly active users, `by_version` to 34, and
  `installs_28d` to 59 events against `events_28d: 310`. The gap was not
  visible and not explained. `(not set)` is now kept as its own key.

So the "41% of installs report no client" reading (25 of 61) used a denominator
that never applied: 61 is every active user, while 25 sits inside a breakdown
that only covers 36 of them. Do not divide a `customEvent:` breakdown by
`active_users` — divide it by that breakdown's own total, and read the residue
as `(not set)`.

Caveat when citing it: the ping's credentials ship in plaintext inside the
published npm package (public by design — see SECURITY.md "Telemetry
Credentials"), so the events are **unauthenticated and can be inflated by
anyone**. Active installs is the best adoption signal we have, not an
auditable one; read it as a trend, and treat a sudden step change as
suspect until corroborated.

| Date | Active installs (day / week / month) | Notes |
| --- | --- | --- |
| 2026-08-28 | _pending GA4 read access_ | Ping verified end to end against the Measurement Protocol debug endpoint. |
| 2026-09-01 | **54 / 61 / 61** | First real read. 310 events in 28 days; 15 new installs, 8 returning, 5 upgrades, 31 unattributed. 11 countries. Clients: 25 unknown, 8 claude-code, 2 codex, 1 grok. Versions seen: 3.8.0 (17), 3.10.0 (13), 3.7.0 (2), 3.6.0 (1), 3.5.2 (1). |
| 2026-09-03 | **39 / 90 / 90** | |
| 2026-09-04 | **39 / 102 / 102** | |
| 2026-09-05 | **22 / 107 / 107** | `days_observed: 8`. `savings.inflation_suspected: true` at `raw_ratio: 3.78`, 2 of 7 days capped. Clients placed: 17 claude-code, 7 codex, 1 each antigravity / grok / opencode / pi — but `client_reporting.readable: false` at 37%. Versions: 3.10.0 (28), 3.11.0 (24), 3.15.0 (23), 3.8.0 (21), 3.14.0 (16), 3.17.1 (5); 3.9.0 still absent. |
| 2026-09-06 | **34 / 120 / 127** | `days_observed: 9`, window still filling. 612 events in 28 days; 89 first-ever pings. `savings` re-based on the measured counter: 14,402,995 tokens over 1 day, `raw_ratio: 1`, `inflation_suspected: false`, 0 capped days — not comparable to anything before 2026-09-05. `client_reporting.readable` **true at 51%** (80 at or above v3.12.0, 78 below, 36 unknown). Versions: 3.10.0 (28), 3.11.0 (25), 3.15.0 (25), 3.17.1 (22), 3.8.0 (21), 3.14.0 (16), 3.18.0 (13), 3.19.0 (2). |

**`savings.tokens_saved` in that file is not comparable across 2026-09-05.**
Until PR #915 the counter was `RAW_COST_ESTIMATES[tool] × 0.15`, booked before
the tool ran, so it was the call count restated — 41% of it survived
measurement against real responses (TRA-880, and the per-tool table in
`docs/perf/response-tokens.md`). Figures published before that date are
overstated roughly 2.4x by construction, independently of the inflation
tripwire above. Do not splice the two series.

**The month column does not yet cover a month** (TRA-843). The property holds
about two weeks of pings: the ping only reached published builds on 2026-08-23
(#336), and the savings query, whose start date is 2025-01-01, comes back with
six days of rows. A 28-day window over a fortnight of data climbs as it fills,
so **61 → 90 → 102 is not a step change in adoption** — do not grade it as
growth. The snapshot now publishes `active_users.first_ping_date`,
`days_observed` and `month_window_full`, and withholds
`funnel.retention_dau_mau_pct` until the last is true; the 38–43% quoted before
that was day-over-fortnight, not DAU/MAU.

Note what does *not* prove this, because the first attempt at the fix used it
and was wrong: `week == month` in both snapshots is **not** evidence that the
window is unfilled. `activeUsers` is a distinct-user count, so equality only
says the older period's users are a subset of this week's — a mature property
whose whole audience returned weekly reads the same, and a single non-returning
day-8 user makes `month > week` on a ten-day-old property. The age of the data
is the only thing that answers it, which is why the gate reads that directly.

Also corrected there: GA4 date ranges are inclusive at both ends, so every
window in the snapshot was a day longer than its label — `day` was two days and
the "28-day" month was 29. Figures published before 2026-09-05 carry that.

Two things the first read is already telling us, both actionable and both
picked up as items below:

- **Client attribution was broken, and the "41%" that named it was not a
  real number.** 25 of 61 was read as a share of installs; 25 sits inside a
  breakdown that only covers 36 of those 61, because the snapshot script
  dropped GA4's `(not set)` rows. Underneath it was our own bug: the ping's
  final state save erased the client name recorded while the request was in
  flight, so any install whose only session of the day was the one that
  pinged stayed `unknown` forever. Both fixed in TRA-643, which also added
  the missing `preset` / `tools_advertised` fields — so the flagship
  efficiency claim (67–86%) moves from bench-verified to field-verifiable
  once the GA4 dimensions are registered. Item 1.
- **Version spread is wider than a 12-release week should produce.** More
  installs are seen on 3.8.0 than on 3.10.0, and 3.9.0 does not appear at
  all — which is consistent with TRA-566 (v3.9.0 shipped with no Windows
  assets and no `latest.yml`, so Windows updates were silently dead), but
  is not yet proven to be that. Worth attributing before assuming it is
  benign.

**npm weekly downloads are not an adoption metric** and should not be cited
as one. Settled twice (TRA-273, TRA-413): all published versions cluster at
a near-uniform weekly count while the median version has ~2 real installs,
and day-old releases hit parity with month-old ones instantly. That is a
mirror sweeping the version history. **Git clones are out too** (TRA-540): a
14-day clone count two orders of magnitude above human page views, which stayed
flat across the same window, with unique *cloners* inflating alongside the raw
count. The figures are in `ops/arrivals.md` in the private repo.

The public-facing metric of record is therefore **active installs, GitHub
stars, and traffic *views* uniques** — nothing else. Listing-by-listing state
lives in `ops/distribution.md`, still in this repo. The current values, and the
channel-by-channel state behind them, moved to
[`trace-mcp-private`](https://github.com/nikolai-vysotskyi/trace-mcp-private) on
2026-09-05 (`ops/user-signal.md`, `ops/arrivals.md`).

### The funnel — five numbers around that denominator (TRA-645, TRA-673)

Active installs is a denominator with nothing on either side of it. Without
that, every listing rewrite, hero redesign, README restructure and outreach PR
is graded on taste. Five numbers fix it, one per stage:

| Stage | Number | Source | Window |
| --- | --- | --- | --- |
| Arrivals | unique visitors to the GitHub repo | `acquisition.views_uniques_14d` | rolling 14 d |
| Installs | first-ever pings | `installs_28d.new` | 28 d |
| Activation | % of active installs with ≥1 indexed repository | `activation.activated_pct` | 28 d |
| Use | % of active installs that called a tool at all | `usage.used_pct` | 28 d |
| Retention | day ÷ month active installs | `funnel.retention_dau_mau_pct` | 1 d over 28 d |

Retention publishes as `null` until the property holds 28 days of pings
(TRA-843). Over a window with a fortnight of data in it, day ÷ month is a much
larger ratio than DAU/MAU and not comparable to anyone else's; the 38–43% read
off the first snapshots was that.

**Activation and use are two stages, not two readings of one** (TRA-673).
`repos_indexed` says an install completed *setup*; an install that indexed a
repo in July and has not called a tool since still counts as activated. The
ping has carried `calls` — trace-mcp tool calls since the previous ping,
counted by the MCP server itself and therefore comparable across clients —
since it was written, and no report read it. `scripts/ga4-snapshot.mjs` now
does. The published figure is `used_pct`, a per-install boolean, and never a
call total: the ping's credentials are public, so a summed counter is
inflatable exactly like `tokens_saved`, while a boolean is bounded above by
`active_users` and costs one forged install per point.

`usage.by_client_used_pct` is the number with a strategy attached. The
mechanism that actually routes an agent to our tools — the PreToolUse guard
hook — is Claude Code only, Cursor and Windsurf get a rules file, and every
other client gets tool descriptions, which ask rather than route. Session
mining has providers for two clients. If use holds across clients, the hook is
a nice-to-have and reach work goes wide; if it collapses without one, our
addressable market is clients that can enforce routing, and a large share of
current distribution effort points at installs that will never reach value. We
ship into MCP directories on a premise of client neutrality and have never
tested it. **Read the answer beside `by_client_installs`** — the client
breakdown we have is small enough to conclude nothing, and most of its rows are
`unknown` for a reason the ping's own design explains: `state.client` is a single
field overwritten at each `initialize`, so a machine running several clients
reports whichever one handshook last.

**Do not refresh these by hand either.** All of them are computed by the same
daily `ga4-snapshot.yml` run and published under `funnel:` in
[`adoption-data`](https://github.com/nikolai-vysotskyi/trace-mcp/blob/adoption-data/adoption.yml) —
that file is where a weekly run reads them, not this page, and the current
values are not repeated here — see `ops/arrivals.md` in the private repo.
Activation and use are both still blocked on the credentials below.

**Two credentials stand between this and all five numbers**, both verified
against the live property by a `workflow_dispatch` on 2026-09-02
([run 33556680379](https://github.com/nikolai-vysotskyi/trace-mcp/actions/runs/33556680379)).
Neither is a design question; do not re-investigate them, and do not read the
resulting `null`s as zeros.

1. **`repos_indexed` is not a registered GA4 custom dimension.** The ping has
   been sending it all along and GA4 has been dropping it: `runReport` answers
   *"Field customEvent:repos_indexed is not a valid dimension"*, and registration
   is **not retroactive**, so every reading before it is created is
   unrecoverable — the sooner it exists, the sooner activation has history.
   Registered today: `version`, `client`, `install_type`, `model`. Creating it
   is one form in GA4 Admin → Custom definitions (event scope, parameter name
   `repos_indexed`). Automating it was tried and reverted: the Admin API is not
   enabled on the credential's GCP project (480706841486), so the script could
   only have logged a failure once a day. **The same form now covers four
   parameters, not one** — `repos_indexed`, `preset` and `tools_advertised`
   (TRA-643), plus `calls` (TRA-673). Those four are event-scoped custom
   *dimensions*; `calls` is read as a dimension deliberately, because the Data
   API has no `client_id` and a summed metric can therefore never yield the
   per-install boolean the use stage is built on. **Since TRA-671 the same form
   also owes two custom *metrics*** — `daemon_starts` and its unclean-stop
   companion, which is why `daemon` in the snapshot answers *"is not a valid
   metric"*. Six fields, one admin session, and every day before it is
   unrecoverable for all six. The ask is owned by **TRA-886**; do not open
   another.
2. **`GH_TRAFFIC_TOKEN` is unset.** GitHub's traffic endpoints require
   `Administration: read`, a permission `GITHUB_TOKEN` cannot be granted, so the
   workflow gets HTTP 403 and records that in `acquisition.error`. A
   fine-grained PAT on this repo with that one permission fills it. Until then
   arrivals must be read by hand with the `gh api` calls in
   `ops/distribution.md`, and nothing accumulates — GitHub's window is 14 days
   and drops what falls out of it.

Three things to keep attached to them. The windows differ, so arrivals →
installs is a direction and not a conversion rate. The ping's credentials are
public, so all of them are inflatable and are a trend, not an audit. And both
`activated_pct` and `used_pct` are taken against their own buckets rather than
against `active_users.month`, because GA4 deduplicates active users within a
dimension value and not across them — an install that indexes its first
repository or makes its first call mid-window is counted on both sides.

Use is the one to watch — activation was, until it became clear activation only
measures setup. Every efficiency number we publish assumes the agent calls our
tools instead of reading files; `used_pct` is the only number that says whether
it does. It is the ceiling on everything downstream of install, and the gap
between `activated_pct` and `used_pct` is the population that reached the
product and stopped.

**The one read-back this is for**, once a snapshot carries it: what share of
active installs called a tool at all in the window, and whether that share
differs between hook-capable and hook-less clients. Write the answer here.

**Activation measures setup, not use — and the number that measures use is
already in the payload** (found 2026-09-02, item 5). `repos_indexed` says an
install once registered a project. It does not say the agent ever called a
tool again. The ping has carried the second number since it was written:
`calls`, the count of trace-mcp tool calls since the previous ping
(`src/savings.ts` `recordCall` → `usage-ping.ts:229-250`). It is a per-tool-call
counter kept by the MCP server itself, so it is comparable across clients. It
appears **zero times in `scripts/ga4-snapshot.mjs`** — the only ping field of
substance no report has ever read. Nothing above should be read as "installs
are using the product"; so far we know they installed it.

Acquisition already has a finding, and it is the strongest argument this page
makes about where effort should go: repeated 14-day windows agree that the
directory listings are not where arrivals come from. New distribution effort
belongs where the arrivals actually are. The readings, the sources they name and
the limits on that conclusion are in `ops/arrivals.md` in the private repo —
read it before planning any listings work.

## Ready to start

Items 1, 2 and 4 of the 2026-09-05 revision are done: the savings figures are
restated on the corrected basis (TRA-904), the quality arm ran (TRA-568), and
the category sentence is written (TRA-906, `ops/positioning.md`). What replaces
them is what those results created.

### 1. Close the quality gap — the packer, graded on the harness that found it (new, TRA-1090)
−15 pp comprehension and +0.55 false positives per PR is the largest open
product defect this project has, and it is invisible to every test we run:
10,372 unit tests pass while the assembled context loses to `cat`.

**Why this is item 1 and nothing else is.** Every efficiency claim we publish,
every listing one-liner, every hero number, and the whole "honest measurement"
position assumes the cheaper context is *as good*. We now have evidence it is
not, in the one measurement of ours that uses other people's repositories. The
asset is not the finding — it is being the only product in the category with a
harness that can grade a fix.

Work, in order: diagnose before tuning — take the 13 PRs the naive arm
understood and ours did not and classify *what was missing* (an unresolved
import edge, a symbol below the bundle budget, a file never retrieved, a
truncated body); fix the largest class; re-run the same 60 PRs; publish the
delta whichever way it goes. Bars stay as preregistered (≤10 pp, ≤+0.50 FP).
Named suspects with existing measurements: TRA-451 (13 languages whose imports
never become edges), per-language `resolution_tier` depth, `pack_context`
budgeting, and the over-baseline tool shaping of TRA-952/1026/1049. Wire the
harness into CI as a gate on the retrieval path once one arm can move it.

### 2. Give the quota back visibly — the free wedge into a 38,199-star demand pool (new, TRA-1091)
Eleven free tools that *measure* Claude quota consumption hold 38,199 stars;
we have 159. Not one of them returns any of it. trace-mcp does, and never says
so where a user can see it: `savings.tokens_saved` goes to a GA4 ping, and the
number a user could repeat — "trace-mcp handed back N tokens of your week" —
exists nowhere in the CLI, the app, or the client session.

This is a growth item, not a pricing item (see Business model). It is the only
place where our actual mechanism and a proven, enormous, already-searching
demand overlap. Ship it free, per install, locally computed, no account. Gate
it on the same discipline as everything else: the number shown must be the
measured one (post-TRA-880 basis), never the pre-correction identity.

### 3. Unblock the funnel — six fields and one token (TRA-886, owns the ask)
Unchanged and still blocked. Four event-scoped custom **dimensions**
(`repos_indexed`, `calls`, `preset`, `tools_advertised`), two custom
**metrics** (`daemon_starts` and its unclean-stop companion) and one
fine-grained PAT with `Administration: read`. Causes are settled; do not
re-investigate them and do not open a fourth issue. Every unregistered day is
unrecoverable, and it blocks the preset field check, the use-vs-setup split,
the daemon field signal (TRA-671, shipped and reading zero), and every arrivals
judgement distribution and SEO currently make on taste.

### 4. Decide what the daemon is for, in numbers (TRA-941 follow-through)
At N=9 the daemon costs 804 MB and 1.7× time-to-first-answer and buys a 2.5×
slower memory growth curve. Either the proxied session gets radically cheaper,
or the daemon does, or the default changes. TRA-948 already proved the first
answer need not wait for it. This is an architecture decision with measurements
attached, not a perf ticket — write the answer down where the app's defaults
are set.

### 5. Answer client portability the moment `calls` is registered (TRA-673 follow-through)
Half-unblocked this week: `client_reporting.readable` flipped to true at 51%,
so the split is now readable-in-principle. It still needs the `calls`
dimension from item 3. The stakes are unchanged and opposite: if tool use holds
across clients, reach goes wide; if it collapses without the PreToolUse hook,
our addressable market is clients that can enforce routing and a large share of
distribution effort points at installs that will never reach value. Do not
conclude from `by_client_used_pct` before both halves are true.

## Business model — decided 2026-09-07, revisit at 800 MAU

First real analysis: TRA-1047, deepened in TRA-1061, corrected in TRA-1076.
The decision, so no run re-litigates it:

- **No paywall, no pricing page, no sponsor drive as a strategy this quarter.**
  At 127 MAU every pricing model in the shortlist lands within noise of $38/mo,
  and the adjacent category is evidence that stars do not convert: 75,183 stars
  across eight authors of free quota meters, one public sponsor (a floor —
  private sponsors are invisible — but not one that overturns the order of
  magnitude). Building a 3–4 week paywall before distribution exists is the
  most expensive available mistake.
- **Paid acquisition is closed arithmetically**, not by preference: measured
  impression→install 0.199%, CAC $9.90–80 against $1.51–3.02 expected revenue
  per install. Do not propose ad spend without moving one of those two numbers
  first.
- **The wedge is "reduces" against 38,199 stars of "measures"** — item 2 above,
  shipped free.
- **Hardware-as-rental (the Darkbloom M5 Ultra comparison) is not this
  product's business** and does not belong in this roadmap. TRA-1047's original
  arithmetic was wrong on both sides and TRA-1076 corrected it against
  Nikolai's own observed earnings; whatever its merits, it is a separate
  operation.
- **Revisit condition, written now so it is not a matter of mood:** ~800 MAU,
  or a `used_pct` reading that shows the product is actually used, whichever
  comes first.

## Big bets — design pass before any code

### 6. One door instead of 181 — a router preset (TRA-646, design done, unbuilt)
Unchanged in substance and still the right shape: advertise a router plus a
catalog (`plan_turn` and `load_tools` already exist) so the advertised surface
stops scaling with the tool count. codegraph (68.7K★) advertises **one** of its
eight tools by default at ~1.9K tokens total, and its stated reason in source
is not token cost but that *presence itself steers mis-picks*.

The 3.5% schema row bounds the token prize, so this is a routing-quality play,
not a top-line efficiency one — and after TRA-568 that reads differently than
it did a week ago: mis-picks are now a measured product defect, not a
hypothesis. The cheap open question is unchanged and A/B-able today with
`load_tools` as it stands: does a model reliably reach for a tool it cannot
see? Ships as a preset (`router`), so no contract break. Sequence behind items
1–3.

### 7. Read the State Engine A/B sceptically before publishing it (TRA-1008)
The engine is merged (TRA-884), the MCP prompt is wired (TRA-799), and the A/B
reports −66.8% prompt tokens, −59.2% total, O(T) instead of O(T²) growth, loops
2.7% → 0.0%. It also reports **Pass@1 100% in both arms** over 18 pinned tasks
and 777 steps. Equal success at a ceiling means task success was never at risk
in that harness: the run demonstrates compression and does not demonstrate that
compression is free.

TRA-568 is what that sentence looks like when someone finally checks — same
shape of claim, and the answer was −15 pp. `docs/SKILL_STATE.md` is correctly
held (TRA-1008) until an arm exists where the baseline can fail. Do not
publish the token half alone. The positioning half is settled
(`ops/positioning.md`): `trace_state_*` stays behind the tool surface and does
not get its own door.

### 8. Decide what the desktop app is for (new)
The Electron app is the largest surface we maintain and the least evidenced.
Across 148 releases it has **6 `.dmg` downloads** against 793 `mac.zip` and 987
auto-updater polls for `latest-mac.yml` (`gh api .../releases --paginate`,
counted in TRA-1047), and **zero public reviews of it exist anywhere**
(`ops/user-signal.md`, private repo). One QA pass over an installed v3.22.0
(TRA-1059) produced seven confirmed defects and roughly twenty open tickets —
projects pointing at deleted directories counted as healthy, an empty project
graded A, analytics three days stale reporting `stale: false`.

Both readings are live and neither has been argued: it is either door number
two for people who will never edit a JSON config — in which case those twenty
tickets are the roadmap and it needs a first-run funnel measured like any
other — or it is a demo of the daemon that costs a fifth of our defect budget.
The numbers above make the question answerable; nobody has asked it. Cheapest
first step: the app's own installs are already distinguishable in the ping
(`install_type`), so read them before arguing.

### 9. Team-shared graph — parked, needs Nikolai's go-ahead (TRA-128)
Unchanged. The design pass is done and stays valid; its smallest slice is a
network-reachable server component, which is in the one category reserved for
Nikolai's explicit call. **Correctly parked, not stalled** — and with 127
installs across 20 countries and no evidence of a single multi-seat user, there
is still no demand-side reason to unpark it.

## Explicitly not doing right now

- **Deterministic codemods (the former big bet 6) — killed by its own gate.**
  TRA-862 measured 8,843 Edit/MultiEdit payloads across 2,766 session
  transcripts: 14.5% are deterministically expressible as a generous upper
  bound, and only **0.8% both expressible and repeated** (≥3 edits of one shape
  across ≥2 files in a session), against the 30% the bet assumed. The largest
  repeating group in 935 editing sessions is six edits over six files. The
  failure was not "too few mechanical edits" but that they do not repeat, and a
  one-off mechanical edit costs more through a codemod than through the Edit it
  replaces. Threshold sweeps in the feature's favour cap it below 1.5%. Do not
  reopen without a new corpus and a new measurement; the harness is in PR #905.
- **A paywall, a pricing page, or paid acquisition** — see Business model
  above; the revisit condition is written there.
- **Tool consolidation as a token play.** Superseded by presets. Only merge two
  tools if they are genuinely the same tool.
- **Moving any public occurrence of the name.** TRA-879 closed this with data.
  The CLI verb, the server key and `~/.trace` are on disk and unindexed;
  everything a search engine or a human types stays `trace-mcp`.
- **Chasing competitor feature/tool-count parity.** Count was never the metric
  in either direction.
- **Quoting the token saving without the quality result beside it.**
  `docs/pr-context-benchmark.md` now carries both, at their corrected values
  (70.5% and parity on comprehension); any surface that carries one carries the
  other.
- **Publishing the State Engine A/B as a value claim** before an arm exists
  where the baseline can fail (item 7).
- **Rewriting CFG/taint analysis onto a real AST/dataflow engine** — a real
  ceiling, filed in `comparisons.md`, not a roadmap item until something forces
  it.
- **Adding language #82 or framework #88 as a headline.** Per-language edge
  *resolution depth* (`resolution_tier`, already stored) is the claim worth
  making — and after TRA-568 it is also a suspect in the quality gap, which is
  a better reason to publish it than marketing ever was.
- **A paid end-to-end benchmark run.** Budget approval was withdrawn
  2026-09-04 (TRA-778). The quality arm was run without it on the `claude` CLI
  headless transport (TRA-568) — that route works; use it.
