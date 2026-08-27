# Product Roadmap

Strategic view of trace-mcp, revisited roughly weekly by the Product Roadmap
& Vision autopilot, which also turns 2-4 of the items below into that week's
operational focus (see the "This Week's Focus" section of the trace-mcp
Operations project). This file tracks *why* something should move the
product forward — not day-to-day bugs, tool tweaks, or indexing hygiene
(those live as regular issues, tracked by other autopilots). An item is
removed here once it ships, is superseded, or turns out not to matter.

## Where the product stands

Both items that were "ready to start" in the last revision have shipped:
**CI-native PR intelligence** (TRA-127, `.github/workflows/pr-comment.yml` —
blast radius + quality gate comments on this repo's own PRs) and the
**multi-project tool surface** (TRA-93/TRA-143, PR #357 — `list_projects` +
`call_project_tool` relay, shipped as "Option B" rather than a per-tool
`project` param retrofit). Per `docs/comparisons.md`'s own honest
self-assessment, six of seven competitive gaps from the last deep pass are
also shipped and adversarially re-validated. The two remaining technical
gaps (a peer-reviewed bug-risk metric; CFG/taint staying line-based/lexical
instead of full AST/dataflow) are known architectural ceilings, not
low-hanging fruit — leave them tracked in `comparisons.md`, not here.

That clears the board of concrete, already-scoped work — which is exactly
when it's worth checking a premise `comparisons.md` has been asserting as a
strength: **170 MCP tools** is listed as a differentiator against Serena
(~55), code-review-graph (~28), SocratiCode (~21) in every comparison table.
Nikolai's own measurement (TRA-186) says the same number is a **~52-53k
token tax paid at every session start** on any MCP client without deferred/
lazy tool loading — 91% of the total tool-schema weight in a real session.
Tool *count* as a marketing number and tool *count* as a token-start-cost
liability are the same fact read two different ways; the fix is not "add
more tools" or "remove tools" but making the number stop being something a
client pays for before it's used — see item 1 below.

The other standing question is unchanged: **who trace-mcp serves and how
far the current single-developer, single-repo model can stretch before it
needs to change shape.**

## Ready to start

### 1. Cut the session-start tool-schema tax (TRA-186)
Already filed with measurements attached (171 tools / ~203k chars / ~50.7k
tokens of schemas+descriptions, before a single tool is called) and
assigned out for an audit-and-trim pass: heaviest offenders
(`search` ~1233 tok, `query_decisions` ~1098 tok, `plan_refactoring` ~589
tok) get description trims, redundant/overlapping tools get flagged for
consolidation, and MCP's lazy-registration/pagination options get evaluated
for shrinking the always-paid baseline.

**Why now:** this is a direct product-credibility problem, not a nice-to-have
— trace-mcp's whole pitch is cutting agent token usage, and paying 50k+
tokens just to *see* the tool list undercuts that pitch on exactly the
clients (Claude Desktop, other non-lazy-loading agents, local models) least
able to absorb it. It's also cheap relative to payoff: this is schema/
description editing and tool consolidation, not new architecture.

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
