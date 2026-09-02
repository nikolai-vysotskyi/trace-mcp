# Distribution ledger — where trace-mcp is listed, and what we already found out

Every external surface that lists trace-mcp, what it currently shows, and how it
can be changed. Not a public page: `ops/` is outside the Jekyll site in `docs/`.

**Read this before any distribution / directory / listing work. Update it in the
same change that touched a surface.** Without it every run re-discovers the same
things — that mcp.so dropped free submissions, that PulseMCP submissions are
paused — and either wastes the run or reaches a different conclusion than the
last one did.

Rules for keeping it honest:

- Record what you **verified**, with the date you verified it. "Absent from a
  WebSearch" is not "absent" — TRA-352 called mcpmarket.com missing on that basis
  and it had been listed all along.
- Record the **decisions and the dead ends** too, not just the state. A closed
  door with no reason written down gets pushed on again next month.
- Numbers quoted to the outside world come from `docs/_data/counts.yml`
  (169 tools / 81 languages / 87 frameworks as of 2026-08-29). Never hand-type
  them, and re-read the file rather than trusting a number written here: the
  language count moved from 80 to 81 within a day of this ledger being started.

## Surfaces

| Surface | Listed | Arrivals | What it shows | How to change it | Verified |
|---|---|---|---|---|---|
| [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io) | Yes — `io.github.nikolai-vysotskyi/trace-mcp` | None | Current: 3.1.1, correct counts | Automatic: `.github/workflows/publish-mcp-registry.yml` republishes `server.json` on every release (GitHub OIDC, no secret) | 2026-08-29 |
| [glama.ai](https://glama.ai/mcp/servers/nikolai-vysotskyi/trace-mcp) | Yes | None | Correct — scrapes README/npm live | Nothing to do; fix the README and it follows | 2026-08-29 |
| [pulsemcp.com](https://www.pulsemcp.com/servers/nikolai-vysotskyi-trace) | Yes | None | **Stale: "44+ tools"** — their hand-written `server.json`, kept "until the maintainer publishes to the official registry" | Their submissions are **paused**; their own submit page says publishing to the official registry is the fix. Done 2026-08-29 — waiting on their next sync | 2026-08-29 |
| [mcpservers.org](https://mcpservers.org/servers/nikolai-vysotskyi/trace-mcp) | Yes | None | Body correct; **header stale**: "53 framework integrations across 68 languages, 100+ tools" | Free form at `/submit` (no account, needs a contact email). Correction submitted 2026-08-29, review ≤12h — but it said "80 languages … up to 99% fewer tokens", and master has since moved to 81 languages and a 40–50% claim, so re-submit once it lands. Premium $39 — declined | 2026-08-29 |
| [mcpmarket.com](https://mcpmarket.com/server/trace) | Yes, as **"Trace"** | None | Same stale "53 frameworks / 68 languages" copy | No self-serve edit. $29 paid listing, or email support@mcpmarket.com. Free queue re-submit answers "already listed" | 2026-08-29 |
| [mcp.so](https://mcp.so) | **No** | None | — | **Free submission no longer exists** — `/submit` offers only "Pay and submit automatically", $39. They ingest the official registry, so expect a free pickup | 2026-08-29 |
| [smithery.ai](https://smithery.ai) | **No** | None | — | Two blockers, not one: the account needs GitHub OAuth (an agent must not authorize that on Nikolai's behalf), **and** a stdio server is published as an MCPB bundle — `smithery mcp publish ./server.mcpb -n <org>/<name>`, per `smithery.ai/docs/build/publish.md`. There is **no `smithery.yaml`** in their current docs; older writeups describing one are stale. They also ingest the official registry | 2026-08-29 |
| [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) | **Yes** | None | Listed under `Developer Tools`, alphabetical, with the Glama badge and an accurate description | PR to README. Their CONTRIBUTING asks automated agents to append `🤖🤖🤖` to the PR title. Nothing to submit — only re-read the entry when the product's shape changes | 2026-09-01 |
| [hashgraph-online/awesome-ai-plugins](https://github.com/hashgraph-online/awesome-ai-plugins) | **Yes** | None | Listed under `Community Plugins → Development & Workflow` | PR to README. PR #182 merged 2026-08-31 by `kantorcodes` without requiring third-party scanner action | 2026-09-01 |
| [aaif-goose/goose](https://github.com/aaif-goose/goose) extension directory | **No — submitted** | None | — | The directory is a plain file, `documentation/static/servers.json`, and third-party entries land by PR to it (#10650 pngmeta, #10638 Glif, both single-file, merged 2026-07-29). But CONTRIBUTING runs an **issues-first** process: "Pull requests that do not implement a Ready issue will be closed", and the exemptions are dependency bots, security fixes and core-team work, not directory additions. So the entry sits finished on `nikolai-vysotskyi/goose:add-trace-mcp` (11 lines, alphabetical between `tom` and `tutorial-mcp`) and [issue #11763](https://github.com/aaif-goose/goose/issues/11763) asks for Ready. Open the PR when it gets there; don't open it before | 2026-09-01 |
| [QuesmaOrg/awesome-ai-tokenomics](https://github.com/QuesmaOrg/awesome-ai-tokenomics) | **No — submitted** | None | — | [PR #53](https://github.com/QuesmaOrg/awesome-ai-tokenomics/pull/53), Optimize → Context Engineering, beside Serena and Repomix. An entry is three files: the README line, the same line in `research/optimize.md`, and a record in `research/manifest.json` carrying `verified_on` / `stale_after`. Their `scripts/lint_readme.sh` **fails the build on any em-dash in tracked markdown** and on a list of superlatives (`de facto`, `go-to`, `widely used`, `the leading`, …) — write entries accordingly. Self-submission is allowed but needs a disclosure, checkable primary sources, and an independent adoption signal that is not stars | 2026-09-01 |
| [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) | **No** | None | — | **Gate met, door still human-only.** Their bar is ≥100 stars *or* 14 days of active development; we passed the star half on 2026-09-01 (102). But CONTRIBUTING is explicit: "ALL RECOMMENDATIONS MUST BE MADE USING THE WEB UI ISSUE FORM TEMPLATE, OR YOU RISK BEING RESTRICTED FROM INTERACTING WITH THIS REPOSITORY", "It is **not** possible to submit a resource recommendation using the `gh` CLI", and "recommendations must be created by human beings". Three of the form's required checkboxes are personal attestations. An agent must not fill this in; the ready-to-paste field values are in TRA-633 | 2026-09-01 |
| [hashgraph-online/awesome-codex-plugins](https://github.com/hashgraph-online/awesome-codex-plugins) | **No — declined by us** | None | — | Same org that merged us into `awesome-ai-plugins`, and we do ship a Codex plugin, so this looks like the obvious next door. It is not. There the scanner action was *advisory* and we were merged without it; here CONTRIBUTING step 1 is "Set up scanner CI in your plugin repo (required) … This is not optional. We verify this during review" — `hashgraph-online/ai-plugin-scanner-action@v1` committed into our workflows, plus `pipx install plugin-scanner` run locally. Both are the thing we already refused. **Closed unless their gate changes** | 2026-09-01 |
| [cursor.directory](https://cursor.directory) (`pontusab/directories`) | **No** | None | — | Repo holds no listing data ("All content is submitted through the website"); submission is `cursor.directory/plugins/new` behind GitHub or Google sign-in, so it is human-only like Smithery. Worth knowing anyway: they auto-detect components from a repo following the [Open Plugins](https://open-plugins.com) spec, and the MCP hook is a **`.mcp.json` at the repo root**. Ours lives at `.claude-plugin/.mcp.json`, so we are currently undetectable there — see TRA-634 | 2026-09-01 |
| [appcypher/awesome-mcp-servers](https://github.com/appcypher/awesome-mcp-servers) | **No — dead** | None | — | **The repo is archived** (last push 2026-05-06; 5,764 stars). GitHub refuses pull requests against an archived repo, which is what "does not have the correct permissions to execute `CreatePullRequest`" actually means — TRA-482 read that error as a token-scope problem and parked the submission on Nikolai. It was never his to unblock. The prepared fork branch `nikolai-vysotskyi/awesome-mcp-servers-appcypher:add-trace-mcp` is dead weight | 2026-09-01 |
| [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | — | None | — | **Not a door any more.** The README is now reference servers only and says so in a banner: "If you are looking for a list of MCP servers, you can browse published servers on the MCP Registry." No community-servers section survives to be added to. We are in the registry it points at, so this is already covered | 2026-09-01 |
| [wong2/awesome-mcp-servers](https://github.com/wong2/awesome-mcp-servers) | **No** | None | — | **Not a separate door.** Its README refuses PRs outright and redirects to `mcpservers.org/submit` — the same form as the mcpservers.org row above. Treat the two as one channel | 2026-08-29 |
| [Cline MCP Marketplace](https://github.com/cline/mcp-marketplace) | **No** — checked their live catalog API (`api.cline.bot/v1/mcp/marketplace`, 199 entries), not a web search | None | — | Closest thing to an open door left. Open an issue on `cline/mcp-marketplace` with their `mcp-server-submission` template: repo URL, a **400×400 PNG** logo, reason for addition. `llms-install.md` is optional — their FAQ says a well-written README is usually enough (there is no crawler; Cline itself reads the README at install time). Their step 3 also asks the submitter to confirm they have watched Cline set the server up from the README alone. The logo is now in-repo at `docs/icon-400x400.png`. No account or payment — but that step-3 checkbox is **required**, so this is not an agent-alone submission; see "Next door to try" | 2026-08-29 |
| [Docker MCP Catalog](https://github.com/docker/mcp-registry) | **No** — listed all 328 entries of `servers/` via the GitHub contents API | None | — | **Blocked on an artifact we don't have.** Both paths need something trace-mcp isn't: "Local" wants a Dockerfile in our repo, "Remote" wants a reachable streamable-http/SSE endpoint. A plain npm/stdio package qualifies for neither. Adding a Dockerfile is a product decision, not a listings one — don't smuggle it in as distribution work | 2026-08-29 |
| Continue.dev Hub | — | None | — | **Dead product, not a gap.** Continue was acquired by Cursor (June 2026), the final release shipped 2026-06-19, cloud data was deleted after 2026-07-15, `hub.continue.dev` no longer resolves. The GitHub repo is **not** archived and is still public — do not describe it as read-only — but it has shipped nothing since (last commit 2026-07-21). Re-check only if Cursor stands a successor up | 2026-08-29 |
| [LobeHub](https://lobehub.com/mcp) | **No** — the `trace-mcp` listing there is `Mnehmos/trace-mcp`, an unrelated project with the same name | None | — | Publishing is `npx @lobehub/market-cli`, and it requires `lhm login` (browser OIDC) plus `lhm github connect` (browser ownership check). There is no token-only path: verified in `@lobehub/market-cli@0.0.41` itself, because their docs pages under `lobehub.com/docs/market/*` are content-free stubs. `plugin publish` and `plugin claim` both go through `createUserSDK()`, which aborts with "Not logged in. Run `lhm login` first" unless a user OAuth token is on disk; the `MARKET_CLIENT_ID`/`MARKET_CLIENT_SECRET` env pair is never used for publishing. Human-only, like Smithery | 2026-08-29 |
| [skillsllm.com](https://skillsllm.com/skill/trace-mcp) | **Yes** — found while checking it as a "roundup" (see below); it is a directory, and we were already in it | None | Accurate and live: 177 tools / 81 languages / 102 stars, matching `docs/_data/counts.yml` on the day it was read. Passed their Semgrep + dependency scan | Nothing to submit. Their `/about` says a scraper "searches GitHub daily for repositories containing SKILL.md files or tagged with relevant topics like `claude-code`, `ai-agent`, `mcp-server`" — we carry all three, so the topics row below is what put us here and what keeps the numbers current. A `/submit` form and a paid "Featured Listing" also exist; neither is needed | 2026-09-02 |
| GitHub repo topics | **Yes** — always on, the surface is ours | `github.com` 25/8 — indistinguishable from any other in-GitHub link | **20 of 20 slots used** — the cap. Changed 2026-08-30: dropped `token` and `tokens` (3,892 / 1,572 repos, almost all auth or crypto — wrong audience for a word we only meant one way) and `claude-skill` (near-duplicate of `claude-skills`, which is the bigger of the two: 7,662 vs 4,841); added `code-graph` (208 repos), `dependency-graph` (901) and `static-analysis` (8,072) | The one listing surface we own outright: `gh api -X PUT repos/:r/topics --input <json>`, instant, reversible, no review. Topic pages are a browse surface, so a *small* exact topic like `code-graph` is worth more than a big vague one. Sizes via `gh api "search/repositories?q=topic:<t>&per_page=1" --jq .total_count`. Before rebalancing again: 7 of the 20 slots are `claude-*` variants (8 before this change), which is defensible but is where the next slot comes from; `rag` (43,793) is the other weak slot — we retrieve, but we are not a RAG pipeline | 2026-08-30 |

The repo's own `description` and `homepage` are part of that surface and were
left alone — the description already leads with the clients and a concrete
number, which is what a GitHub search result needs.

Community channels (Hacker News, Reddit) are not in this table because they are
not listings — nothing there is maintained, only posted once. The drafted
material lives in `ops/launch-hn.md` and `ops/launch-reddit.md`, and posting it
is Nikolai's call. What those channels currently *say about us* — and which of
them can actually be read from a run — is tracked in `ops/user-signal.md`.

### The Arrivals column — did the listing send anyone (TRA-645)

**Listed is not arrived.** Until 2026-09-02 this ledger tracked twelve surfaces
and could not say whether a single one of them had ever produced a visitor, so
every submission was graded on effort rather than result. The column closes
that: it records what the referrer data actually shows, per surface, so a
future run can tell "checked, nothing" from "never checked" — rule 1 of this
file applied to arrivals instead of to listings.

Read it from GitHub's traffic API, which is the only acquisition source we
have. `trace-mcp.com` carries no analytics of its own, so the docs-side entry
URLs the original scope suggested measure nothing today; and Reddit, our
largest external referrer, is unreadable from a run at all
(`ops/user-signal.md`).

```
gh api repos/nikolai-vysotskyi/trace-mcp/traffic/popular/referrers
gh api repos/nikolai-vysotskyi/trace-mcp/traffic/views
```

**Reading, 2026-09-02** — 645 views / 178 uniques over the trailing 14 days:
Google 37 uniques, reddit.com 31, trace-mcp.com 17, github.com 8,
my.feishu.cn 1, l.threads.com 2, Bing 3, yandex.ru 1, DuckDuckGo 1,
claude.ai 1.

**Not one of the twelve surfaces in the table appears.** No glama.ai, no
pulsemcp.com, no mcpservers.org, no mcpmarket.com, no
registry.modelcontextprotocol.io, no awesome-mcp-servers. The same was true of
the 2026-08-30 reading in `ops/user-signal.md`, so this is two independent
14-day windows agreeing, not one bad fortnight. Everything measurable comes
from search, from Reddit, and from our own site.

Two honest limits on that conclusion, both worth stating before anyone acts on
it. GitHub aggregates small referrers, so a surface sending one or two
visitors a fortnight can be invisible rather than absent — this rules out
*meaningful* traffic, not *all* traffic. And a directory's real job may be
being found by an agent rather than clicked by a human, which never produces a
referrer at all; `registry.modelcontextprotocol.io` in particular is consumed
by other registries programmatically, and that is why it stays automated.

**What follows from it.** Stop spending runs on new directory submissions —
twelve of them, several paid, have produced no measurable arrivals, and a
thirteenth has no reason to behave differently. Keep the automated ones
(the official registry republishes itself on every release, glama scrapes us
live) because they cost nothing per run. Correcting a *stale* listing is still
worth doing when the copy is wrong about the product, but as accuracy work,
not as growth work. New distribution effort belongs where the arrivals already
are: search and Reddit.

The window is rolling and only 14 days long — nothing older is retrievable
from GitHub. `.github/workflows/ga4-snapshot.yml` therefore copies these
numbers into the daily snapshot on the
[`adoption-data`](https://github.com/nikolai-vysotskyi/trace-mcp/blob/adoption-data/adoption.yml)
branch under `acquisition:`, which is the durable record. Re-read this column
against that history before adding a surface, and update the cell in the same
change that touches one.

### Third-party roundups and comparison articles (TRA-682)

A different surface class from the table above, added 2026-09-02 because the
ledger had no concept of it: searched for `roundup`, `listicle`, `blog`,
`dev.to`, `article`, `builder.io` and `outreach`, zero hits on all seven. It
matters because page one for our category head term ("best MCP server code
intelligence codebase graph 2026") is **entirely** third-party articles — not one
vendor site ranks, which is the normal shape for a query where the searcher
wants a neutral opinion. So the five `/vs/` pages cannot win these queries by
on-page work, however good they get.

| Surface | Listed | Arrivals | What it shows | How to change it | Verified |
|---|---|---|---|---|---|
| [dev.to/coder11](https://dev.to/coder11/code-review-graph-vs-graphify-vs-codebase-memory-mcp-the-best-code-intelligence-mcp-tools-for-ai-3ea) | **No** | None | code-review-graph, Graphify, codebase-memory-mcp, with a language / token-reduction / tool-count matrix | Comments are open and the thread was still live 15 days after publication. Same author and same text as the saurabhsharma.dev row — **one door, not two** | 2026-09-02 |
| [saurabhsharma.dev](https://www.saurabhsharma.dev/blogs/code-graph-mcp-tools-comparison/) | **No** | None | The dev.to piece on the author's own site, published 2026-07-02 | Saurabh Sharma, `github.com/coder0011`, email published on the site. Reachable as a person; there is nothing to submit to | 2026-09-02 |
| [sverklo.com](https://sverklo.com/blog/practical-guide-mcp-code-intelligence/) | **No** | None | "Honest Comparison of 12 Options", May 2026 | **Not a third party — it is a competitor's own blog.** Sverklo is one of the twelve it compares and discloses that outright ("the project that wrote this guide"). Corrections would go to `github.com/sverklo/sverklo` issues. Treat as a competitor page we might be added to out of goodwill, not as an editorial door | 2026-09-02 |
| [chatforest.com](https://chatforest.com/reviews/code-intelligence-codebase-graph-mcp-servers/) | **No** | None | GitNexus, code-review-graph, codebase-memory-mcp, Claude Context, CodeGraphContext, SocratiCode, sverklo, and others down to 18 stars | Self-described "AI-native publication", agent-authored, and it **re-verifies star counts against live GitHub** (published 2026-04-25, re-verified 2026-08-24). No contact form and no submit page, newsletter only; oversight is Rob Nugen. The lever is being discoverable to their next re-verification pass, not pitching anyone. It already lists tools at 18 and 77 stars, so its bar is not adoption | 2026-09-02 |
| [builder.io/blog](https://www.builder.io/blog/best-mcp-servers-2026) | **No** | None | 40+ MCP servers over 11 categories — Context7, GitHub, Figma, Playwright, Stripe. Published 2025-12-10 | **Not our category page.** A general MCP roundup with no code-intelligence section; it ranks for our head term on breadth. Company blog, no correction or suggestion path. Lowest value of the five | 2026-09-02 |

`skillsllm.com` was the sixth URL in that set and is **not** an article at all —
it is an auto-generated directory, we are already in it, and it has moved to the
table above.

**The correction angle does not exist, and that is the finding.** The plan was to
use stale star counts and feature tables as an opening, on the theory that a
factual correction is legitimate where a cold pitch is not. Checked every number
against live GitHub on 2026-09-02: code-review-graph 31.1k, codebase-memory-mcp
41.8k, GitNexus 46.9k, Graphify 113.8k, CodeGraphContext 4.2k. The articles are
not wrong — they are accurate snapshots at their own publication dates, and
chatforest's 2026-08-24 re-check is within a few percent of live. There is
nothing to correct. And **none of the five mentions trace-mcp at all**, so
nothing they say about us is out of date either; the ask is inclusion, which is
a cold pitch, which is the thing the correction angle was meant to avoid.

**What actually gates us, written down so it is not re-derived as an outreach
problem.** Every tool these articles name sits between 4.2k and 113.8k stars.
trace-mcp has 102. Four of the five order or frame by adoption, and no amount of
outreach moves that number. The exception is chatforest, which lists tools at 18
and 77 stars and re-verifies on a schedule — the only one of the five where
inclusion is plausibly a discoverability problem rather than a scale problem, and
also the only one with no human to pitch. That points where the Arrivals column
already points: the lever is being findable by an automated re-crawl, not writing
to people. The skillsllm row above is the same mechanism having already worked.

**`Mnehmos/trace-mcp` is a different project, not a misattribution of ours**
(verified 2026-09-02). `mcprepository.com/mnehmos/trace-mcp` describes a tool
that "detects schema mismatches between data producers and consumers"; it names
nothing of ours and links nothing of ours. The GitHub repo behind it now **404s**
while the account (`Mnehmos`, 65 public repos) is live, so it was renamed or
taken down. Same collision is already recorded in the LobeHub row. Nothing to
correct, but it is the likely source of the `traceix mcp` / `mcp tracing`
impressions-without-clicks, and it means the bare name "Trace MCP" is not ours to
claim on directories.

## macOS code signing and notarization

**Signed and notarized from the first release after 2026-08-29** (TRA-436).
Before that the app was ad-hoc signed (`Signature=adhoc`,
`TeamIdentifier=not set`), so a browser download picked up
`com.apple.quarantine` and Gatekeeper called it damaged — confirmed on
Nikolai's machine. The macOS release now ships a **DMG per architecture** for
humans plus the zip the staged-zip updater consumes, both built from a
Developer ID Application-signed, notarized, stapled `.app`.

**The DMG container is signed and notarized too, from the first release after
2026-09-01** (TRA-627). Through 3.10.0 only the `.app` inside carried a ticket:
`codesign -dvvv` on the published `trace-mcp-3.10.0-arm64.dmg` said "code object
is not signed at all" and `spctl -a -t open` rejected it for "no usable
signature", because electron-builder notarizes in `afterSign` and assembles the
image afterwards. Signing, notarizing and stapling the image is now an explicit
release step, and the release fails if either the app or the container comes out
without a ticket. Do **not** replace that step with `dmg.sign: true` in
`electron-builder.yml`: dmg-builder signs without `--timestamp`, and Apple
refuses to notarize a signature that has no secure timestamp.

Where it lives: `mac:` block in `packages/app/electron-builder.yml`,
entitlements in `packages/app/build/entitlements.mac*.plist` (one comment per
key saying why it is there — keep it that way, an unjustified entitlement list
only grows), signing step in `.github/workflows/release.yml :: build-app-mac`.
Five repository secrets feed it: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. They are Nikolai's to rotate;
no agent handles the certificate material. The workflow runs only on
`push: master` / `workflow_dispatch`, so a fork PR can never reach them.

`latest-mac.yml` **is published** as of TRA-437 (merged 2026-08-30): macOS
updates through `electron-updater` + Squirrel.Mac, and the homegrown staged-zip
updater is deleted. The per-arch clobber that blocked it was solved by building
both architectures in one job rather than a matrix — electron-builder writes one
feed per invocation listing only that invocation's files. Builds up to and
including 3.8.0 are ad-hoc signed and cannot self-update; `postinstall-app.mjs`
swaps those, and only those, once.

**The README and the landing page lead with the DMG** since 2026-08-31
(TRA-440 / TRA-441). `docs/index.html` has a "Download for macOS" button in the
hero that resolves the architecture itself and reads the asset URL from the
GitHub releases API — no version string is written into the page, and without
JavaScript the button falls back to the releases page. `README.md` links that
button instead of naming a zip. The unzip-and-drag instruction and the
`xattr -dr com.apple.quarantine` workaround are **gone on purpose**: now that
builds are notarized, a Gatekeeper warning about trace-mcp means something, and
documentation that teaches people to silence it is worse than no documentation.

**Mac App Store is a closed door**, decided 2026-08-29. Not a backlog item:
the App Store sandbox forbids what this app is for — it spawns `node`/`npm`
and indexes arbitrary directories the user picks, which needs unsandboxed file
access and process execution. Getting through review would mean shipping a
different, less useful product. Developer ID + notarization gives the same
Gatekeeper outcome with none of that. Don't reopen without a concrete reason
this changed on Apple's side.

## The `trace` rename does not touch any surface in this table

Decided 2026-09-02 (TRA-644), full reasoning in [`ops/rename-to-trace.md`](rename-to-trace.md):
**`trace` is the command, `trace-mcp` is the project.** The short name applies
only to things on a developer's own disk — the CLI binary, the MCP server key
in their client config, `~/.trace`. Every surface listed above keeps
`trace-mcp`.

What that means for listings work, so nobody re-opens it:

- **The npm package name is `trace-mcp` permanently.** `trace` on npm is taken
  (`AndreasMadsen/trace`, "Creates super long stack traces", latest 3.2.0,
  published 2024-10-23 — verified 2026-09-02). There is no rename to announce.
- **`server.json` keeps `io.github.nikolai-vysotskyi/trace-mcp`.** It is the
  identity mcp.so, Smithery and PulseMCP ingest, and it republishes on every
  release. Renaming it would buy zero tokens and risk the free pickup the whole
  registry strategy depends on.
- **No rename submissions to any directory.** The count corrections already in
  flight stand; nothing else needs to be re-sent.
- **mcpmarket.com's "Trace" entry is not a defect any more.** It was listed as
  a mismatch to fix; under this decision it is accurate. Do not spend the $29
  paid edit or the support email on it.
- **The repo name, description, topics and `trace-mcp.com` are unchanged.** No
  redirects, no canonical changes, no re-indexing cost. The site has 5 of 13
  pages unindexed already (TRA-350) — there is no index coverage to spend.

The measured case for the whole rename was **0.74–1.23%** of the advertised
tool surface (TRA-613, #720). Anything that would cost this table a listing is
not worth that, and this row exists so the next run does not re-derive it.

## Findings that should not be re-derived

**The official registry was the root cause of everything else** (TRA-352,
2026-08-29). We had never published, so directories scraped whatever they could
reach and drifted. Publishing fixed the class, not just the instance. Two things
blocked publishing and are now fixed in `server.json`: the registry caps
`description` at **100 characters** (ours was 118 — a hard 422), and the npm
package entry needed `registryBaseUrl`.

**"53 framework integrations across 68 languages, 100+ tools"** is an old README
snapshot. It appears on both mcpservers.org and mcpmarket.com, which means those
two cached it years apart from the same source and neither re-crawls. Anywhere
else that string turns up is the same fossil, not a new problem.

**Paid placements have not been bought.** mcp.so $39, mcpmarket $29,
mcpservers.org $39 premium — all declined on 2026-08-29 in favour of waiting for
free registry ingestion. Paid infrastructure is Nikolai's call, not an agent's;
if the free pickup fails, come back with the measured cost of the miss rather
than re-asking the open question.

**GitHub code search is not evidence of absence.** TRA-393's first pass reported
trace-mcp missing from punkpeye/awesome-mcp-servers on the strength of a code
search that returned nothing. It has been listed all along, at README line 1350.
Fetch the raw README and read it — the same mistake TRA-352 made with
mcpmarket.com, made again three hours later by a different run.

**A listing fix ships with the next release, not with the merge.** The 40–50%
wording landed on master on 2026-08-29, but npm still served 3.2.0's "up to 99%
token reduction" and the registry still had 3.1.1/3.2.0 with the old string,
because both are populated by the release workflow. Do not report a directory as
corrected until the release that carries the text is out.

**TRA-263's "165 tools" is stale.** `docs/_data/counts.yml` says 169 and the
README already agreed. TRA-346's "141 schema-carrying tools" answers a different
question and is not a competing count.

**`subinium/awesome-claude-code` has a strict 1,000+ star gate** (verified 2026-09-01).
Do not submit PRs there until trace-mcp meets the 1,000 star requirement.

**`korchasa/awesome-mcp` is an automatically compiled list** (verified 2026-09-01).
Compiles automatically from GitHub `mcp` topic and indexed repositories, so there is
nothing to submit — the repo topics row above is the lever that reaches it.

**A PR that will not open is not always a permissions problem.** GitHub returns
`does not have the correct permissions to execute CreatePullRequest` when the
*target repo is archived*, with no mention of archiving anywhere in the message.
TRA-482 read it as a missing token scope, wrote "needs manual PR creation" and
parked the work on Nikolai for two days; `appcypher/awesome-mcp-servers` had been
archived since 2026-05-06 and nobody could have opened that PR. Check
`gh api repos/<owner>/<repo> --jq .archived` before blaming credentials.

**Competitors' listings are the cheapest source of new addresses.** A code search
for `oraios/serena` across README files returned ~40 repos, and four of them were
real, active lists we were absent from — including `QuesmaOrg/awesome-ai-tokenomics`,
which is the closest fit to our actual claim that has been found so far. Repeat the
search with a competitor's repo path when the known doors run out.

**Nearest neighbours on the token-economics list, worth reading before we quote
our own numbers** (verified 2026-09-01): `yvgude/lean-ctx` (Rust MCP server
mediating agent reads, self-measured 60-90% headline), `rtk-ai/rtk`,
`headroomlabs-ai/headroom`, `mksglu/context-mode`, `fkiene/llmtrim`. The datapoint
that matters: **JetBrains A/B-tested rtk and measured it +7.6% *more* expensive at
low effort against its claimed 60-90% cut.** That list tracks the gap between
claimed and measured, so our "40-50%" is a liability there and
`npx trace-mcp benchmark .` is the asset. PR #53 was written on that basis.

## Channels that need a human

Not blockers to route around — genuinely outside what an agent may do alone:

- **Smithery** — creating the account means authorizing a third-party OAuth app
  against Nikolai's GitHub.
- **LobeHub** — same shape: `lhm login` and `lhm github connect` are both browser
  flows, and their docs state outright that machine credentials cannot publish.
- **Anything paid** — see above.
- Everything else here was self-serve: the mcpservers.org form takes a repo URL
  and an email, the Cline submission is a GitHub issue, and the registry publish
  needs no credential at all in CI.

## Next door to try

**That sentence was true of MCP catalogues, and false of the wider list
ecosystem** (2026-09-01). Two doors an agent can finish were found in one pass by
searching README files for a competitor's repo path (`oraios/serena`) instead of
for MCP directories: `aaif-goose/goose`'s extension directory (issue #11763 open,
PR written and waiting on their Ready gate — TRA-631) and
`QuesmaOrg/awesome-ai-tokenomics` (PR #53 open — TRA-632). Both are plain files
in public repos with no account, payment or attestation anywhere. The exhausted
list was the list of *MCP directories*, not the list of places our audience reads.

The paragraph below still holds for the MCP directories themselves:

Every MCP directory in the table has now been checked at least once, and **none of
the ones we are absent from can be finished by an agent alone.** The previous
revision of this section said Cline could be; that was wrong, and the correction
is the useful part:

**Cline's submission form is an attestation, not a form.** Two of its fields are
required checkboxes — *"I have tested that Cline can successfully set up this
server using only the README.md and/or llms-install.md file"* and *"The server is
stable and ready for public use"*. Nobody has run Cline against our README, so
ticking the first is a false statement, and a listing bought with one is worth
less than no listing. What is verified (2026-08-29): a clean
`npm install -g trace-mcp` into an empty prefix pulls 255 packages without error,
and the installed binary completes an MCP `initialize` handshake over stdio
(`serverInfo: trace-mcp 3.4.0`). That is the substance behind the checkbox minus
the client. What remains is one person opening Cline once, pointing it at the
README, and watching it wire the server up — after that the issue is a two-minute
fill-in, logo included:
`https://raw.githubusercontent.com/nikolai-vysotskyi/trace-mcp/master/docs/icon-400x400.png`.

So the remaining MCP-directory doors sort into: needs a browser login (Smithery,
LobeHub, cursor.directory), needs money (mcp.so, mcpmarket), needs a product
decision (Docker's Dockerfile, the Agent Plugins layout in TRA-634), or needs
someone to witness an install (Cline). Two of them are now one click of Nikolai's
rather than a project: the Cline attestation, and the
`hesreallyhim/awesome-claude-code` form whose 100-star gate we passed on
2026-09-01 (TRA-633).

**Do not run `trace-mcp daemon stop` while testing on a developer machine.** It
does not just stop the daemon — it writes `~/.trace-mcp/daemon.disabled`, which
persistently disables auto-spawn for every later stdio session on that machine,
including the user's own. Undo with `trace-mcp daemon start`. Learned the hard
way while verifying the install above.
