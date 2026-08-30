# Reddit material — ready to post, not posted

Companion to `ops/launch-hn.md`, and deliberately not the same text. Reddit
punishes the HN register: a post that reads like a launch announcement gets
removed by a rule, downvoted as an ad, or both. **Nobody but Nikolai posts
this**, same as the HN draft — an agent may write and revise it, publishing
under the project's name is his call.

Numbers verified 2026-08-30 against `docs/_data/counts.yml` (81 languages /
87 frameworks / 169 tools). Nothing enforces this file — `readme-claims.test.ts`
guards `README.md` only — so re-read the source before posting.

## We are already on Reddit and cannot read it

`ops/user-signal.md` (2026-08-30) puts **reddit.com as the repo's #1 referrer** —
90 views / 35 uniques in 14 days, ahead of Google on views (Google still
leads on uniques, 39 to 35). Somebody has already posted or
recommended trace-mcp there, the thread is driving more traffic than any other
source, and the login wall means no run can find it.

Two consequences for anything written here. First, a post is not an introduction
to a cold audience; some of that sub has met the project already. Second, and
more useful: **find the existing thread before posting a new one.** Replying as
the maintainer in a thread that already has traction beats a fresh post that
starts at zero, and it costs no karma and no rule risk. That is a browser job,
not an agent one.

## The rule that decides everything

Every relevant subreddit has a self-promotion rule, and they differ enough that
one text cannot satisfy all of them. Read the specific rule table below before
choosing where to post. Two constants:

- **Disclose the affiliation in the post itself**, first person, no "I found
  this cool tool". Every sub that allows self-promotion at all requires this,
  and the ones that don't say so still enforce it socially.
- **Do not post LLM-written prose.** r/LocalLLaMA bans it outright
  (*"Completely/primarily LLM generated copy, code is not allowed"*). This file
  is a draft to rewrite in Nikolai's own words, not copy to paste. That is not a
  style preference — pasted model prose is the single most reliable way to get
  removed and flamed in these subs.

## Where, in priority order

Rules below are quoted from each sub's own rules page (archived crawls, 2026-07
to 2026-08 — Reddit blocks direct fetches from this machine, so re-read them in a
browser before posting; a rule can change between now and then).

| Subreddit | Self-promotion rule | Gates |
|---|---|---|
| **r/ClaudeAI** — post here first | Rule 7 **encourages** it: *"be clear the project was built with Claude/Claude Code or specifically for Claude BY YOU… project must be free to try and say so… promotional language minimal… do not use referral links"* | **OP karma > 50** for feed posts. Flair required (Rule 9) — `Built with Claude` or `Promotion` fit. Rule 6 means any competitor framing needs evidence, not assertion. |
| **r/mcp** — second, expect little | Rule 3: *"Self-promotion is allowed with proper disclosure. Anyone caught promoting their product while pretending to be an unaffiliated user will be permanently banned."* Rule 4 asks for the `showcase` tag | Rule 2 — *"No AI generated slop… Such content will result in a ban."* Sobering data point: every "I built this" post archived there in the last three months scored 2–3 with 1–4 comments. On-topic, but close to no organic pickup. |
| r/LocalLLaMA | Rule 4, the 1/10th rule: *"self-promotion should not be more than 10% of your content. Affiliation must be disclosed"* | Rule 3 bans *"Completely/primarily LLM generated copy"* outright. Weak fit anyway — trace-mcp is not a local-model project. Needs a real comment history first. |
| r/ChatGPTCoding | Rule 4 is vague and may route promotion to a designated thread or a modmail sponsorship | Rule 2: flair mandatory. Weakest fit of the four — the sub is about code ChatGPT wrote, which is not what this is. |

The ordering is the finding, and it inverts the obvious guess: r/mcp is the
on-topic sub and the one where these posts go nowhere; r/ClaudeAI is where the
audience actually is, and it is the one with a karma gate and an explicit
"built with Claude BY YOU" framing requirement. Check the karma balance before
writing anything.

## Post — r/ClaudeAI (flair: `Built with Claude` or `Promotion`)

The sub the table says to post to first, so the finished copy is here. Rule 7
needs three things on the page, all true and all easy to leave out: that **you**
built it, that it is **for Claude Code**, and that it is **free**.

Title:

> I got tired of watching Claude Code re-read the same files, so I built it a code graph

Body:

> My own project, and free — MIT, no paid tier.
>
> If you use Claude Code on a repo big enough that it starts forgetting, the
> thing eating your budget is re-reading, not thinking. Ask it "what breaks if I
> change this model?" and it greps, opens twenty files, answers — then does the
> same walk again two turns later. Cost scales with the repo instead of with the
> question.
>
> So I built trace-mcp: it indexes the repo once into a local graph and serves it
> to Claude Code over MCP, so the agent looks structure up instead of deriving it
> again every turn. `get_change_impact` on a model gives the blast radius in one
> call, and it crosses language boundaries — it knows an Inertia render string
> ties PHP to a Vue component, that a DI decorator is an edge, that an Eloquent
> relation implies a table from a migration.
>
> Numbers, honestly: about 40–50% fewer tokens across a mixed session. Individual
> structured calls go much higher, but that is a per-call peak and quoting it as
> an average is how these posts lose credibility. Runs locally, no API keys. One
> anonymous daily ping goes to Google Analytics; `TRACE_MCP_TELEMETRY=off` kills
> it.
>
> `npx trace-mcp index . && npx trace-mcp benchmark .` prints per-task numbers for
> your own repo — read the caveats in the reply below before you quote them at
> anyone. Happy to answer anything, including where it is worse than the
> alternatives.

Drop the tree-sitter detail and the language count — that audience reads counts
as bragging. Keep promotional adjectives out entirely: the rule says
"promotional language minimal" and the sub enforces it by downvote regardless.
Post the benchmark caveats as your own first comment, the way the HN draft does.

## Post — r/mcp (flair: `showcase`)

Second, and expect little. Title:

> I built an MCP server that gives the agent a code graph instead of letting it re-read files

Body:

> I maintain trace-mcp — saying that up front, this is my own project.
>
> The thing that bugged me: ask an agent "what breaks if I change this model?"
> and it greps, opens twenty files, answers, and then does the same walk again
> two turns later. The cost scales with the repo instead of the question.
>
> So it indexes the repo once into a local SQLite graph — tree-sitter, 81
> languages — and serves it over MCP. The bit I actually care about is the
> framework edges: `Inertia::render('Users/Show')` links PHP to a Vue component,
> `@Injectable()` is a DI edge, `$user->posts()` implies a table from a
> migration. So `get_change_impact` crosses language boundaries instead of
> stopping at the import graph.
>
> Numbers, honestly: about 40–50% fewer tokens across a mixed session. Individual
> structured calls go much higher, but that is a per-call peak and quoting it as
> an average is how these posts lose credibility. It is MIT, runs locally, and
> there is one anonymous daily ping you can kill with `TRACE_MCP_TELEMETRY=off`.
>
> `npx trace-mcp index . && npx trace-mcp benchmark .` prints per-task numbers for
> your own repo. Happy to answer anything, including where it is worse than the
> alternatives — Repomix is the better tool if you only want to stuff a repo into
> one prompt, and I say so on the comparison page.

The r/mcp version keeps the architecture detail the r/ClaudeAI one drops — that
sub is people who build MCP servers, so tree-sitter and the framework-edge
examples are the interesting part rather than showing off.

## Answering the comments

The Reddit versions of the HN questions, in the order they actually arrive:

1. **"Isn't this just what Serena/Repomix does?"** → `trace-mcp.com/comparisons.html`
   and the five head-to-head pages (Serena, Repomix, codegraph, Context Mode,
   codebase-memory-mcp). Link, do not paraphrase — paraphrasing a competitor from
   memory is how you get corrected by their maintainer in public. Context Mode is
   the likeliest "but what about X" in these subs given its star count, and it has
   its own page; know that before the comment arrives.
2. **"Show the benchmark — measured with which tokenizer, against which
   baseline?"** This is the one that decides the thread, and it arrives fast. Two
   comparable posts in these subs were taken apart on exactly this: one for
   moving tokens from output to input rather than removing them, one for
   estimating tokens as bytes ÷ 4. The honest answer, which is checkable in
   `src/analytics/benchmark.ts`: tokens are estimated from character count using
   a chars-per-token ratio that is **calibrated against a real BPE tokenizer**
   (`gpt-tokenizer`, cl100k_base) when it is installed, falling back to 4.0
   otherwise — and the result carries `chars_per_token` and
   `tokenizer_calibrated` so you can see which happened. Then say all three
   limits yourself, biggest first: **neither side is measured** — the "without"
   side is modelled from file sizes and the trace-mcp side from fixed
   per-scenario multipliers, not real tool invocations (`accuracy.caveats[1]`
   ships that sentence in the JSON, and the multipliers are visible constants a
   few lines into the file you just invited them to open). And cl100k_base is
   OpenAI's tokenizer, not Claude's. It models a ceiling. For numbers measured
   from real sessions there is `trace-mcp analytics savings`. Never let someone
   else be the one to point out that the estimate is an estimate.
3. **"169 tools is going to blow up my context."** → fair. Tools register per
   detected framework, presets narrow it further, and shrinking the surface is
   ongoing work. Don't argue this one; agree and describe the mechanism.
4. **"Does it phone home?"** → yes, one anonymous ping a day: random id, version,
   OS, two aggregate counters. No paths, no code. **Say where it goes** — an HTTP
   POST to `google-analytics.com` via the GA4 Measurement Protocol, with the
   measurement id and write-only api_secret shipped in the bundle by design.
   `TRACE_MCP_TELEMETRY=off`, source at `src/telemetry/usage-ping.ts`. "You forgot
   to mention it's Google" is a cheap and correct reply, and it lands twice as
   hard after you have said you were answering in full. So answer in full.
5. **"Another AI-generated slop tool"** → the fair answer is the repo: tests, a
   changelog, issues from strangers that got fixed. Do not argue about how the
   code was written; point at what it does and let them look. Related and worth
   pre-empting: in the one comparable post that did well, commenters spotted that
   *the author's own replies* were model-written ("You're absolutely right!") and
   held it against a tool sold on cutting fluff. Answer in your own voice.

Expect the top comment to be genre fatigue rather than a question — the
best-performing comparable post's highest-scored reply was "You and the 100
people who posted something like this this week should work together." There is
no rebuttal to that; answer the technical comments underneath it instead.

## What not to do

- Do not post the same text to two subs on the same day. Cross-posting reads as
  spam and the second one gets removed.
- Do not paste this draft. Rewrite it — see the LLM-prose rule above.
- Do not reply to a hostile comment twice. One honest answer, then stop.
- Do not post from a fresh account with no history. Several of these subs gate on
  karma and account age, and a zero-history account posting a GitHub link is the
  exact shape their spam filters catch.
