# Product Roadmap

Strategic view of trace-mcp, revisited roughly every two weeks by the Product
Roadmap & Vision autopilot. This file tracks *why* something should move the
product forward — not day-to-day bugs, tool tweaks, or indexing hygiene
(those live as regular issues, tracked by other autopilots). An item is
removed here once it ships, is superseded, or turns out not to matter.

## Where the product stands

trace-mcp already covers the code-intelligence table stakes and then some —
per `docs/comparisons.md`'s own honest self-assessment, six of seven gaps
identified against the field in the last competitive pass have shipped and
been adversarially re-validated. The two genuinely open technical gaps
(a peer-reviewed bug-risk metric; CFG/taint staying line-based/lexical
instead of full AST/dataflow) are known architectural ceilings, not
low-hanging fruit — leave them tracked in `comparisons.md`, not here.

The real question at this point isn't "which tool is missing" — it's
**who trace-mcp serves and how far the current single-developer, single-repo
model can stretch before it needs to change shape.**

## Ready to start

### 1. CI-native PR intelligence (new)
trace-mcp's value today is only visible to whoever has the MCP client wired
up. Every other collaborator on a PR — reviewers, teammates without the
client configured, bots — sees nothing. `scan_security` /
`detect_antipatterns` / `check_quality_gates` already emit SARIF, and
`get_change_impact` / `compare_branches` already compute blast radius — but
there's no packaged way to run these automatically on a PR and surface the
result where people actually look (the PR itself). A thin CI wrapper
(GitHub Action or npx script) that posts a "blast radius + quality gate"
comment on PRs would make the tool's value visible to people who never
touch the CLI, at low engineering cost since the underlying analysis
already exists — it's a packaging problem, not a research problem.

**Why now:** cheap relative to payoff, and it's free dogfooding — every PR
against trace-mcp itself becomes a live demo.

### 2. Multi-project tool surface (GH #199 / TRA-93)
Already scoped as `TRA-93` (currently `backlog`): let a single MCP session
reach multiple registered projects via a per-call `project` argument instead
of binding the whole session to one repo. This is the most concrete,
already-designed-enough adoption blocker on the board — anyone with more
than one small repo or a pseudo-monorepo hits it immediately. Promoting
this out of backlog is the actionable step this run takes; the design pass
itself (session vs. per-call scoping, interaction with the existing
federation/subproject tools) still needs to happen before implementation.

## Big bet — needs a design pass before any code

### 3. Team-shared graph
trace-mcp's whole pitch is "reuse instead of recompute" — but today reuse
only happens *within one developer's laptop, across turns*. A team of five
engineers on the same repo each index it separately, each mine their own
decisions separately, and never see each other's "why was this built this
way" answers. That's the same recomputation leak the product exists to
close, just at the team level instead of the turn level.

A lightweight shared-graph mode — a daemon reachable by a team instead of
localhost-only, with a shared decision store — would turn trace-mcp from a
personal productivity tool into a team artifact: onboarding a new engineer
means pointing them at the team's graph, not re-indexing and re-learning
from scratch. This is a genuine category jump (and the kind of thing that
could eventually justify a hosted/paid tier), not an incremental feature —
so it needs a scoping/design issue first: security model for a
network-reachable daemon, conflict resolution when the graph or decision
store gets concurrent writes, and whether "shared" means a synced copy or
one authoritative server. Don't start writing code until that design
exists.

## Explicitly not doing right now

- Chasing competitor feature/tool-count parity for its own sake — see
  `comparisons.md`'s "deliberately NOT chasing" list. Still holds.
- Rewriting CFG/taint analysis onto a real AST/dataflow engine — real gap,
  correctly filed as a known ceiling, not a roadmap item until something
  forces the issue (e.g. a security-critical false negative in the wild).
