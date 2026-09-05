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

## Where the product stands (revised 2026-09-05)

The 2026-09-02 revision said the engine room was not the problem and the
binding gap was reach and first value. That still holds. What changed in
three days is *what we know about our own numbers*, and it is large enough
that it reorders everything below.

**The headline savings counter was an arithmetic identity, not a
measurement** (TRA-880, PR #915, merged). `SavingsTracker.recordCall` ran
*before* the tool executed, so every call could only be scored as
`RAW_COST_ESTIMATES[name] × 0.15`. In a real store: 5,123 `search_text`
calls, 13,063,650 tokens "saved" — exactly 2,550 each, zero variance. That
counter is on the homepage, in the README, and rides the usage ping.
Measured against real `tools/call` responses on the wire, across twelve
tools covering 17,947 of 20,187 recorded calls: **23,048,005 claimed vs
9,547,447 measured — 41%**. The 0.15 constant is off by 2.5–10x on the four
tools that are 94% of all calls, and **four of twelve tools return more
tokens than the baseline they were credited with replacing** while booking a
positive number on every call. Fixed by estimate-then-reconcile; the
published counter goes down and now reports a measurement. Everything this
project published about aggregate savings before 2026-09-05 carries that.

**The same week told us the whole category does this** (TRA-855 / TRA-859).
No competitor has demonstrated an honest order of magnitude on a solved
end-to-end task: published 10× figures exist only on isolated slices, and
Codebase-Memory's is paid for with answer quality falling 92% → 83%. An
independent JetBrains audit (July 2026, 80 paired tasks in Claude Code)
found `rtk` **increased** task cost by 7.6% against a claimed 60–90% saving,
because mutating terminal output broke Anthropic's prefix cache ($3.75/M
write vs $0.30/M read). The real ceiling of leading products and papers is
**1.3–1.6× per task** (Augment −32% tokens on SWE-bench Pro; HCP 50K → 8K on
dependency context; EET −32% cost).

Put those two together and the strategic conclusion is not "we were wrong".
It is that **honest measurement is the only unoccupied position in this
category**, we now hold the two artefacts that occupy it — a corrected
counter and TRA-534's 90.6% median measured on 60 merged PRs from six
*other people's* repositories — and nobody else does. Items 1 and 2 below
are about putting that where a visitor sees it, with its quality arm
attached so it is not the thing we criticise peers for.

**Presets moved 3.5% of the problem.** The E6 decomposition of a real
startup block (TRA-726, median 62K on the owner's machine) reads: client
native tools 41%, client system prompt 14%, third-party MCP servers 17%,
CLAUDE.md/instruction files 16%, hooks and skill listings 11%, **trace-mcp
schemas 3.5%**. The flagship 67–86% preset win is 67–86% of that last row.
Roughly 44% of the block is reachable by us and almost none of it is our
schemas. Two mechanisms shipped this week aim at the reachable part and are
measured, not assumed: Read/Bash **mirrors** (TRA-749/750) hold 77% of the
paid Read/Bash mass with 52% compression on the band and **0 pp solve-rate
change** across 108 live runs, and the **startup-text compressor**
(TRA-759/770) addresses the 27% of the block that is instruction and hook
text. Both are bigger levers than the tool surface ever was. See item 4 —
this is a category question, not a feature list.

**The rename evidence flipped, and it confirms the decision rather than
reopening it** (TRA-879). Thirty days of GSC data for `sc-domain:trace-mcp.com`:
53 clicks total, 41 of them (77%) from the exact strings `trace-mcp` and
`trace mcp`, 83% from some variant of the name, and **zero clicks from any
query describing what the product does**. Two of the three largest
impression sources are collisions we already lose — `traceix mcp` (61
impressions, 0 clicks) and `mcp tracing` (54 impressions, 0 clicks, a
different category entirely). So the boundary fixed in
`ops/rename-to-trace.md` — short name only on things that live on a
developer's own disk, `trace-mcp` everywhere public — is now backed by
search data, not just by the 0.74–1.23% token measurement. Nothing that a
search engine or a human types may move.

## The one thing this roadmap is now about

We can read the adoption metric of record, and on 2026-09-05 it says **107
monthly active installs** against 22 daily — with the 28-day window still
filling (`days_observed: 8`, `month_window_full: false`), so that is not
growth and must not be graded as such.

Beside it: **four of the funnel's five stages read `null`**, and not one of
them for a reason in our code. Six event fields the ping already sends are
unregistered in the GA4 property and one PAT is unset (TRA-747, TRA-886).
GA4 does not backfill, so every day this waits is deleted, not delayed.
Five of this week's twenty focus items depend on it.

The production ratio is unchanged and still the argument: 27 autopilots
shipping at a rate almost nothing else matches, for roughly a hundred
users. The next weeks of *strategic* work are measured in users reaching
first value and in numbers we can defend when someone checks them — not in
capability shipped.

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

The five items the 2026-09-02 revision listed here are all `done`
(TRA-643, 644, 645, 646, 647, 673). What replaces them is shaped by the
measurement findings above, not by a fresh idea list.

### 1. Restate every published savings number on the corrected basis (new, TRA-904)
TRA-880 changed what `tokens_saved` means, and the correction is a
reduction. Right now the homepage, the README, `server.json`, the ten
external listings and the daily ping quote a figure produced by
`calls × constant`. Leaving them is not neutral: it is publishing a number
we have internally disproved.

**Why this is item 1 and not documentation hygiene.** The one position
nobody in this category occupies is honest measurement (see above). We
cannot take it while our own storefront carries the inflated figure — and
we get the credibility *only* if we say why it moved, in public, rather
than letting it quietly re-render. The correction is the asset.

Work: sweep every published savings figure to a generated source; where the
number moves, say so in `CHANGELOG.md` and on the page; extend the
`readme-claims` guard so a savings or benchmark figure that is not read from
a generated data file fails CI (TRA-762 was the same defect in the
benchmark prose and was caught by a human read, not by a test). Note
`adoption.yml` also carries `inflation_suspected: true` at
`raw_ratio: 3.78` — two of seven days capped — so the field aggregate is
compromised on a second, independent axis and must be cited with that.

### 2. Ship the quality arm of the one external benchmark (TRA-568, unblocked here)
TRA-534 is the only number this project has that was not produced by the
tool measuring itself on its own repository: median 13,595 → 1,326 input
tokens (90.6%) across 60 merged bug-fix PRs from six OSS repos, p90 44,246 →
3,667. TRA-883 put it into the registry one-liners. It is still a token
number without a quality number.

That is precisely the move TRA-859 catches competitors making — and
Codebase-Memory's 10× costing 9 pp of answer quality is the exact failure
mode. **A token number without a quality number is an efficiency claim, not
a value claim.** TRA-568 has sat `blocked` for a week; the paid end-to-end
design was cancelled for budget (TRA-778), so it must be re-scoped to what a
subscription can run — TRA-778's option 1 (localisation rather than
solution, 5–15 requests per task instead of 220) with its contamination
caveat stated in the same breath, or option 2's 12–15 task end-to-end run.
Pick one, run it, publish the result including a negative one.

### 3. Unblock the funnel — six fields and one token (TRA-886, owns the ask)
Four of five stages `null`; `activation`, `usage` and `daemon` return error
strings instead of data; `acquisition` returns HTTP 403. Cause is entirely
outside our code: four event-scoped custom **dimensions** (`repos_indexed`,
`calls`, `preset`, `tools_advertised`), two custom **metrics**
(`daemon_starts`, unclean stops) and one fine-grained PAT with
`Administration: read`. **TRA-886 owns this ask — do not open a fourth
issue for it, and do not re-investigate the causes; they are settled.**

Every day unregistered is unrecoverable, and it blocks: the preset field
check (item 1's companion), the use-vs-setup question (item 5 below), the
daemon field signal (TRA-671, shipped and reading zero), and every arrivals
judgement the distribution and SEO work is currently making on taste.

### 4. Name the category the product actually moved into (new, TRA-906)
Three mechanisms now ship under one binary and only one of them is code
intelligence: the graph and its tools, the Read/Bash **mirrors**, and the
**startup-text compressor** — plus `trace_state_*` (item 8). The
decomposition above says the schema surface we lead with is 3.5% of the
context an agent actually pays for, and the two new mechanisms sit on much
larger shares with measured, gated results behind them.

Every public surface still describes a code-graph MCP server. That was
accurate in June. The question this item answers is whether trace-mcp is
"a code graph for your agent" or "the thing that manages an agent's context
budget end to end" — and if it is the second, the homepage, README,
`server.json` and every listing describe a fraction of the product.

**Positioning pass, not code.** One sentence a user repeats; what falls out
of the surface if it does not fit; whether the mirrors and the compressor
need their own door or belong behind the same one. This supersedes the
narrower version of the same question asked about the State Engine alone
(item 8) — answer them together or the answer is two products by default.

### 5. Answer the client-portability question the moment it becomes readable (TRA-673 follow-through)
The mechanism that actually routes an agent to our tools is the PreToolUse
guard hook, and it is Claude Code only; Cursor and Windsurf get a rules
file; everyone else gets tool descriptions, which ask rather than route.
Session mining has two providers. We ship into MCP directories on a premise
of client neutrality we have never tested.

**Two things now stand between us and the answer, and only one is item 3.**
`client_reporting.readable` is `false` at **37%**: installs below v3.12.0
report `unknown` whatever they run, because of the ping bug TRA-643 fixed,
and the field is still 63% below that line. So the client split will be
*readable* before it is *representative*. That makes upgrade lag a
strategic blocker rather than a hygiene item — see the weekly focus for
Update Health. Do not conclude anything from `by_client_used_pct` while
`readable` is false; re-read and record.

The stakes are unchanged and opposite: if use holds across clients, reach
goes wide; if it collapses without a hook, our addressable market is
clients that can enforce routing and half of current distribution effort
points at installs that will never reach value.

## Big bets — design pass before any code

### 6. Deterministic codemods on the local CPU — the one unoccupied niche (new, TRA-862)
Top of the TRA-855 intelligence ranking, and the only gap the market read
found: **every competitor is read-only** — codegraph, codebase-memory-mcp,
Serena, Context Mode. Nobody does bulk edits by deterministic parsing.

The argument is sharper than compression: work done by code costs **zero**
tokens, not few. Renaming a symbol across its uses, adding a parameter to
every call site, replacing a deprecated API, adding a field and fixing its
readers — today an agent does these by reasoning, file by file, with the
whole transcript in context. We already hold the parsed tree, the symbol
graph and the located uses; what is missing is applying the edit, not
computing it.

**The gate before any code is a measurement, and it can kill the bet.**
TRA-705 estimated 30% of edit work as mechanical and flagged the estimate
as unproven — it came from the share of Edit payloads, not from reading
what those edits were. Get it honestly: classify real edit sequences in a
corpus by whether a deterministic transformation expresses them. If the
mechanical share is small, the bet does not repay the build, and that is
worth knowing first. Safety boundaries (dirty-tree refusal, verification,
one-action undo — TRA-867) are more important than the feature and are part
of the design pass, not a follow-up.

### 7. One door instead of 178 — a router preset (TRA-646, design done, unbuilt)
Unchanged in substance and still the right shape: advertise a router plus a
catalog (`plan_turn` and `load_tools` already exist) so the advertised
surface stops scaling with the tool count. codegraph (68.7K★) advertises
**one** of its eight tools by default at ~1.9K tokens total, and its stated
reason in source is not token cost but that *presence itself steers
mis-picks*.

**What the decomposition above does to its priority.** The prize is bounded
by the 3.5% schema row, so this is no longer a top-line efficiency play — it
is a *routing quality* play, which is what codegraph says it is for.
Sequence it behind items 1–4 and judge it on mis-pick rate, not on tokens.
The open empirical question is unchanged and cheap: does a model reliably
reach for a tool it cannot see? That is A/B-able today with `load_tools` as
it stands. Ships as a preset (`router`), so no contract break.

### 8. Decide what the State Engine makes us — and read its A/B sceptically (TRA-649)
Phase 4 reported −66.8% prompt tokens, −59.2% total, O(T) instead of O(T²)
prompt growth, loops 2.7% → 0.0%, sub-millisecond patch overhead. The
engine is real and merged (TRA-884), and the MCP prompt is wired (TRA-799).

**Read the quality half before quoting the token half.** The A/B reports
**Pass@1 100% in both arms** over 18 pinned tasks and 777 steps. Equal
success at a ceiling means task success was never at risk in that harness,
so the run demonstrates compression and does not yet demonstrate that
compression is free. That is structurally the same shape as the claim
TRA-880 just disproved about our own counter, and exactly what item 2 exists
to stop us shipping. Before this number reaches a public surface it needs
one arm where the baseline can fail.

The positioning half of this item is now folded into item 4: `trace_state_*`
is one of three non-graph mechanisms in the binary, and deciding its door
separately from theirs produces two products by accident.

### 9. Team-shared graph — parked, needs Nikolai's go-ahead (TRA-128)
Unchanged. The design pass is done and stays valid; its smallest slice is a
network-reachable server component, which is in the one category reserved
for Nikolai's explicit call. **Correctly parked, not stalled** — and with
~107 installs across 20 countries and no evidence of a single multi-seat
user, there is still no demand-side reason to unpark it.

## Explicitly not doing right now

- **Tool consolidation as a token play.** Superseded by presets. Do not
  reopen it for efficiency reasons; only merge two tools if they are
  genuinely the same tool.
- **Moving any public occurrence of the name.** TRA-879 closed this with
  data: 83% of organic clicks are the name, and the two nearest
  descriptive/adjacent queries are collisions we lose at 0 clicks on 115
  impressions. The CLI verb, the server key and `~/.trace` are on disk and
  unindexed; everything a search engine or a human types stays `trace-mcp`.
- **Chasing competitor feature/tool-count parity.** Count was never the
  metric in either direction, and the two largest peers compete in the
  opposite direction.
- **Publishing another aggregate savings figure before item 1 lands.** Any
  number sourced from the pre-TRA-880 counter is 2.4x overstated by
  construction, and `inflation_suspected` is true on top of that.
- **Rewriting CFG/taint analysis onto a real AST/dataflow engine** — a real
  ceiling, filed in `comparisons.md`, not a roadmap item until something
  forces it.
- **Adding language #82 or framework #88 as a headline.** Per-language edge
  *resolution depth* (`resolution_tier`, already stored) is the claim worth
  making; the count is not.
- **A paid end-to-end benchmark run.** Budget approval was withdrawn
  2026-09-04 (TRA-778). Do not restart that conversation — re-scope to what
  a subscription runs, per item 2.
