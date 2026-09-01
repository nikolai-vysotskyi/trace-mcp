---
layout: default
title: Product Roadmap
description: Internal working document. Strategic view of trace-mcp, revised roughly weekly.
noindex: true
---

# Product Roadmap

Strategic view of trace-mcp, revisited roughly weekly by the Product Roadmap
& Vision autopilot, which also turns 2-4 of the items below into that week's
operational focus (see the "This Week's Focus" section of the trace-mcp
Operations project). This file tracks *why* something should move the
product forward — not day-to-day bugs, tool tweaks, or indexing hygiene
(those live as regular issues, tracked by other autopilots). An item is
removed here once it ships, is superseded, or turns out not to matter.

## Where the product stands

Both items that were "ready to start" two revisions ago shipped:
**CI-native PR intelligence** (TRA-127) and the **multi-project tool
surface** (TRA-93/TRA-143). The item that replaced them last revision has
now also shipped: **TRA-186's tool-schema-tax cut** landed in two releases
(v1.48.3 PR #377, v1.48.4 PR #380) — tool description text 73,947→~64k
chars, per-parameter description text 32,281→30,245 chars, both now
regression-guarded by `tool-schema-budget.test.ts`. That's a real but modest
cut (~6% off the ~203k-char/~50.7k-token baseline Nikolai measured), because
the investigation surfaced the actual shape of the cost: of the ~94k
inputSchema chars, only ~30-32k is prose (`.describe()` text) we control —
the remaining ~60k+ is structural JSON Schema (`type`, `required`, `enum`,
`minimum`/`maximum`) generated from legitimate parameter counts, which
**cannot shrink without removing parameters or consolidating tools** —
both are breaking MCP tool-contract changes, not prose edits. See item 1
below for the resulting next step.

Per `docs/comparisons.md`'s own honest self-assessment, six of seven
competitive gaps from the last deep pass are shipped and adversarially
re-validated. The two remaining technical gaps (a peer-reviewed bug-risk
metric; CFG/taint staying line-based/lexical instead of full AST/dataflow)
are known architectural ceilings, not low-hanging fruit — leave them
tracked in `comparisons.md`, not here.

The other standing question is unchanged: **who trace-mcp serves and how
far the current single-developer, single-repo model can stretch before it
needs to change shape.**

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

Caveat when citing it: the ping's credentials ship in plaintext inside the
published npm package (public by design — see SECURITY.md "Telemetry
Credentials"), so the events are **unauthenticated and can be inflated by
anyone**. Active installs is the best adoption signal we have, not an
auditable one; read it as a trend, and treat a sudden step change as
suspect until corroborated.

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
trust strip and no download figure is cited on any public surface. Adoption
metric of record is GitHub stars + traffic uniques. Re-check the per-version
flatness quarterly, not per run.

The same caveat now covers **git clones** (measured 2026-08-30, TRA-540):
16,006 clones / 928 uniques in 14 days, ramping 166 → 8,736 per day across
08-24…08-29 while human page views stayed flat at ~20/day. Unique *cloners*
inflated along with the raw count (62 → 300), so clone uniques are no safer
than clone totals. Whatever swept the npm version history swept git too. The
metric of record is therefore GitHub stars plus traffic **views** uniques only
— clones are excluded from it. Channel-by-channel state now lives in
`ops/user-signal.md`.

GitHub stars, same date: 101 total (April 58, May 23, June 8, July 5,
August 6), 14 forks — a launch burst that decayed ~10× and stayed flat.

| Date | Active installs | Notes |
| --- | --- | --- |
| 2026-08-28 | _pending GA4 read access_ | Ping verified end to end: published `trace-mcp@2.0.0` carries baked credentials, payload validates against the Measurement Protocol debug endpoint. |

### The funnel — four numbers around that denominator (TRA-645)

Active installs is a denominator with nothing on either side of it. Without
that, every listing rewrite, hero redesign, README restructure and outreach PR
is graded on taste. Four numbers fix it, one per stage:

| Stage | Number | Source | Window |
| --- | --- | --- | --- |
| Arrivals | unique visitors to the GitHub repo | `acquisition.views_uniques_14d` | rolling 14 d |
| Installs | first-ever pings | `installs_28d.new` | 28 d |
| Activation | % of active installs with ≥1 indexed repository | `activation.activated_pct` | 28 d |
| Retention | day ÷ month active installs | `funnel.retention_dau_mau_pct` | 1 d over 28 d |

**Do not refresh these by hand either.** All four are computed by the same
daily `ga4-snapshot.yml` run and published under `funnel:` in
[`adoption-data`](https://github.com/nikolai-vysotskyi/trace-mcp/blob/adoption-data/adoption.yml) —
that file is where a weekly run reads them, not this page. As of **2026-09-02**:
178 arrivals (14 d), 24 new installs, retention 51% (35 day / 69 month), and
activation still blocked — see below.

**Two credentials stand between this and all four numbers**, both verified
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
   only have logged a failure once a day.
2. **`GH_TRAFFIC_TOKEN` is unset.** GitHub's traffic endpoints require
   `Administration: read`, a permission `GITHUB_TOKEN` cannot be granted, so the
   workflow gets HTTP 403 and records that in `acquisition.error`. A
   fine-grained PAT on this repo with that one permission fills it. Until then
   arrivals must be read by hand with the `gh api` calls in
   `ops/distribution.md`, and nothing accumulates — GitHub's window is 14 days
   and drops what falls out of it.

Three things to keep attached to them. The windows differ, so arrivals →
installs is a direction and not a conversion rate. The ping's credentials are
public, so all four are inflatable and are a trend, not an audit. And
`activated_pct` is taken against its own buckets rather than against
`active_users.month`, because GA4 deduplicates active users within a dimension
value and not across them — an install that indexes its first repository
mid-window is counted on both sides.

Activation is the one to watch. It is the only one of the four that measures
whether an install ever reached the product's value, and it is the ceiling on
everything downstream of install: if a meaningful share of installs ping day
after day with zero indexed repositories, that number outranks every capability
item below.

Acquisition already has a finding. Over two independent 14-day windows
(2026-08-30 and 2026-09-02) **not one of the twelve directory listings in
`ops/distribution.md` appears as a referrer** — arrivals come from search,
Reddit and our own site. New distribution effort belongs where those arrivals
are; see that file's "Arrivals" column for the limits on that conclusion.

## Ready to start

### 1. Scope tool-consolidation candidates into per-tool migration issues (follow-up to TRA-186)
TRA-186's own investigation named the candidate list (pin_file/pin_symbol,
discover_claude_sessions/discover_hermes_sessions, search/search_with_mode,
the three "is it safe to edit" tools, and others surfaced during the trim)
and explicitly recommended **not** folding consolidation into that issue,
since each merge is a breaking MCP tool-contract change and needs its own
migration note (which callers break, what the replacement call looks like).
This item is: pull that list into scoped issues, one (or a small related
group) per issue, each with a concrete before/after tool signature and a
migration note — a design/scoping pass, not a code-first pass.

**Why now:** it's the only remaining lever that moves the ~50k baseline
materially (prose trimming is now regression-tested and tapped out at ~6%).
It's also the more consequential kind of change — every merge is a contract
break for anyone with the old tool name pinned — so it deserves the
scoping rigor TRA-186 asked for, not a batch rewrite done casually.

## Big bet — needs a design pass before any code

### 2. Team-shared graph — parked, needs Nikolai's go-ahead (TRA-128)
trace-mcp's whole pitch is "reuse instead of recompute" — but today reuse
only happens *within one developer's laptop, across turns*. A team of five
engineers on the same repo each index it separately, each mine their own
decisions separately, and never see each other's "why was this built this
way" answers. That's the same recomputation leak the product exists to
close, just at the team level instead of the turn level.

The design pass (TRA-128) is done: a lightweight shared-graph mode — a
daemon reachable by a team instead of localhost-only, with a shared decision
store — would turn trace-mcp from a personal productivity tool into a team
artifact, and is the kind of capability that could eventually justify a
hosted/paid tier. But the design's own recommended smallest slice is a
network-reachable server component, which falls squarely in the one
category this project's rules reserve for Nikolai's explicit call (no
hosted backend / paid infra on an autopilot's own authority). **Status:
correctly parked, not stalled** — the design stays valid and ready to
resume the moment there's an explicit go-ahead or an actual team asking for
it (the issue's own trigger condition). Nothing to do here until then.

## Explicitly not doing right now

- Chasing competitor feature/tool-count parity for its own sake — see
  `comparisons.md`'s "deliberately NOT chasing" list. Still holds, and item
  1 above is the sharper version of why: count alone was never the right
  metric to chase, in either direction.
- Rewriting CFG/taint analysis onto a real AST/dataflow engine — real gap,
  correctly filed as a known ceiling, not a roadmap item until something
  forces the issue (e.g. a security-critical false negative in the wild).
