# Show HN material — ready to post, not posted

Draft copy for the one channel this project has never used. **Nobody but
Nikolai posts this.** An agent may write and revise it; publishing under the
project's name is his call, and it is irreversible in a way a directory listing
is not.

Numbers below come from `docs/_data/counts.yml` and the README's own framing,
verified 2026-08-30 (81 languages / 87 frameworks / 169 tools). Re-read both
before posting — 80 became 81 languages inside a day once, and a Show HN thread
is the worst place to be caught with a stale figure. Nothing enforces this file:
`tests/docs/readme-claims.test.ts` guards README.md only, so these figures go
stale silently.

## When to post

Not on a release day and not right after one: the top comment on any Show HN
about a token-reduction tool is "show me the measurement", and the answer has to
be a page that already exists, not one written while the thread is live. The
prerequisites are all met today — `trace-mcp.com/comparisons.html` is current,
the benchmark is one command, and the install path has had its rough edges filed
off (#282 config scope, #297 tools not appearing, #230 Windows popups, #202
daemon reinstall).

Tuesday–Thursday, 07:00–09:00 US Pacific, is the conventional slot. Post and
then stay available for ~4 hours; an unanswered thread dies.

## Title

Show HN: Trace-mcp – a code graph for AI agents, so they stop re-reading files

Keep it to 80 characters or fewer (the line above is exactly 80, HN's cap) and
resist adjectives. "Framework-aware code intelligence" is what the package says;
it is not what a reader recognises.

## Body

> I kept watching Claude Code re-read the same files every turn. Ask "what breaks
> if I change this model?" and it greps, opens twenty files, forgets, and does it
> again next turn — on a big repo the bill grows with the repo, not with the
> question.
>
> trace-mcp indexes the repo once into a local SQLite graph (tree-sitter, 81
> languages) and serves it over MCP, so the agent queries structure instead of
> re-deriving it. The part I care about is the framework edges: it knows
> `Inertia::render('Users/Show')` connects PHP to Vue, that `@Injectable()` is a
> DI edge, that `$user->posts()` implies a table from a migration. 87 framework
> integrations, so `get_change_impact` crosses language boundaries instead of
> stopping at the import graph.
>
> Across a session I measure 40–50% fewer tokens on mixed work. Individual
> structured calls — impact analysis, call graphs, type hierarchy — go far higher,
> but that is a per-call peak and I have stopped quoting it as if it were the
> average.
>
> Runs entirely locally. No API keys, no code leaves the machine, MIT.
> `npx trace-mcp index . && npx trace-mcp benchmark .` prints the per-task
> numbers against your own repo in about five minutes, which is a better
> argument than anything I can write here.

## First comment — post it yourself, immediately

HN treats a maintainer who names the limits first as credible and one who waits
to be caught as not. This is the whole reason the thread is worth having.

> Four things worth knowing before you try it:
>
> It sends one anonymous ping per day per install — a random id, version, OS,
> and two aggregate counters, no paths and no code. It goes to Google Analytics
> (a GA4 Measurement Protocol POST to `google-analytics.com`).
> `TRACE_MCP_TELEMETRY=off` kills it, and the source is
> `src/telemetry/usage-ping.ts`. Saying "local-first" without saying that first is
> how a thread goes bad.
>
> The headline benchmark is a **synthetic estimate**, not measured savings. The
> "without" side is computed from file sizes in the index and the "with" side from
> per-scenario multipliers — it shows a ceiling. For real numbers from your own
> usage there is `trace-mcp analytics savings`, which reads what your sessions
> actually did.
>
> It is an index, not a compiler. Edges carry a resolution tier
> (`scip_resolved` > `lsp_resolved` > `ast_resolved` > `ast_inferred` >
> `text_matched`), and the bottom tier is a heuristic. LSP enrichment and SCIP
> ingestion are both opt-in and off by default.
>
> If you only want to stuff a repo into one prompt, Repomix is the better tool and
> I say so on the comparison page. trace-mcp earns its keep when the agent needs to
> *look things up* repeatedly.

## The five questions the thread will actually ask

Each answer must be checkable in one click. Do not improvise these.

1. **"How is this different from Serena / codebase-memory-mcp / Repomix?"** →
   `trace-mcp.com/comparisons.html` plus the five head-to-head pages (Serena,
   Repomix, codegraph, Context Mode, codebase-memory-mcp). Never disparage a competitor from
   memory; the comparison pages are written to survive the maintainer of the
   other project reading them, which on HN they will.
2. **"40–50% of what, measured how?"** → the README's "Token reduction" section
   and `npx trace-mcp index . && npx trace-mcp benchmark .` (the benchmark reads
   an existing index — without the index step it has nothing to measure). Say
   plainly that mixed real-world workloads land 30–60% depending on stack.
3. **"Why not just use the LSP?"** → we do, optionally, as an enrichment pass. The
   graph exists so an answer costs one call instead of a live query per edge, and
   so cross-language framework edges exist at all — no LSP knows that an Inertia
   string maps to a Vue component.
4. **"Does it phone home?"** → local-first, no API keys. There is one anonymous
   daily ping — a GA4 Measurement Protocol POST to `google-analytics.com`, with
   the measurement id and write-only api_secret in the bundle by design —
   documented in the README's "Usage telemetry" section, and it is
   off with `TRACE_MCP_TELEMETRY=off` (`src/telemetry/usage-ping.ts`). Do not
   point at `docs/telemetry.md` — that page is the OTLP observability bridge, a
   different feature that is disabled by default. Answer this one in full,
   immediately, every time it is asked.
5. **"169 tools?! That is context bloat."** → a fair hit. Tools register per
   detected framework, presets exist, and the schema budget has a regression test
   (TRA-186). Do not get defensive: the honest line is that the surface is large
   and shrinking it is active work.

## What not to do

- No "we" if it is one person and an agent fleet. HN can smell it.
- Do not seed upvotes or post the link in Slack groups for a boost — HN detects
  voting rings and the penalty is permanent.
- Do not post a second time if the first sinks. A Show HN that flops is allowed
  one repost months later, with a materially different product behind it.
- Reddit (r/ClaudeAI and neighbours) is a **separate** draft with a different
  voice — do not cross-post this text verbatim. It lives in
  `ops/launch-reddit.md`, and it carries rule quotes this file does not need:
  r/mcp bans AI-written promo copy outright, and r/ClaudeAI gates feed posts on
  OP karma.
