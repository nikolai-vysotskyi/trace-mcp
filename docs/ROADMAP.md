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
single largest referrer and unreadable to us, and 41% of installs that we
cannot even attribute to a client.

This is not an argument to slow the engine room down. It is an argument
that the next several weeks of *strategic* work — the items below, and the
weekly focus derived from them — should be measured in users reaching first
value, not in capability shipped. All four "ready to start" items are of
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

- **We cannot attribute 41% of installs to a client** (25 of 61 report
  `unknown`), and the ping carries no field for the active tool preset at
  all. So the flagship efficiency claim — 67–86% — is bench-verified and
  **not field-verified**. Item 1.
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

## Ready to start

### 1. Field-verify the preset savings, and close the attribution hole in the ping (TRA-643)
The ping (`src/telemetry/usage-ping.ts`) sends `version`, `platform`,
`node_major`, `tokens_saved`, `calls`, `client`, `install_type`,
`previous_version`, device, `model` and `repos_indexed` — and **nothing
about the tool surface the session actually advertised.** So the number the
whole product now leads with (67–86% off the tool surface) is measured on
this repo's bench and unmeasured in the field, and 25 of 61 installs do not
even say which client they run.

**Why now:** presets are the single biggest efficiency change we have ever
shipped, they became the default silently (TRA-538 rewrote pre-v3.3
`"preset": "full"` configs on upgrade), and we have no way to see whether
that landed. Add the active preset and the advertised tool count to the
ping, read them back in `adoption.yml`, and separately find out why `client`
is unknown 41% of the time — an MCP client that does not identify itself is
also a client we cannot write install docs for.

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

## Big bets — design pass before any code

### 5. One door instead of 169 — a router preset (new, TRA-646)
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

### 6. Team-shared graph — parked, needs Nikolai's go-ahead (TRA-128)
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

### 7. Decide what the State Engine makes us — waiting on its own numbers (TRA-649)
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
  `comparisons.md`'s "deliberately NOT chasing" list. Item 5 is the sharper
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
