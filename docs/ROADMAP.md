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

## Where the product stands (revised 2026-09-02)

The previous revision of this file described a v1.48.x product with an
unsolved tool-schema tax and no adoption number. Both of those are now out
of date, and the second one changes what this roadmap should be about.

**The schema-tax thread is closed, and not the way this file predicted.**
The last revision's only "ready to start" item was *scope tool-consolidation
candidates into per-tool migration issues* — merge `pin_file`/`pin_symbol`,
`search`/`search_with_mode`, the three edit-safety tools, and accept a
breaking MCP tool-contract change in exchange for a smaller advertised
surface. That item is **removed as superseded**: role-based presets
(TRA-601/602/603, shipped) got the same win with **no contract break at
all**. A preset is a *deferral*, not a restriction — every tool stays
registered and `load_tools` pulls any of it back mid-session — so the
advertised surface shrinks while capability stays whole. Measured on this
repo: `minimal` 28 tools (now the default), `standard` 60, and six role
presets between 26 and 42, for a **67% cut on the widest role preset
(`dev`) and 86% on the narrowest (`design`)** against `full`. Ceilings are
regression-guarded in `preset-surface-budget.test.ts`; documented sizes are
checked against the real filter by `preset-claims.test.ts`. Nothing about
tool consolidation is worth a contract break now.

**The rename to `trace` is the largest thing in flight, and its measured
efficiency case is ~1%.** TRA-613 (PR #720) benchmarked the actual rename
against a real `initialize` + `tools/list` round-trip on four tokenizers:
2 tokens per tool on GPT tokenizers, 3 on Claude/Gemini — 66 / 120 / 366
tokens off `minimal` / `standard` / `full`, i.e. **0.74–1.23%** of what
that surface already costs. That is a fine result and a bad justification.
If the rename ships, it ships as a **positioning** decision, and it has to
be judged and sequenced as one — see item 2 below.

**Everything else is capability that landed fast.** Twelve releases in
seven days (v3.2.0 → v3.11.0, 345 commits), a signed and notarized macOS
DMG with electron-updater, an app that installs and repairs its own daemon,
first-run setup, topology/decision-store pruning, Rust import resolution,
and the SKILL.state linear context engine landing behind PR #715. The
engine room is not the problem.

## The one thing this roadmap is now about

For the first time we can read the adoption metric of record, and it says
**61 monthly active installs**.

Set that beside the production rate — 27 autopilots, 12 releases and 345
commits in the last seven days — and the ratio is the strategy. We are
shipping roughly fifty commits a day for sixty-one users. Every gap this
file has tracked for months has been a *capability* gap, and we have closed
them at a rate almost nothing else closes them at. The gap that is actually
binding is on the other side: **reach, and first value.** 102 GitHub stars
after five months, ~20 human page views a day on the site, Reddit as our
single largest referrer and unreadable to us, and a client attribution we
could not read at all until TRA-643 found out why.

This is not an argument to slow the engine room down. It is an argument
that the next several weeks of *strategic* work — the items below, and the
weekly focus derived from them — should be measured in users reaching first
value, not in capability shipped. All five "ready to start" items are of
that shape.

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

Two things that number is already telling us, both actionable and both
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
mirror sweeping the version history. **Git clones are out too** (TRA-540):
16,006 clones / 928 uniques in 14 days while human page views stayed flat
at ~20/day, with unique *cloners* inflating alongside the raw count.

The public-facing metric of record is therefore **active installs, GitHub
stars, and traffic *views* uniques** — nothing else. Channel-by-channel
state lives in `ops/user-signal.md`; listing-by-listing state in
`ops/distribution.md`. GitHub, 2026-09-02: **102 stars, 15 forks.**

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
tested it. **Read the answer beside `by_client_installs`** — the only client
breakdown we have is 8 claude-code / 2 codex / 1 grok, which concludes nothing.

**Do not refresh these by hand either.** All of them are computed by the same
daily `ga4-snapshot.yml` run and published under `funnel:` in
[`adoption-data`](https://github.com/nikolai-vysotskyi/trace-mcp/blob/adoption-data/adoption.yml) —
that file is where a weekly run reads them, not this page. As of **2026-09-02**:
178 arrivals (14 d), 24 new installs, retention 51% (35 day / 69 month), and
activation still blocked — see below. Use is blocked on the same one form.

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
   (TRA-643), plus `calls` (TRA-673). All four are event-scoped custom
   *dimensions*; `calls` is read as a dimension deliberately, because the Data
   API has no `client_id` and a summed metric can therefore never yield the
   per-install boolean the use stage is built on. One admin session registers
   all four, and every day before it is unrecoverable for all four. Do not open
   a fifth separate ask.
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

Acquisition already has a finding. Over two independent 14-day windows
(2026-08-30 and 2026-09-02) **not one of the twelve directory listings in
`ops/distribution.md` appears as a referrer** — arrivals come from search,
Reddit and our own site. New distribution effort belongs where those arrivals
are; see that file's "Arrivals" column for the limits on that conclusion.

## Ready to start

### 1. Field-verify the preset savings, and close the attribution hole in the ping (TRA-643)
**Instrumentation landed** (PR #748): the ping now sends `preset` and
`tools_advertised`, on the same basis `preset-surface-budget.test.ts`
measures, so the number the whole product leads with (67–86% off the tool
surface) becomes field-checkable rather than bench-only. The attribution
hole turned out to be two separate defects, both fixed in the same change —
see "How to read `by_client`" above.

**What is left is not code.** The dimensions must be registered in GA4
(event-scoped, named exactly `preset` and `tools_advertised`) before any
value reaches `adoption.yml`; GA4 does not backfill, so the series starts at
registration. That registration is now shared with `repos_indexed` and `calls`
— four parameters, one admin session, one ask. Do not raise it separately. Then one read-back after the first snapshot that carries them:
what fraction of installs run which preset, and whether the silent
`full` → `standard` default migration (TRA-538) actually landed. Until that
read-back exists, "67–86%" stays a bench figure and must be cited as one.

### 2. Execute the rename in the order the decision fixed (TRA-644 — decided)
**Decided 2026-09-02: `trace` is the command, `trace-mcp` is the project.**
Thesis, per-surface table and reopen condition in
[`ops/rename-to-trace.md`](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/ops/rename-to-trace.md).
The short name takes only what sits on a developer's own disk and is
migrated by code we control — the CLI binary, the MCP server key, `~/.trace`.
The npm package, `trace-mcp.com` and its indexed URLs, the `server.json`
registry identity, the repo name and topics, the ~10 external listings and
the Electron bundle (TRA-636, cancelled) all keep `trace-mcp`.

Two verified facts closed the full-rename option. **`trace` has been taken
on npm since 2024**, so `npx trace` was never available and the install
command — the most-copied string we have — could not be renamed under any
plan; the question was only where the boundary between two names sits. And
**the whole prize is 0.74–1.23%** (TRA-613), all of it in the server key and
the CLI verb, none of it in the package name, the domain, the registry entry
or the bundle. So the boundary goes where the tokens are, which also makes
this an ordinary two-name split (`ripgrep`/`rg`, `neovim`/`nvim`) rather
than a partial cutover, and leaves nothing in the program irreversible and
no door that needs a human.

**What is left is execution, in one order.** TRA-641 first: analytics still
classify our calls as `tool_server === 'trace-mcp'`, and TRA-614's Migrate
button is merged but not in v3.11.0 — once the release carrying it ships,
`get_real_savings` reports zero, silently. Then TRA-611 (#730), then TRA-615
(#717) rewritten to state the boundary rather than announce a rename. TRA-650
covers the one real breakage: the tool prefix in allowlists, hook matchers
and prose that users wrote themselves, which `init` cannot reach.

### 3. Put a funnel behind the 61, not just a number (TRA-645)
We now have a denominator, and no funnel. Reach → install → **activation**
→ retention is mostly derivable from what we already collect: `repos_indexed`
tells us whether an install ever indexed anything, `install_type` separates
new from returning, `by_version` shows whether they stay current. Nothing
tells us where they came from — GitHub referrers say Reddit, which we
cannot read (`ops/user-signal.md`), and the directory ledger tracks presence
but never arrival.

**Why now:** with 61 installs, a 10-install swing is a 16% move and every
listing, page and README rewrite is currently graded on taste. One
acquisition-channel signal plus one activation number would let the
distribution, SEO, outreach and web-design autopilots stop arguing from
aesthetics.

### 4. Put the one measurement made on other people's code where people arrive (TRA-647)
TRA-534 measured input-token cost across 60 merged bug-fix PRs from six OSS
repositories: median **13,595 → 1,326 tokens, 90.6% saved**, p90 44,246 →
3,667, affected call sites readable 20% → 60% with 100% at least located. It
is pinned (`benchmarks/pr-context/dataset.json`), reproducible
(`scripts/bench-pr-context.ts`) and rendered from generated data
(`docs/_data/pr_context_bench.json`), never hand-typed. It is the only
number this project has that was not produced by the tool measuring itself
on its own repository.

Measured on `origin/master`, 2026-09-01: `pr-context-benchmark` appears
**zero times in `docs/index.html` and zero times in `README.md`**. The page
is reachable from one place, `docs/_data/docs_nav.yml`. Every figure a
visitor actually sees still comes from our own estimators.

**Why now:** items 1-3 all say the binding gap is reach and first value, and
this is the cheapest credibility we will ever have — the work is already
done and published, it just is not on the door. Both doors are being
rebuilt this week (TRA-607/608/609 on the above-the-fold of the site and the
README), so it lands inside those rewrites or costs a second redesign later.
Its honest boundary ships with it: quality on that dataset is *structural*
coverage, not a model's judgement, and the page already names the 5 PRs of
60 where the index did not pay off. The quality arm is **TRA-568**, promoted
out of backlog — a token number without a quality number is an efficiency
claim, not a value claim, which is exactly the move we criticise peers for.

### 5. Read `calls`, not just `repos_indexed` — does the product get used, and by which client? (new, TRA-673)
Every efficiency number this project publishes assumes the agent calls our
tools instead of reading files. That assumption has never been checked outside
one client, and the mechanism that enforces it is not portable:

- **Level 3 (the PreToolUse guard hook that actually blocks Read/Grep) is
  Claude Code only**, and Level 4's tweakcc system-prompt rewrite likewise
  (`README.md`, "Getting the most out of trace-mcp"). Cursor and Windsurf get
  a rules file (`src/init/ide-rules.ts`); everyone else gets tool descriptions.
  Below Level 3 the product is asking, not routing.
- **Session mining, the cross-session pillar, has two providers** — `hermes`
  and `codex` (`src/session/providers/`). For a Cursor or Windsurf install,
  decision memory and `search_sessions` start empty and stay that way.
- The one breakdown we have (2026-09-01) is 8 claude-code, 2 codex, 1 grok
  inside a 36-row `by_client` bucket. Too small to conclude from, which is the
  point: we are shipping into MCP directories on the premise of client
  neutrality while our strongest mechanisms exist for one client.

**The measurement is nearly free**, because the counter is already being sent
and simply never read — see "Activation measures setup, not use" above. Work:
read `calls` in `scripts/ga4-snapshot.mjs` alongside `tokens_saved`, break it
down by `client`, and publish it under `funnel:` as the activation number that
means *use* (`repos_indexed` stays as setup). Then one read-back: what share of
active installs called a tool at all in the window, and does that share differ
between hook-capable and hook-less clients.

**Why it is here and not a tactical ticket.** If use is flat across clients,
Level 3 is a nice-to-have and reach work should go wide — every directory, every
client. If it collapses without the hook, then our addressable market is
"clients that can enforce tool routing", the honest response is portable
enforcement (or a much stronger Level 1), and half the distribution effort is
currently pointed at installs that will never reach value. Those are opposite
strategies and we cannot presently tell them apart.

**One dependency, and it is the same one three other items are waiting on.**
`calls` needs registering in GA4 as an event-scoped custom **dimension**, exactly
like `repos_indexed` / `preset` / `tools_advertised` — not a metric, as an earlier
revision of this line said. `scripts/ga4-snapshot.mjs` queries `customEvent:calls`
in the `dimensions` array (once alone, once crossed with `client`), and GA4 will
not serve a metric registration to a dimension slot: registering it as a metric
leaves `usage` and `by_client_used_pct` exactly as blank as they are now.
GA4 does not backfill any of them. That makes four fields in one admin session
rather than four separate asks — bundle it.

## Big bets — design pass before any code

### 6. One door instead of 169 — a router preset (new, TRA-646)
Presets took the advertised surface down by hiding tools behind
`load_tools`. That worked, it broke nothing, and it has an obvious limit:
even `minimal` still advertises 28 full JSON Schemas, and TRA-186 already
established that ~60k of the schema cost is *structural* — `type`,
`required`, `enum`, bounds generated from legitimate parameter counts —
which no prose edit touches.

The structural version of the same idea is to stop being a 169-tool server
at all: advertise a **router plus a catalog** — `plan_turn` already exists
as an opening-move router, `load_tools` already exists as the pull
mechanism — and let everything else be summoned by name rather than
declared up front. The advertised surface would become roughly constant
instead of scaling with the tool count, which also decouples our tool
growth from our context cost permanently, and inverts the one axis every
peer competes on (more tools = better) into one we can defend with numbers.

**This is not speculative — the market leader already ships it.**
`comparisons.md`'s own August 2026 source read found that codegraph (68.7K
stars) implements eight MCP tools and **advertises exactly one of them** by
default: `DEFAULT_MCP_TOOLS` is the single-element set `{explore}`, with
the rest re-enablable through an allowlist env var. Their whole advertised
surface costs roughly **1.9K tokens**. Their stated reason, in a source
comment, is not token cost at all — it is that *presence itself steers
mis-picks*. codebase-memory-mcp (41.2K stars) makes a weaker version of the
same call with tool profiles. So the open question is not whether anyone
would ship this; it is whether it survives at 169 tools instead of 8, which
is exactly what a design pass is for.

**Unknowns that a design pass has to answer before any code:** whether a
model reliably reaches for a tool it cannot see (this is the whole bet, and
it is an empirical question we can A/B today with `load_tools` as it
stands); the extra round-trip cost of summon-then-call versus the saved
schema cost; what happens to clients that cache `tools/list`; and whether
this is a new mode beside presets or a replacement for `full`. Not a
contract break if it ships as a preset (`router`), which is the shape to
design toward.

### 7. Team-shared graph — parked, needs Nikolai's go-ahead (TRA-128)
trace-mcp's whole pitch is "reuse instead of recompute", but reuse only
happens within one developer's laptop, across turns. A team of five on the
same repo each index it separately and never see each other's decisions —
the same recomputation leak the product exists to close, at team scale.

The design pass (TRA-128) is done and stays valid. Its own smallest slice
is a network-reachable server component, which falls in the one category
reserved for Nikolai's explicit call (no hosted backend / paid infra on an
autopilot's authority). **Status: correctly parked, not stalled.** Note
that item 3 sharpens the trigger condition: with 61 installs across 11
countries and no evidence of a single multi-seat user, there is currently
no demand-side reason to unpark it either.

### 8. Decide what the State Engine makes us — waiting on its own numbers (TRA-649)
`trace_state_*` — init, patch, get, checkpoint, rollback over a SQLite task
store with RFC 7396 merge patches, plus a `trace://state/{task_id}`
resource — is a second product pillar, and it arrived through an
implementation epic rather than a positioning decision. It is not code
intelligence: it is a bet that re-establishing *what the task is* costs an
agent as much as re-establishing what the code is. That is the same
recomputation argument this product was built on, one level up, and it may
well be right. But nothing states it as a position — not the homepage, not
`README.md`, not `comparisons.md`, and not this file until now.

**Status: waiting on phase 4, not parked.** Three questions, in order.
(a) Does the A/B show state cutting tokens *and* holding task success? Two
numbers, not one — token reduction with flat or worse Pass@1 is a
compression result, not a pillar, and that is worth knowing before the
number becomes a headline. (b) Is there one sentence a user repeats that
covers both halves? If it needs an "also", the surface is two products in
one binary — a legitimate answer, but then the second one needs its own
door rather than five more tools inside a 169-tool list. (c) If it is one
product, the public surfaces are all describing half of it.

**Why it is here and not in "ready to start":** the answer to (a) is being
measured right now, and guessing at it would produce exactly the kind of
claim item 4 exists to stop us making.

## Explicitly not doing right now

- **Tool consolidation as a token play.** Superseded by presets, which got
  67–86% without a contract break. Do not reopen it for efficiency reasons;
  only merge two tools if they are genuinely the same tool.
- **Chasing competitor feature/tool-count parity for its own sake** — see
  `comparisons.md`'s "deliberately NOT chasing" list. Item 6 is the sharper
  version of why: count was never the metric, in either direction, and the
  two largest peers are competing in the opposite direction anyway.
- **Rewriting CFG/taint analysis onto a real AST/dataflow engine** — a real
  gap, correctly filed in `comparisons.md` as a known ceiling, not a
  roadmap item until something forces it (e.g. a security-critical false
  negative in the wild).
- **Adding language #82 or framework #88 as a headline.** 81/87 is already
  past the point where the count persuades anyone; per-language *edge
  resolution depth* (the `resolution_tier` we already store) is the claim
  worth making, and it is the coverage autopilot's focus this week.
