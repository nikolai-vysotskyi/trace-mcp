# Reddit material — ready to post, not posted

Companion to `ops/launch-hn.md`, and deliberately not the same text. Reddit
punishes the HN register: a post that reads like a launch announcement gets
removed by a rule, downvoted as an ad, or both. **Nobody but Nikolai posts
this**, same as the HN draft — an agent may write and revise it, publishing
under the project's name is his call.

Numbers verified 2026-08-30 against `docs/_data/counts.yml` (81 languages /
87 frameworks / 169 tools). Nothing enforces this file — `readme-claims.test.ts`
guards `README.md` only — so re-read the source before posting.

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

## Post — r/mcp (flair: `showcase`)

Title:

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

## What changes for r/ClaudeAI (flair: `Built with Claude` or `Promotion`)

Same substance, different opening. That sub cares about the Claude Code
workflow, not the architecture, so lead with the workflow and put the graph
second:

> If you use Claude Code on a repo big enough that it forgets, the thing eating
> your budget is re-reading, not thinking. […]

Keep the numbers paragraph and the telemetry sentence verbatim. Drop the
tree-sitter and Inertia detail — it reads as showing off to that audience.

Rule 7 also requires two things the r/mcp version does not: say plainly that
**it is free** (MIT, no paid tier), and be explicit that it was **built for
Claude Code by the person posting**. Both are true; they just have to be on the
page. Keep promotional adjectives out entirely — the rule says "promotional
language minimal" and that sub enforces it by downvote regardless.

## Answering the comments

The Reddit versions of the HN questions, in the order they actually arrive:

1. **"Isn't this just what Serena/Repomix does?"** → `trace-mcp.com/comparisons.html`
   and the four head-to-head pages (Serena, Repomix, codegraph,
   codebase-memory-mcp). Link, do not paraphrase — paraphrasing a competitor from
   memory is how you get corrected by their maintainer in public.
2. **"Show the benchmark — measured with which tokenizer, against which
   baseline?"** This is the one that decides the thread, and it arrives fast. Two
   comparable posts in these subs were taken apart on exactly this: one for
   moving tokens from output to input rather than removing them, one for
   estimating tokens as bytes ÷ 4. The honest answer, which is checkable in
   `src/analytics/benchmark.ts`: tokens are estimated from character count using
   a chars-per-token ratio that is **calibrated against a real BPE tokenizer**
   (`gpt-tokenizer`, cl100k_base) when it is installed, falling back to 4.0
   otherwise — and the result carries `chars_per_token` and
   `tokenizer_calibrated` so you can see which happened. Say the two limits
   yourself: cl100k_base is OpenAI's tokenizer, not Claude's, and the "without
   trace-mcp" side is *modelled* from file sizes rather than measured from a real
   agent run. For measured numbers from real sessions there is
   `trace-mcp analytics savings`. Never let someone else be the one to point out
   that the estimate is an estimate.
3. **"169 tools is going to blow up my context."** → fair. Tools register per
   detected framework, presets narrow it further, and shrinking the surface is
   ongoing work. Don't argue this one; agree and describe the mechanism.
4. **"Does it phone home?"** → yes, one anonymous ping a day: random id, version,
   OS, two aggregate counters. No paths, no code. `TRACE_MCP_TELEMETRY=off`,
   source at `src/telemetry/usage-ping.ts`. Answer in full the first time.
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
