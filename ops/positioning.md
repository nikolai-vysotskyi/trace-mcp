# Positioning — what we say trace-mcp does, and what falls out of saying it

The one-sentence claim the product leads with, the boundary carried with it, and
the surfaces obliged to match. Not a public page: `ops/` is outside the Jekyll
site in `docs/`.

**Read this before writing or editing any public-facing description** — the
homepage hero, `README.md`'s first screen, `server.json`'s `description`, a
directory listing, a `/vs/` page, a launch post. **Update it in the same change
that moves the claim.**

Written for TRA-906, which supersedes TRA-649 (the narrower version of the same
question asked about the State Engine alone) and roadmap item 8. The reason it
is a file and not an issue comment: the last time a positioning decision lived
only in a thread, two runs reached opposite conclusions about the same surface a
month apart, which is the failure `ops/distribution.md` was created to stop.

Rules for keeping it honest, same three as the sibling ledgers:

- Quote **measured** numbers, with the date and the machine. A projection is not
  a claim.
- Record what we **decided not to say**, not just what we say. A dropped claim
  with no reason written down gets re-adopted next quarter.
- Numbers going outside come from `docs/_data/counts.yml` and
  `docs/_data/pr_context_bench.json`. Never hand-typed.
- **The saving never travels alone.** A surface quoting the token figure quotes
  the quality result from `docs/_data/pr_context_quality.json` in the same
  breath. Cheaper is not better, and one number stating a claim it does not
  support is the defect we documented in a competitor before we shipped it
  ourselves. Gated by `tests/docs/readme-claims.test.ts` (TRA-1013):
  `README.md` and `docs/comparisons.md` carry the four numbers; `package.json`,
  `plugin.json` and `server.json` are one-liners with no room for a table, so
  they carry the verdict instead — **comprehension at parity**. That phrase is
  silent on false positives (0.58 → 0.80, inside the preregistered bound but not
  nothing), so it belongs on a line that has no room for the pair and nowhere
  else.

## The question this answers

Every public surface — homepage, `README.md`, `server.json`, all the listings in
`ops/distribution.md`, `comparisons.md` — describes a code-graph MCP server.
That was accurate in June. Since then **four** mechanisms shipped or landed in
flight that are not the graph: decision memory, the `Read`/`Bash` mirrors, the
startup-block audit with its apply button, and `trace_state_*`. The question TRA-906 put was whether we
are (a) a code graph with those as features, or (b) the thing that manages an
agent's context budget end to end.

**Neither, as stated.** (a) understates what ships. (b) overstates what anyone
can do — see the boundary below — and would be the same class of claim TRA-880
already cost us. The answer is a third thing, and it is not new: it is the line
already sitting above the homepage headline.

## The position

> **trace-mcp indexes what your agent keeps re-reading, and serves the answer
> instead.**

That is the sentence. It needs no "also", which is the test roadmap item 8 set,
and it is a strict generalisation of the sentence the site already runs — "indexes
your repository once so AI coding agents stop re-reading the same files" is this
sentence with one noun substituted. Nothing currently public becomes false; it
becomes the leading example rather than the whole claim.

Five mechanisms, one move — stop paying twice for text the agent already has:

| What the agent would re-read | The mechanism | Shape | How it ships today |
|---|---|---|---|
| the repository | the code graph (tools / languages / frameworks — `counts.yml`) | index & serve | MCP tools |
| what was already decided, and why | decision memory (`wake_up`, `mine_sessions`, `query_decisions`, `get_project_memo`) | index & serve | MCP tools |
| the task it is on | `trace_state_*` | index & serve | MCP tools |
| files it opens, commands it runs | `Read`/`Bash` mirrors | stop re-paying | `hooks/trace-mcp-mirror.sh` |
| the instructions it loads at start | startup-block audit + apply | stop re-paying | `get_startup_context_audit` (MCP tool) + app button + config edits |

**The Shape column is the known stretch in the sentence, and it is recorded here
rather than smoothed over.** Three rows literally index something and hand back
an answer; the word is exact for them. The mirrors window and spill command
output — nothing is indexed — and the audit prunes dead configuration rather than
serving anything. What all five share is the move underneath, not the mechanism:
the agent stops paying, every turn, for text it has already been given once.
"Indexes" reads as a user-facing metaphor on the bottom two rows. If a rewrite of
the public copy ever has to choose between the two, the *move* is the claim and
"indexes" is the illustration — do not let the illustration narrow the claim back
to the graph, which is how the surfaces got here in the first place.

The site's own eyebrow already says exactly this: **Recomputation → Reuse**. The
repositioning is not inventing a category. It is promoting a line that has been
on the page all along over a headline that describes one of its five instances.

### The finding that matters more than the category noun

Read the right-hand column. **Two of the five mechanisms are not MCP tools at
all**, and a third is only half one. `hooks/` holds 23 scripts; the guard, the
launcher, precompact, session-start and the mirrors are all product, none of
them reachable through `tools/list`.

So the surfaces are not merely describing a fraction of the product. They are
describing it through the wrong noun. **trace-mcp outgrew "an MCP server" before
it outgrew "a code graph."** A product that introduces itself as an MCP server
cannot house a shell hook without an "also", which is exactly the symptom
TRA-906 was opened about. That, not the graph's share of the token block, is
what forces the change.

## What falls out

A position that keeps everything is not a position. Four things stop being
headline. None of them stops being true, and none is deleted — each moves to a
spec table or a product page where it is still checkable.

1. **"Precomputed code intelligence" as the category noun.** It names the
   mechanism of one row of four. Keep it on the graph's own page; it leaves the
   hero and the first line of `README.md`.

2. **The counts** — tools, languages, frameworks (`docs/_data/counts.yml`). They measure the
   graph's breadth. Roadmap item 6 already says count was never the metric, and
   the two largest peers compete in the opposite direction: codegraph advertises
   one tool of eight. Counts move to a spec table. They stay in `counts.yml` and
   stay guarded by `readme-claims.test.ts` — this is about billing, not
   accuracy.

3. **The 67–86% preset cut, as the flagship number.** It is 67–86% of our own
   schema footprint, which is a fraction of the MCP layer, which was 5,963 of a
   53,617-token start block on the machine we measured. Stated as the product's
   headline saving it invites the reader to think it is 67–86% of their context.
   Restated as what it is — *we cost you about 2K, not about 14K* — it is a good
   engineering claim and an honest one. It becomes a line on the tools page.

4. **"MCP server" as the self-description**, per the finding above. We are
   *delivered* partly over MCP. The registry listings can say nothing else and
   should not try (see Doors). Our own surfaces should stop leading with the
   transport.

**Not falling out:** the PR-review number — **70.5%** since 2026-09-07, not the
90.6% first published (TRA-1090: the benchmark's trace arm carried no source
code; `docs/perf/pr-context-loss-classes.md` has the account). The correction
does not change what the number is for
(`docs/_data/pr_context_bench.json`, 60 merged PRs across 6 repos that are not
ours). It is the only measurement we have on other people's code, it is a
measurement of the graph, and it stays the headline evidence under the new
headline claim. TRA-647 was already about getting it in front of arrivals; this
does not compete with it.

## The boundary, carried with the claim

Not a footnote. The same sentence, or the one immediately after it.

**We change configuration the user could change themselves. We do not patch the
client's binary, intercept its traffic, or rewrite its files.** That line is the
operating rule in `ops/context-block-levers.md` and it is what makes the claim
survivable — the first is a product, the second breaks the user's environment at
their next client update.

**The one place that boundary is under strain is `tweakcc`** (`docs/tweakcc.md`,
`src/init/tweakcc.ts`). It patches Claude Code's system prompts, which is the far
side of the line as written. It stays defensible only on a distinction the copy
has to make explicitly, every time it is mentioned: **`tweakcc` is a third-party
tool the user installs and runs themselves, and we document a pairing with it —
trace-mcp does not patch anything.** Anyone writing public copy that puts the
boundary sentence and `tweakcc` on the same page owes the reader that sentence
too. If the distinction ever stops being drawn, the honest move is to drop the
pairing from the public surfaces, not to soften the boundary: the boundary is
load-bearing for the whole claim and `tweakcc` is an optional amplifier on one
client.

**The second boundary: no absolute about locality.** Say what is true — your
code and your index stay on the machine, there is no account and no server of
ours in the path — and stop there. "100% local" is false the moment you `grep
google-analytics` over our own repo: `src/telemetry/usage-ping.ts` POSTs one
anonymous daily ping unless the user sets `TRACE_MCP_TELEMETRY=off` or
`telemetry.usage_ping: false`. The ping carries no code, no paths and no IP, and
`docs/privacy.md` lists every field it does carry — none of which rescues an
absolute. The banner chip and its `alt` text said it until 2026-09-07 (TRA-1013),
on the surface auto-indexes copy verbatim. Gated by
`tests/docs/readme-claims.test.ts` for `README.md`, `package.json`,
`server.json` and `scripts/gen-readme-banner.mjs`.

And say the reachable share out loud, because "manages your context budget"
implies a whole we do not have. The measured decomposition of one real start
block (Claude Code 2.1.239, owner's machine, 2026-09-04, `context-block-levers.md`;
baseline 53,617 tokens):

| Layer | Tokens | Whose lever |
|---|---:|---|
| Built-in tool schemas | 16,271 | the user's, via `--tools` — ours only to advise |
| The user's own skills catalog | 11,822 | the user's, delivered through the `Skill` tool |
| `CLAUDE.md` + hooks + plugin/skill loading | ~14,653 | ours, directly |
| MCP servers (deferral already applied) | 5,963 | ours in part; our own schemas are a slice of it |
| Claude Code's system prompt, bare | 4,618 | **nobody's**, outside SDK runs |
| Floor (the user turn, framing) | 290 | nobody's |

**Roughly three quarters of that block is configuration somebody chose**, and
most of it is reachable. The genuinely untouchable part is the client's own
floor — the bare system prompt plus whatever built-ins the agent actually needs
to work — call it a fifth. That is the honest shape: not "we manage your
budget", and not "we touch 3.5% of it" either.

### Two corrections this pass has to carry forward

- **The 41% / 14% split quoted in TRA-906's own description is superseded.**
  `ops/context-block-levers.md` (2026-09-04) measured the system prompt at
  4.6K bare / 8.6K with dynamic sections — the *smallest* of the five layers,
  not the second largest — and found the "41% native tools" bucket to be 16.3K
  of tool schemas plus 11.8K of the user's own skills catalog. The reachable
  share is **larger** than the framing that opened the question, not smaller.
  Do not re-quote the old table.
- **Every number here is one machine, one client, one model.** All the
  `context-block-levers.md` figures are Sonnet on the owner's machine; a spot
  check with no `--model` landed 5.4K lower. Quote them as a decomposition we
  measured, never as what the reader's block looks like. The product's answer to
  that is `get_startup_context_audit`, which measures *theirs* — which is a
  better pitch than any number of ours anyway.

## Doors

The unit that decides a door is **how a thing is installed**, not which
mechanism it belongs to. That cuts differently from the four rows above, and it
is the whole answer to TRA-906's question 3.

**One product, two doors.**

- **Door 1 — the tool surface.** Graph and `trace_state_*` and
  `get_startup_context_audit`. Installed by adding an MCP server; governed by
  presets. **The state engine does not get its own door.** Under the sentence
  above it needs no "also", so there is no second product to give one to, and
  four more tools inside a preset-governed list is not the 169-tool problem —
  roadmap item 6 is.
- **Door 2 — what `trace init` installs.** Mirrors, the guard, the apply button,
  the config edits. This door already exists in the product and has no name on
  any surface. That is the actual gap, and it is not a positioning gap so much
  as an information-architecture one: a user who installs us as "an MCP server"
  never learns half of what they installed.

**Site IA:** hero carries the sentence; two second-level entries under it, one
per door. Two pages, not four feature pages — the mechanisms are instances of
one claim and splitting them per-mechanism re-creates the "two products in one
binary" reading this pass exists to avoid.

**`server.json` — do not rewrite it to the new sentence.** Its `description` is
now the storefront for every downstream registry (mcp.so, smithery, goose,
`modelcontextprotocol/servers` all ingest it — `ops/distribution.md`, TRA-761),
and every one of those surfaces installs us as an MCP server and nothing else.
A description that promises door 2 to a reader who can only walk through door 1
is a promise the channel cannot keep. `server.json` describes the **tools**,
accurately and with numbers from `counts.yml`. The category claim is carried by
`trace-mcp.com` and `README.md`, which are the surfaces that can also deliver
door 2.

**The tool count came out of it anyway (TRA-761, 2026-09-06).** Describing the
tools is not the same as counting them, and the count was the line's most
prominent number. Three reasons it went: codegraph (68.7k stars) advertises one
tool of eight *deliberately*, because presence itself steers mis-picks — so to
an audience that reads tool count as a context-budget cost, leading with a big
one advertises the thing our own role presets were built to stop; no install
ever sees the printed number (`counts.yml` is the registered surface minus
framework-gated tools — measured 150 / 165 / 172 across three environments, and
lower again under a preset), which is defensible as documentation and
misleading as a storefront; and it was stale at 177 against 178 anyway, passing
only on `readme-claims.test.ts`'s ±5 tolerance. What replaced it is `code graph
MCP server`, the measured category term from the TRA-950 cluster — a door-1
phrase on a door-1 channel, the same carve-out this section already makes.
Languages and frameworks stay: they measure coverage a registry reader is
actually shopping for, not surface they will pay for. The description reads:

> Code graph MCP server for AI agents: 81 languages, 87 frameworks, 70.5% fewer PR-review tokens

The registry caps `description` at 100 characters (`manifest-sync.test.ts`), so
anything added here costs something already in the line.

## Sequencing against the rename

TRA-879 fixed that nothing public may move its name. **Nothing here moves a
name.** No `server.json` `name`, no npm identifier, no searchable string. This
is what we say we do, not what we are called, and it is compatible with the
rename landing or not landing.

One hard ordering constraint, which comes out of `ops/distribution.md` rather
than out of the positioning:

**The rename (TRA-644) and this repositioning rewrite the same description
strings on the same external surfaces**, and most of those surfaces cannot be
edited twice at reasonable cost — mcpmarket.com has no self-serve edit at all
($29 or an email), mcpservers.org is a review-queued form, claude-code-templates
is a PR into someone else's repo, pulsemcp is waiting on a sync we do not
control. So:

> **Finalise the positioning copy before the rename PR opens, and land both in
> one edit per surface.**

Getting this backwards costs a second pass through every door in the ledger,
several of which do not open twice.

## Surfaces this obliges us to change

The output of this pass is this file plus the list below. Each line is an
ordinary issue, not part of this pass. Ordered by how much a reader sees it.

| Surface | Change | Note |
|---|---|---|
| `docs/index.html` hero | **Done (TRA-918).** Headline → the sentence. Boundary line under it. The PR figure moved to the subhead as evidence | Eyebrow kept — it was right all along. Category term stays on the `<title>` and the Product View heading, not the hero |
| `README.md` first screen + banner PNGs | **Done (TRA-918).** Same sentence, verbatim, plus the boundary line | Banner regenerated from `scripts/gen-readme-banner.mjs` — the tagline lives in that script, not in the PNG |
| `docs/_config.yml` `description` | **Done (TRA-918).** Sentence first, then the category term; no hand-typed number | Feeds meta description on every page, so it is cut to 155 characters |
| Site IA | Two second-level entries, one per door; door 2 has no page today | The real gap; see Doors |
| `comparisons.md` | Compares graph-to-graph today. The `/vs/` claim changes shape | Coordinate with SEO — TRA-876 just landed benchmark copy on three `/vs/` pages |
| `server.json` `description` | **Tools only** — do not carry the category sentence | Deliberate; see Doors |
| `serverInfo` at `initialize` (`src/server/server.ts`, `SERVER_IDENTITY`) | **Done (TRA-1119).** `title` names the category, `description` is tools-only phrasing plus an explicit denial of the wrong one | The client's server list — the first and often only description a user reads. Three parties filed us as a tracing/observability server from the bare name; evidence in `ops/distribution.md`. No counts here |
| Directory listings (`ops/distribution.md`) | Only where copy is ours to edit, and **only together with the rename** | See Sequencing |
| `docs/ROADMAP.md` item 8 | Superseded by this file | Roadmap autopilot's next revision |

## The `<title>` is a door, not the position (TRA-950, 2026-09-05)

The position sentence above has the same defect the old headline had, and it is
worth naming before someone spends a quarter on it: **it contains nothing anyone
searches for.** DataForSEO (Google Ads, US/English, 2026-09-05) returns no volume
record at all for `precomputed code intelligence` or `code intelligence for ai
agents`, and it returns none for the new sentence's vocabulary either. GSC for
`sc-domain:trace-mcp.com`, 2026-08-06 → 2026-09-04, shows the bill: the home
page's two largest non-brand impression sources were `traceix mcp` (61) and `mcp
tracing` (50) — 111 impressions, zero clicks, both name lookalikes Google matched
because there was no category phrase on the page to match instead.

So the two requirements are real and they are not the same requirement:

- The **hero sentence** answers "what is this", to a reader who is already here.
- The **`<title>`, meta description and section headings** answer "is this the
  kind of thing I typed", to a reader who is not here yet.

The resolution, and the precedent to follow next time they collide: **the title
carries the measured category term, the hero carries the position.** The home
page title is now `trace-mcp — code graph MCP server for AI coding agents`.

That is the same carve-out this file already makes for `server.json` under
Doors, for the same reason — a channel that can only deliver door 1 gets
described in door 1's words. A Google SERP for `code graph mcp` is that kind of
channel. The reader arriving on it is looking for a code graph MCP server, we
are one, and the page they land on is free to tell them we are more. The title
is the door; the page is the pitch.

Chosen cluster and why not a bigger one: `code graph mcp` / `codegraph mcp`
(70/mo each, 10 → 140 and 10 → 260 over twelve months, LOW competition) has a
live top-20 of standalone product sites — `code-review-graph.com` at 6,
`depgraph.ai` at 13, `codecontextgraph.com` at 16 — and we already rank #1–2 on
its long tail from `comparisons.html` (`serena mcp vs codegraph`, `codegraph vs
serena`, `repomix vs codegraph`). Every non-brand click the site earned in those
30 days came from this vocabulary. `claude code mcp server` is 12× the volume
and was rejected: its top-10 is Anthropic's docs plus listicles, no single
product homepage ranks, and the way into that SERP is being listed inside those
articles — outreach, not a page.

**What this does not license.** The head term went onto the title, the meta
description, and the Product View section heading — the graph's own section,
where it is exactly accurate. It did **not** go into the hero subhead, which
TRA-950 originally proposed. That sentence is the position claim's instance and
narrowing it to the graph is the specific move this file exists to prevent.
`tests/docs/category-term.test.ts` guards the three placements that stayed;
`tests/docs/searchable-name.test.ts` guards the brand string alongside it.

## Open

- **Door 2 has no measured pitch yet.** Mirrors are verified not to break the
  prefix cache (TRA-860 — they cut cache *writes* by 95%; the JetBrains `rtk`
  mechanism does not reproduce here) but showed **0 pp solve-rate change** over
  108 live runs, and the 80/40 default did not repay. Cost down, capability
  flat. That is a real result and a thin headline. Door 2's page should lead
  with the audit — which measures the reader's own block — not with the mirrors.
- **`trace_state_*` has its A/B, and the quality half is not usable yet.**
  Phase 4 reported −66.8% prompt tokens, −59.2% total, O(T) instead of O(T²)
  prompt growth, loops 2.7% → 0.0% — and **Pass@1 100% in both arms** over 18
  pinned tasks and 777 steps. Equal success at a ceiling means task success was
  never at risk in that harness, so the run demonstrates compression and does
  not yet demonstrate that compression is free. That is the shape TRA-880 just
  disproved about our own counter. **No part of that number goes on a public
  surface until one arm can fail** (roadmap item 8). This pass answers where
  state belongs, not what may be claimed for it.

  **2026-09-07, TRA-1115: an arm can now fail, and it failed.**
  `pnpm bench:state-recall` grades long-horizon fact retention against a planted
  ground truth. Three arms: the whole transcript recalls 100%, a transcript
  truncated to 4 500 tokens recalls 43.1%, and a rewritten state block recalls
  **76.4%** at Pass@1 67%. So the state block buys 33 points over a truncating
  context and **gives up 23.6 points against a transcript that fits** — wider
  than TRA-568's 15-point gap on context packing. All 17 lost facts were written
  into state and then erased by a later rewrite; none was missed at capture.
  The embargo therefore stays: the honest sentence today is "cheaper than
  truncation, not free against a full transcript." One caveat travels with it —
  the measured arm rewrites its block each turn, while the shipped
  `trace_state_patch` is an RFC 7396 merge patch that cannot touch keys it does
  not name, so the shipped loop has not been measured yet. Reading:
  `benchmarks/state-recall/README.md`.
- **Nothing here is measured on a client other than Claude Code.** Door 2 is
  mostly Claude-Code-shaped: the guard hook and the `tweakcc` pairing (third
  party, see the boundary above) are Claude Code only,
  Cursor and Windsurf get a rules file, everything else gets tool descriptions.
  A category claim that only lands on one client is a narrower claim than it
  reads as. TRA-673 owns finding out.

## Where the category term gets a page — decided (TRA-1024, 2026-09-06)

The cluster above (`code graph mcp` / `codegraph mcp`) needed a landing target,
and there were two candidates: repurpose `comparisons.html`, whose title already
reads "Serena, Repomix & 20+ Code Graph MCP Servers Compared", or build a new
page. **Decided: a new compact page, `/code-graph-mcp.html`.** Three reasons, in
the order they settled it:

1. **The SERP is made of product pages, not tables.** Live top-20, 2026-09-06:
   `code-review-graph.com` at 6, `depgraph.ai` at 10, `codecontextgraph.com` at
   16 — standalone product sites the size of ours. The one comparative result is
   a third-party listicle at 12, which is a format we cannot occupy from our own
   domain anyway. `comparisons.md` is 96 KB of source and does not rank for the
   head term today after five months of trying.
2. **Repurposing costs a position we already hold.** `comparisons.html` ranks
   #1–2 on the comparative long tail (`serena mcp vs codegraph`, `codegraph vs
   serena`, `repomix vs codegraph`). Retitling and compacting it toward "what is
   a code graph MCP server" trades a page that wins for a page that might.
3. **The intent does not match.** A reader typing the bare category term is
   asking what the thing is and which one to install, not for a 20-product
   matrix. The matrix is the second click, and the new page links to it.

Constraint for whoever writes it: compact — product-shaped, one screen of what
it is and what it costs, then out to `comparisons.html` for the deep table and
to the `/vs/` pages for named peers. If it grows past a few hundred lines it has
become `comparisons.html` again and the decision above is void.

### Correction: `serena mcp` is not 2400/mo of addressable volume

`serena mcp` (2400/mo) is the largest term in the category and we have
`docs/vs/serena.md` pointed at it. The live top-20 contains **no comparison page
and no "alternative" page**: the official repo and docs (3), MCP directories
(6), install tutorials (6), Reddit, YouTube (2), one benchmark. The intent is
"what is this / how do I install it", which a `trace-mcp vs Serena` page cannot
serve by construction; what it can serve is `serena mcp alternative` — **10/mo**.
`repomix` (1600/mo) fails the same check.

This does not retire `vs/serena.md`: it earns the comparative long tail, where
it ranks #1 (TRA-1022). It retires the *arithmetic* — 2400 and 1600 are not
volume we can address with the pages we have, and no plan should count them.

Two more things for whoever writes it, one from review: link it from the home
page and the footer, and put it in `docs/sitemap.xml`. The sitemap entry is the
part that decides whether it gets indexed — all 13 indexed pages on this domain
report `sitemap.xml` as the referring source and not one was reached through an
in-body internal link (`ops/index-coverage.md`, TRA-995). The internal links are
for the reader and for link equity, not for discovery.
