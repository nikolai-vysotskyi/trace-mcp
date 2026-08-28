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
`G-WSYYT2WZJV`. Refresh the line below monthly so future revisions see a
trend instead of re-deriving one.

**npm weekly downloads are not an adoption metric** and should not be cited
as one. Measured 2026-08-28 (TRA-273): 9,013 downloads over 92 days, but
every daily peak is a publish day — 226 on 08-10 (v1.47.0), 344 on 08-17
(v1.47.1), 1,322 on 08-27 (nine releases). Strip publish days and the
baseline is flat at 20–45/day for the whole quarter. The graph measures our
release cadence and registry mirrors, not users. If it must appear in a
report, annotate the publish days.

GitHub stars, same date: 101 total (April 58, May 23, June 8, July 5,
August 6), 14 forks — a launch burst that decayed ~10× and stayed flat.

| Date | Active installs | Notes |
| --- | --- | --- |
| 2026-08-28 | _pending GA4 read access_ | Ping verified end to end: published `trace-mcp@2.0.0` carries baked credentials, payload validates against the Measurement Protocol debug endpoint. |

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
