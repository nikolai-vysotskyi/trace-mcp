# Distribution ledger — where trace-mcp is listed, and what we already found out

Every external surface that lists trace-mcp, what it currently shows, and how it
can be changed. Not a public page: `ops/` is outside the Jekyll site in `docs/`.

Every listing here is also a link, and external links are one of the levers on
Google's crawl rate — the one we control most directly. As of 2026-09-04 Google
knows exactly two external referring URLs for trace-mcp.com's homepage, and 11
of 24 pages have no index entry. `ops/index-coverage.md` carries that
measurement and the limits on reading a cause into it.

**Read this before any distribution / directory / listing work. Update it in the
same change that touched a surface.** What the copy on those surfaces is
allowed to claim is a separate decision, in `ops/positioning.md` — read it too
before rewriting a listing's description. Without it every run re-discovers the same
things — that mcp.so dropped free submissions, that PulseMCP submissions are
paused — and either wastes the run or reaches a different conclusion than the
last one did.

Rules for keeping it honest:

- Record what you **verified**, with the date you verified it. "Absent from a
  WebSearch" is not "absent" — TRA-352 called mcpmarket.com missing on that basis
  and it had been listed all along.
- Record the **decisions and the dead ends** too, not just the state. A closed
  door with no reason written down gets pushed on again next month.
- **Editing a surface without adding its row is the failure this file exists to
  prevent.** `claude-code-templates` was submitted in April and refreshed in
  August, both by us, and was still missing here in September (TRA-846). If a
  run touches an external listing at all — submits, corrects, or refreshes it —
  the row lands in the same change, before the run ends.
- Numbers quoted to the outside world come from `docs/_data/counts.yml`
  (169 tools / 81 languages / 87 frameworks as of 2026-08-29). Never hand-type
  them, and re-read the file rather than trusting a number written here: the
  language count moved from 80 to 81 within a day of this ledger being started.

## Surfaces

| Surface | Listed | What it shows | How to change it | Verified |
|---|---|---|---|---|
| [davila7/claude-code-templates](https://github.com/davila7/claude-code-templates) / [aitmpl.com](https://www.aitmpl.com/component/trace-mcp) | **Yes — and it is the largest surface we are on: 30,531★ / 3,459 forks, pushed daily** | `cli-tool/components/mcps/devtools/trace-mcp.json`, mirrored verbatim into `dashboard/public/component-content/mcps/devtools/trace-mcp.json` (same string, wrapped in a `content` field — both must be edited together). Ships `npx -y trace-mcp@latest` and a hand-typed description. **Already stale again**: it says "80 languages", `counts.yml` says 81 — six days after the refresh that was supposed to fix exactly this | **The entry is ours, not a third-party scrape.** Both commits are Nikolai's: [#553](https://github.com/davila7/claude-code-templates/commit/8b18c46f) 2026-04-29 added it, [#844](https://github.com/davila7/claude-code-templates/commit/bb0c681c) 2026-08-29 refreshed the counts. PRs are the route and two have been merged, so the door is open — but see the note below before spending a run on it. It hardcodes the npm name in `args`, so it belongs on the TRA-644 rename checklist; fold the 80→81 fix into that same PR rather than opening one for a digit | 2026-09-05 |
| [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io) | Yes — `io.github.nikolai-vysotskyi/trace-mcp` | Current: 3.15.0, published 2026-09-03, `status: active`, matching npm `latest`. **The `description` it renders was rewritten 2026-09-05 (TRA-883)** and lands with the next release, not with the merge — see the one-liner section below | Automatic: `.github/workflows/publish-mcp-registry.yml` republishes `server.json` on every release (GitHub OIDC, no secret). **This row is now more than one listing.** `modelcontextprotocol/servers` already redirects here, mcp.so and smithery ingest it, and as of 2026-09-02 goose retires its own 59-entry directory in favour of it too. The `description` field in `server.json` is therefore the copy those surfaces render, not just ours — see TRA-761 | 2026-09-04 |
| [glama.ai](https://glama.ai/mcp/servers/nikolai-vysotskyi/trace-mcp) | Yes | Correct — scrapes README/npm live | Nothing to do; fix the README and it follows. Renders 31 links to `trace-mcp.com` and rewrites every one to `rel="ugc nofollow"` — see TRA-792 below | 2026-09-04 |
| [pulsemcp.com](https://www.pulsemcp.com/servers/nikolai-vysotskyi-trace) | Yes | **Stale: "44+ tools"** — their hand-written `server.json`, kept "until the maintainer publishes to the official registry" | Their submissions are **paused**; their own submit page says publishing to the official registry is the fix. Done 2026-08-29 — waiting on their next sync | 2026-08-29 |
| [mcpservers.org](https://mcpservers.org/servers/nikolai-vysotskyi/trace-mcp) | Yes | Body correct; **header stale**: "53 framework integrations across 68 languages, 100+ tools" | Free form at `/submit` (no account, needs a contact email). Correction submitted 2026-08-29, review ≤12h — but it said "80 languages … up to 99% fewer tokens", and master has since moved to 81 languages and (TRA-904, 2026-09-05) to the PR-benchmark headline, so re-submit once it lands. Premium $39 — declined | 2026-08-29 |
| [mcpmarket.com](https://mcpmarket.com/server/trace) | Yes, as **"Trace"** | Same stale "53 frameworks / 68 languages" copy | No self-serve edit. $29 paid listing, or email support@mcpmarket.com. Free queue re-submit answers "already listed" | 2026-08-29 |
| [mcp.so](https://mcp.so) | **No** | — | **Free submission no longer exists** — `/submit` offers only "Pay and submit automatically", $39. They ingest the official registry, so expect a free pickup | 2026-08-29 |
| [smithery.ai](https://smithery.ai) | **No** | — | Two blockers, not one: the account needs GitHub OAuth (an agent must not authorize that on Nikolai's behalf), **and** a stdio server is published as an MCPB bundle — `smithery mcp publish ./server.mcpb -n <org>/<name>`, per `smithery.ai/docs/build/publish.md`. There is **no `smithery.yaml`** in their current docs; older writeups describing one are stale. They also ingest the official registry | 2026-08-29 |
| [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) | **Yes** | Listed under `Developer Tools`, alphabetical, with the Glama badge and an accurate description | PR to README. Their CONTRIBUTING asks automated agents to append `🤖🤖🤖` to the PR title. Nothing to submit — only re-read the entry when the product's shape changes | 2026-09-01 |
| [hashgraph-online/awesome-ai-plugins](https://github.com/hashgraph-online/awesome-ai-plugins) | **Yes** | Listed under `Community Plugins → Development & Workflow` | PR to README. PR #182 merged 2026-08-31 by `kantorcodes` without requiring third-party scanner action | 2026-09-01 |
| [aaif-goose/goose](https://github.com/aaif-goose/goose) extension directory | **No — refused, and the directory itself is retired** | — | [Issue #11763](https://github.com/aaif-goose/goose/issues/11763) was **closed** 2026-09-02 by `alexhancock` (collaborator): "We aren't taking new submissions for the extensions directory." The reason is not about us — [discussion #10830](https://github.com/aaif-goose/goose/discussions/10830) retires goose's own registry in favour of the official MCP registry and the `server.json` format: "New contributions to the goose registry are halted. Please don't open PRs adding servers; we won't be merging them." The finished branch `nikolai-vysotskyi/goose:add-trace-mcp` was therefore **never opened as a PR** — the issues-first hold in the previous version of this row is what kept us from opening a PR into a closed door. **Do not re-submit and do not push back.** goose says the registry entry will appear in their doc pages automatically once their `server.json` support lands, and we are already in that registry (row above), so this door is covered without further work | 2026-09-04 |
| [QuesmaOrg/awesome-ai-tokenomics](https://github.com/QuesmaOrg/awesome-ai-tokenomics) | **Yes** — merged 2026-09-04 | Line 112 of the README, Optimize → Context Engineering, plus the same line in `research/optimize.md` | [PR #53](https://github.com/QuesmaOrg/awesome-ai-tokenomics/pull/53) approved and merged by `bkotrys` (165★ list) after two rounds. **Two corrections came out of his review and both hold outside this listing.** (1) He read `src/analytics/benchmark.ts` and called the entry's "prints per-task token cost with and without the index" a measured claim the code does not support: both sides come from `estimateTokens()` over character counts and the trace-mcp side is a hardcoded fraction per scenario (0.05–0.45). The clause was dropped, not qualified. Do not describe that command as a measurement anywhere else either. (2) **Stop citing npm downloads.** ~40/day through July and most of August, then 1,300–2,000/day on Aug 27–30 — the same four days we published 31 releases. That is mirrors and CI. What convinced him instead was the issue tracker: 15 distinct external accounts filing behavioural reports. Entry format for reference: README line + `research/optimize.md` + a `research/manifest.json` record with `verified_on` / `stale_after`; their `scripts/lint_readme.sh` fails the build on any em-dash in tracked markdown and on a superlative list (`de facto`, `go-to`, `widely used`, `the leading`, …). Self-submission is allowed but needs a disclosure, checkable primary sources, and an independent adoption signal that is not stars | 2026-09-04 |
| [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) | **No** | — | **Gate met, door still human-only.** Their bar is ≥100 stars *or* 14 days of active development; we passed the star half on 2026-09-01 (102). But CONTRIBUTING is explicit: "ALL RECOMMENDATIONS MUST BE MADE USING THE WEB UI ISSUE FORM TEMPLATE, OR YOU RISK BEING RESTRICTED FROM INTERACTING WITH THIS REPOSITORY", "It is **not** possible to submit a resource recommendation using the `gh` CLI", and "recommendations must be created by human beings". Three of the form's required checkboxes are personal attestations. An agent must not fill this in; the ready-to-paste field values are in TRA-633 | 2026-09-01 |
| [hashgraph-online/awesome-codex-plugins](https://github.com/hashgraph-online/awesome-codex-plugins) | **No — declined by us** | — | Same org that merged us into `awesome-ai-plugins`, and we do ship a Codex plugin, so this looks like the obvious next door. It is not. There the scanner action was *advisory* and we were merged without it; here CONTRIBUTING step 1 is "Set up scanner CI in your plugin repo (required) … This is not optional. We verify this during review" — `hashgraph-online/ai-plugin-scanner-action@v1` committed into our workflows, plus `pipx install plugin-scanner` run locally. Both are the thing we already refused. **Closed unless their gate changes** | 2026-09-01 |
| [cursor.directory](https://cursor.directory) (`pontusab/directories`) | **No** | — | Repo holds no listing data ("All content is submitted through the website"); submission is `cursor.directory/plugins/new` behind GitHub or Google sign-in, so it is human-only like Smithery. Worth knowing anyway: they auto-detect components from a repo following the [Open Plugins](https://open-plugins.com) spec, and the MCP hook is a **`.mcp.json` at the repo root**. Ours lived only at `.claude-plugin/.mcp.json`. **2026-09-02 (TRA-634):** repo root now carries `plugin.json` + `mcp.json` per the Agent Plugins v1.0.0 spec, re-read at source that day (`agent-plugins.org/plugin-builders/specification`: manifest at `plugin.json`, MCP config at `mcp.json`, both at plugin root); `skills/*/SKILL.md` already matched. **Not verified that Cursor's scanner accepts it** — the only way to check is to feed it the repo through the logged-in form, and their own README still names a dotted `.mcp.json` and no `plugin.json`, so spec and scanner may disagree. We did not add a root `.mcp.json`: Claude Code reads that path as project-scoped MCP config, so it would change behaviour for anyone who clones the repo. Next step is Nikolai submitting, then reading back what the scanner detected | 2026-09-02 |
| [appcypher/awesome-mcp-servers](https://github.com/appcypher/awesome-mcp-servers) | **No — dead** | — | **The repo is archived** (last push 2026-05-06; 5,764 stars). GitHub refuses pull requests against an archived repo, which is what "does not have the correct permissions to execute `CreatePullRequest`" actually means — TRA-482 read that error as a token-scope problem and parked the submission on Nikolai. It was never his to unblock. The prepared fork branch `nikolai-vysotskyi/awesome-mcp-servers-appcypher:add-trace-mcp` is dead weight | 2026-09-01 |
| [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | — | — | **Not a door any more.** The README is now reference servers only and says so in a banner: "If you are looking for a list of MCP servers, you can browse published servers on the MCP Registry." No community-servers section survives to be added to. We are in the registry it points at, so this is already covered | 2026-09-01 |
| [wong2/awesome-mcp-servers](https://github.com/wong2/awesome-mcp-servers) | **No** | — | **Not a separate door.** Its README refuses PRs outright and redirects to `mcpservers.org/submit` — the same form as the mcpservers.org row above. Treat the two as one channel | 2026-08-29 |
| [Cline MCP Marketplace](https://github.com/cline/mcp-marketplace) | **No** — checked their live catalog API (`api.cline.bot/v1/mcp/marketplace`, 199 entries), not a web search | — | Closest thing to an open door left. Open an issue on `cline/mcp-marketplace` with their `mcp-server-submission` template: repo URL, a **400×400 PNG** logo, reason for addition. `llms-install.md` is optional — their FAQ says a well-written README is usually enough (there is no crawler; Cline itself reads the README at install time). Their step 3 also asks the submitter to confirm they have watched Cline set the server up from the README alone. The logo is now in-repo at `docs/icon-400x400.png`. No account or payment — but that step-3 checkbox is **required**, so this is not an agent-alone submission; see "Next door to try" | 2026-08-29 |
| [Docker MCP Catalog](https://github.com/docker/mcp-registry) | **No** — listed all 328 entries of `servers/` via the GitHub contents API | — | **Blocked on an artifact we don't have.** Both paths need something trace-mcp isn't: "Local" wants a Dockerfile in our repo, "Remote" wants a reachable streamable-http/SSE endpoint. A plain npm/stdio package qualifies for neither. Adding a Dockerfile is a product decision, not a listings one — don't smuggle it in as distribution work | 2026-08-29 |
| Continue.dev Hub | — | — | **Dead product, not a gap.** Continue was acquired by Cursor (June 2026), the final release shipped 2026-06-19, cloud data was deleted after 2026-07-15, `hub.continue.dev` no longer resolves. The GitHub repo is **not** archived and is still public — do not describe it as read-only — but it has shipped nothing since (last commit 2026-07-21). Re-check only if Cursor stands a successor up | 2026-08-29 |
| [LobeHub](https://lobehub.com/mcp) | **No** — the `trace-mcp` listing there is `Mnehmos/trace-mcp`, an unrelated project with the same name | — | Publishing is `npx @lobehub/market-cli`, and it requires `lhm login` (browser OIDC) plus `lhm github connect` (browser ownership check). There is no token-only path: verified in `@lobehub/market-cli@0.0.41` itself, because their docs pages under `lobehub.com/docs/market/*` are content-free stubs. `plugin publish` and `plugin claim` both go through `createUserSDK()`, which aborts with "Not logged in. Run `lhm login` first" unless a user OAuth token is on disk; the `MARKET_CLIENT_ID`/`MARKET_CLIENT_SECRET` env pair is never used for publishing. Human-only, like Smithery | 2026-08-29 |
| [skillsllm.com](https://skillsllm.com/skill/trace-mcp) | **Yes** — found while checking it as a "roundup" (see below); it is a directory, and we were already in it | Accurate and live: 177 tools / 81 languages / 102 stars, matching `docs/_data/counts.yml` on the day it was read. Passed their Semgrep + dependency scan | Nothing to submit. Their `/about` says a scraper "searches GitHub daily for repositories containing SKILL.md files or tagged with relevant topics like `claude-code`, `ai-agent`, `mcp-server`" — we carry all three, so the topics row below is what put us here and what keeps the numbers current. A `/submit` form and a paid "Featured Listing" also exist; neither is needed | 2026-09-02 |
| `trace-mcp.vi.softonic.com/mcp` | **Yes — scraped, not submitted** | Unknown — all of `*.softonic.com` answers HTTP 412 to a scripted fetch (four UA/header variants, 2026-09-04) | **Nothing to do, and do not open this door.** Found because Search Console names it as one of exactly two external URLs linking `trace-mcp.com` (TRA-792). A download portal that wraps third-party installers in its own; we control nothing on that page. Do not submit, do not link, do not chase the other locales | 2026-09-04 |
| GitHub repo topics | **Yes** — always on, the surface is ours | **20 of 20 slots used** — the cap. Changed 2026-08-30: dropped `token` and `tokens` (3,892 / 1,572 repos, almost all auth or crypto — wrong audience for a word we only meant one way) and `claude-skill` (near-duplicate of `claude-skills`, which is the bigger of the two: 7,662 vs 4,841); added `code-graph` (208 repos), `dependency-graph` (901) and `static-analysis` (8,072) | The one listing surface we own outright: `gh api -X PUT repos/:r/topics --input <json>`, instant, reversible, no review. Topic pages are a browse surface, so a *small* exact topic like `code-graph` is worth more than a big vague one. Sizes via `gh api "search/repositories?q=topic:<t>&per_page=1" --jq .total_count`. Before rebalancing again: 7 of the 20 slots are `claude-*` variants (8 before this change), which is defensible but is where the next slot comes from; `rag` (43,793) is the other weak slot — we retrieve, but we are not a RAG pipeline | 2026-08-30 |
| GitHub repo description | **Yes** — always on, the surface is ours, and it is **the string the auto-indexes copy verbatim** | Was "MCP server for Claude Code and Codex. One tool call replaces ~42 minutes of agent exploration" until 2026-09-05. Now: "Framework-aware code intelligence MCP server for Claude Code and Codex — 90.6% fewer input tokens to review a pull request, median over 60 merged PRs in repos we don't own. 81 languages, 87 frameworks, 100% local." | `gh api -X PATCH repos/:r -f description=...`, instant, reversible, no review — same class as topics. Keep it in step with `package.json` `description` and `server.json` `description`; all three now quote the PR-benchmark figure and none may quote a number that is not in `docs/_data/` | 2026-09-05 |
| [Chat2AnyLLM/awesome-claude-plugins](https://github.com/Chat2AnyLLM/awesome-claude-plugins) | **Yes — never submitted** (115★) | README line 1339, in a machine-generated table of scanned Claude plugin repos: our repo, branch `master`, `.claude-plugin` detected, status ✅ ok | Nothing to submit — it scans repos carrying a `.claude-plugin` directory. Found by code search 2026-09-05, not by a directory hunt | 2026-09-05 |
| [linny006/mcp-servers-live](https://github.com/linny006/mcp-servers-live) + [its Pages site](https://linny006.github.io/mcp-servers-live/r/nikolai-vysotskyi/trace-mcp/) | **Yes — never submitted** | Auto-index of MCP servers refreshed every 15 minutes; we are #49 by stars with a per-repo page. Its whole body is our GitHub description, repeated 5× on that page | Nothing to submit. Links only `github.com`, never `trace-mcp.com`, so it adds nothing to the domain count below. Its value is that it demonstrates the description-propagation above | 2026-09-05 |
| [linny006/trending-claude-skills](https://github.com/linny006/trending-claude-skills) | **Yes — never submitted** | Trending table, **rank 3**, 133★, same auto-copied description | Same scraper family as the row above; one operator, two indexes. Nothing to submit | 2026-09-05 |

The repo's own `description` and `homepage` are part of that surface and were
left alone — the description already leads with the clients and a concrete
number, which is what a GitHub search result needs.

Community channels (Hacker News, Reddit) are not in this table because they are
not listings — nothing there is maintained, only posted once. The drafts and the
channel-by-channel read of what the outside world says about us moved to the
private repo on 2026-09-05: `ops/launch-hn.md`, `ops/launch-reddit.md` and
`ops/user-signal.md` in
[`trace-mcp-private`](https://github.com/nikolai-vysotskyi/trace-mcp-private).
Posting any of it is Nikolai's call, and as of 2026-09-05 Reddit is
deprioritised — read `user-signal.md` there before assuming otherwise.

### Did any of this send anyone — moved out of this repo (2026-09-05)

The Arrivals column and the referrer readings behind it now live in the private
[`trace-mcp-private`](https://github.com/nikolai-vysotskyi/trace-mcp-private)
repo, `ops/arrivals.md`.

The split is deliberate and the line is drawn on content, not on topic. **Which
directories carry trace-mcp and how to submit to them stays here** — it is
enumerable by anyone who opens those directories, it reads as documentation, and
keeping it public is what lets a run read this file without a second checkout.
**What that effort actually produced does not**: it is a negative result, it is
the part with real competitive value, and it says something about our numbers
that we do not owe anyone.

So the surface table above still answers "are we listed, is the copy stale, how
do I fix it". It no longer answers "did it work". For that, and before spending
a run on any new listing, read `ops/arrivals.md` in the private repo — the
conclusion there has held across four independent 14-day windows and it should
change how you value a submission.


### Does the listing actually link the site — external domains linking trace-mcp.com (TRA-792)

**Tracked figure: 2 distinct external domains link `trace-mcp.com` (baseline 2026-09-04).**
Measured by the SEO agent with the Search Console URL Inspection API over all 24
sitemap URLs: the only referring URLs Google knows for the homepage are
`trace-mcp.vi.softonic.com` and `mcpmarket.com`; every other indexed page's only
referrer is our own `sitemap.xml`. Eleven of the 24 pages have no index entry at
all. Full per-URL table in [`ops/index-coverage.md`](index-coverage.md).

Re-read it the same way when this row is next touched, and record the domain
count here — it is the figure that says whether listings work does anything for
the site, the way the arrivals reading says whether it does anything for the repo.

**What the listings emit, read from their served HTML on 2026-09-04.** Nobody had
checked; the answer is that the ones we can read pass nothing.

**Decision 2026-09-05 (TRA-905): do not chase deep-URL links through these
surfaces.** The question was whether the `/vs/` cluster and
`/pr-context-benchmark.html` should be pushed into the listings instead of only
the homepage. There is nothing to win: the surfaces we can read emit either no
`trace-mcp.com` link at all or `rel="ugc nofollow"` on every one, and GitHub
adds `nofollow` to external links in the awesome-list READMEs too — so no
dofollow deep link exists in this channel set to go and get. The free lever
instead is our own README, which glama scrapes live for all 31 of its anchors;
it gained a head-to-head line linking the six `/vs/` pages the same day.
Rationale and the 2026-09-26 re-read in [`ops/index-coverage.md`](index-coverage.md).

| Surface | Links `trace-mcp.com`? | `rel` | Read how |
|---|---|---|---|
| glama.ai | Yes — **31 anchors**, deep pages included (`/comparisons.html`, `/configuration.html#cli`, `/supported-frameworks.html`) | `ugc nofollow` on every one | Fetched the page, parsed the anchors |
| mcpservers.org | **No.** It renders our README but rewrites the doc links to `github.com/.../blob/HEAD/…`; the string `trace-mcp.com` appears zero times | GitHub links are `nofollow noopener noreferrer` | Same |
| skillsllm.com | **No.** Three outbound links, all `github.com` | `noopener noreferrer` | Same |
| pulsemcp.com (403), mcpmarket.com (429), softonic (412) | **Unknown — bot-blocked from a run** | — | Four UA/header variants, all refused |

So of the surfaces readable at all, glama is the only one that names the domain,
and it nofollows all 31. That settles ask 2 for three of the ~10 listings: link
equity is not what these are for. The two Google *does* know about are a scraped
mirror and a listing we cannot read — neither is a submission we could repeat.

**The one lever this leaves, and it is now pulled.** `server.json` had no
`websiteUrl`, and `package.json` had no `homepage` — the two places in the repo
that hand a directory the site URL *as data* rather than as prose it may or may
not rewrite. Both now carry `https://trace-mcp.com`, guarded by
`tests/plugin/manifest-sync.test.ts`. `websiteUrl` is in the published
`ServerDetail` schema (`format: uri`, optional) and republishes to the official
registry on every release, which is what mcp.so, Smithery, PulseMCP and goose's
retired directory ingest — so it reaches more surfaces than any single
submission would, at zero cost per run. By the rule further down this file, it
lands on those surfaces **with the next release, not with the merge**.

Ask 3 (point listings at `/comparisons.html` rather than `/`) has no target
today: `websiteUrl` and npm `homepage` both mean the project's front door, and
the surfaces that do render deep links — glama — take them from the README
automatically and nofollow them anyway. Revisit if a submission form ever offers
a free-text URL field.

**Softonic is a mirror we did not submit to.** `trace-mcp.vi.softonic.com/mcp`
is one of the two external URLs Google attributes to us and was absent from this
ledger. It is a scraped download-portal page on a Vietnamese locale subdomain;
all of `*.softonic.com` returns HTTP 412 to a scripted fetch, so its contents
cannot be verified from a run. Recorded because it exists and because a future
run will otherwise treat it as a door worth opening — it is not one. Softonic
wraps third-party downloads in its own installer, and we have no control over
what that page offers. Do not submit anything there, and do not link it.

### Third-party roundups and comparison articles (TRA-682)

A different surface class from the table above, added 2026-09-02 because the
ledger had no concept of it: searched for `roundup`, `listicle`, `blog`,
`dev.to`, `article`, `builder.io` and `outreach`, zero hits on all seven. It
matters because page one for our category head term ("best MCP server code
intelligence codebase graph 2026") is **entirely** third-party articles — not one
vendor site ranks, which is the normal shape for a query where the searcher
wants a neutral opinion. So the five `/vs/` pages cannot win these queries by
on-page work, however good they get.

| Surface | Listed | What it shows | How to change it | Verified |
|---|---|---|---|---|
| [dev.to/coder11](https://dev.to/coder11/code-review-graph-vs-graphify-vs-codebase-memory-mcp-the-best-code-intelligence-mcp-tools-for-ai-3ea) | **No** | code-review-graph, Graphify, codebase-memory-mcp, with a language / token-reduction / tool-count matrix | Comments are open and the thread was still live 15 days after publication. Same author and same text as the saurabhsharma.dev row — **one door, not two** | 2026-09-02 |
| [saurabhsharma.dev](https://www.saurabhsharma.dev/blogs/code-graph-mcp-tools-comparison/) | **No** | The dev.to piece on the author's own site, published 2026-07-02 | The author is reachable directly — contact details are published on the site itself. There is nothing to submit to | 2026-09-02 |
| [sverklo.com](https://sverklo.com/blog/practical-guide-mcp-code-intelligence/) | **No** | "Honest Comparison of 12 Options", May 2026 | **Not a third party — it is a competitor's own blog.** Sverklo is one of the twelve it compares and discloses that outright ("the project that wrote this guide"). Corrections would go to `github.com/sverklo/sverklo` issues. Treat as a competitor page we might be added to out of goodwill, not as an editorial door | 2026-09-02 |
| [chatforest.com](https://chatforest.com/reviews/code-intelligence-codebase-graph-mcp-servers/) | **No** | GitNexus, code-review-graph, codebase-memory-mcp, Claude Context, CodeGraphContext, SocratiCode, sverklo, and others down to 18 stars | Self-described "AI-native publication", agent-authored, and it **re-verifies star counts against live GitHub** (published 2026-04-25, re-verified 2026-08-24). No contact form and no submit page, newsletter only; agent-authored with named human editorial oversight. The lever is being discoverable to their next re-verification pass, not pitching anyone. It already lists tools at 18 and 77 stars, so its bar is not adoption | 2026-09-02 |
| [builder.io/blog](https://www.builder.io/blog/best-mcp-servers-2026) | **No** | 40+ MCP servers over 11 categories — Context7, GitHub, Figma, Playwright, Stripe. Published 2025-12-10 | **Not our category page.** A general MCP roundup with no code-intelligence section; it ranks for our head term on breadth. Company blog, no correction or suggestion path. Lowest value of the five | 2026-09-02 |
| [mattbutlerengineering/ai-tooling](https://github.com/mattbutlerengineering/ai-tooling/blob/main/evaluations/trace-mcp.md) | **Yes** — evaluated, verdict `discovery-log — tentative read` | A 2026-06-22 hands-off source review of v1.43.1. Credits the framework-aware cross-language edges as the real differentiator over codegraph, but blocks on the unverified "~42 minutes" headline, scope sprawl, small adoption and the strict guard hook. Also states **"no telemetry"** twice — in the What-worked bullet and in the Safety row — which stopped being true at v1.47.0 | Corrections go in issues; the maintainer runs the catalog from daily `scan:` issues. We filed [#585](https://github.com/mattbutlerengineering/ai-tooling/issues/585) on 2026-09-04 correcting the telemetry claim and pointing at the PR-context benchmark, which is the hands-on re-evaluation trigger the eval itself named. One message, no verdict ask — **do not follow up** (TRA-857) | 2026-09-04 |

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
also the only one with no human to pitch. That points where the arrivals reading
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

**The in-body number changed again on 2026-09-05 (TRA-904).** The "40–50% fewer
tokens on average" that appears in `server.json`'s description, in listing bodies
and in older submission forms is gone from master. It was not a measurement, and
the replacement is 29.3% over 17,847 measured calls (`docs/_data/response_tokens.json`,
generated by `scripts/gen-response-tokens-data.ts`, guarded by
`tests/docs/savings-claims.test.ts`). `server.json` now carries the PR-benchmark
figure instead, so the registry entry changes at the next release by the rule
above. When re-submitting anywhere: quote 90.6% (PR context, other people's repos)
or 29.3% with its two caveats — one machine's call mix, and a baseline that is
still an estimate — and never the old range. Row-by-row re-submission is not
urgent; the correction lands wherever a listing scrapes live, and the rest can
ride the next planned correction of that row.

**The headline number a listing scrapes changed on 2026-09-02 (TRA-647).** The
README's above-the-fold claim is no longer "40–50% fewer tokens on average" — it
is the PR-context benchmark, "90.6% fewer input tokens", measured on 60 merged
pull requests in six repositories we do not own, with a link to the method page.
Every listing that scrapes the README or the npm page live — glama.ai above, and
any other in this table whose "how it can be changed" column says the same —
will pick that up **at the next release**, not at the merge, by the rule in the
paragraph above. Two consequences for a future run: do not "correct" a directory
that still shows the old wording before the carrying release is published, and
do not hand-type the number into a submission form. It is generated into
`docs/_data/pr_context_bench.json` by `scripts/bench-pr-context.ts` and guarded
by `tests/docs/readme-claims.test.ts` — same discipline as
`docs/_data/counts.yml`.

**The one-liner every directory renders was still on our weakest number, six
days after the strongest one landed** (TRA-883, 2026-09-05). README and the
homepage moved to the PR-context benchmark on 2026-09-02 — 90.6% fewer input
tokens to review a pull request, median over 60 merged PRs in six repositories
we do not own. `server.json`, `package.json` and `plugin.json` still said
"40–50% fewer tokens on average", our own aggregate over our own usage. That is
backwards for the surface it is on: the README is read by people who then read
the rest of the README, while these three strings are rendered verbatim by
every registry that ingests us and by npm, with no room to qualify anything.
The tokenomics review (PR #53 above) made the same point from the outside —
what convinced that maintainer was evidence we did not produce ourselves.

All three now lead with the measured number. Two things worth keeping:

- **The honesty guard was blocking it.** `tests/plugin/manifest-sync.test.ts`
  refused any `9x%` + tokens claim on the install surfaces (TRA-393, when they
  advertised "up to 99% token reduction"). 90.6% is not that: it is a median,
  not a peak, and it is measured off our own machines. The guard now admits a
  `9x%` claim **only** when the number equals `median_savings_pct` in
  `docs/_data/pr_context_bench.json` and the surrounding text names what was
  measured; a bare "90.6% fewer tokens" still fails. Do not widen it further.
- **The number is pinned to the data file**, so regenerating the benchmark
  fails CI with the number to write, the same discipline `counts.yml` gets.
  Never hand-type it into a submission form either.

`server.json` is capped at 100 characters by the registry schema, so its version
is compressed to "Framework-aware code graph: 81 languages, 87 frameworks, 90.6%
less PR context (60-PR benchmark)" (96). The method lives at `websiteUrl`.

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
claimed and measured, so our "40-50%" was a liability there — and on 2026-09-05
(TRA-904) we retired it. It was never measured: the counter behind it scored each
call before the tool ran, `RAW_COST_ESTIMATES[tool] x 0.15`, a constant. The
replacement is 29.3%, measured on 17,847 real calls with the responses counted on
the wire, published beside the four tools that cost *more* than they replace.
`npx trace-mcp benchmark .` remains the asset; the correction itself is now a
second one, and it is the only honest-measurement position on that list.

## Channels that need a human

Not blockers to route around — genuinely outside what an agent may do alone:

- **Smithery** — creating the account means authorizing a third-party OAuth app
  against Nikolai's GitHub.
- **LobeHub** — same shape: `lhm login` and `lhm github connect` are both browser
  flows, and their docs state outright that machine credentials cannot publish.
- **cursor.directory / Agent Plugins** — the submission form at `cursor.directory/plugins/new`
  requires GitHub or Google OAuth login. Pasting the repo URL is the whole
  submission; whether their scanner picks up our root `plugin.json` / `mcp.json`
  is unverified until someone submits and reads back what it found.
- **Anything paid** — see above.
- Everything else here was self-serve: the mcpservers.org form takes a repo URL
  and an email, the Cline submission is a GitHub issue, and the registry publish
  needs no credential at all in CI.

## Sweeping GitHub code search for mentions we did not make (2026-09-05)

Recorded as a **source with a method**, not as a surface, because it is how the
other rows get found. It has now produced a first: `mattbutlerengineering/ai-tooling`,
the only third-party evaluation of trace-mcp anyone has written, was found this
way (TRA-845) and not in any directory.

Run it once per distribution run. Four queries, `gh search code`, dedupe by repo:

```
gh search code 'trace-mcp'                  --limit 100 --json repository --jq '.[].repository.nameWithOwner' | sort | uniq -c | sort -rn
gh search code 'nikolai-vysotskyi/trace-mcp' --limit 100 ...
gh search code 'trace-mcp.com'               --limit 100 ...
gh search code '"npx -y trace-mcp"'          --limit 100 ...
```

Two things about reading the output, both learned on the first run:

- **The bare `trace-mcp` query is mostly name collisions.** `btraceio/btrace`,
  `oisee/odata_mcp`, `korwabs/playwright-trace-mcp`, `imj01y/trace-ui`,
  `aleutian-ai/AleutianFOSS` (a Go `cmd/trace-mcp` binary) and
  `g-shevchenko/mcp-token-savers` (its own `agent-trace-mcp` service, 11 hits)
  are all somebody else. `nikolai-vysotskyi/trace-mcp` is the query that only
  matches us. Open the file before recording anything — the same discipline the
  "code search is not evidence of absence" note above asks for, in the other
  direction.
- **The code-search quota is 10 requests/minute, separate from the 5,000/hour
  core quota, and it is easy to burn.** Read the matched files over
  `raw.githubusercontent.com` instead of `gh api search/code` per repo.

**Result of the first run: three surfaces carrying trace-mcp that this ledger
had never heard of**, all three rows above, none submitted to, all three
automatic. That matches what the arrivals reading already says — the mechanism
that puts us on surfaces is being findable by a crawler, not filing forms.

### And the finding that came out of it: the repo description was the last home of "~42 minutes"

The scrapers do not paraphrase. `linny006.github.io` repeats our GitHub
description five times on one page; `trending-claude-skills` and every GitHub
search result carry the same string. Until 2026-09-05 that string was "One tool
call replaces ~42 minutes of agent exploration" — a number that appears **nowhere
in this repository**, that `mattbutlerengineering/ai-tooling` named as one of the
reasons its evaluation stopped at `tentative read`, and that is the same class of
unsupported claim as the "40–50% fewer tokens" retired the same day (TRA-904).
README, npm `description` and `server.json` had all already moved to the measured
PR-benchmark figure; the repo description was missed because it is not a file and
no test can read it.

Changed to the PR-benchmark wording (row above). Nothing to re-submit anywhere:
every surface that carries it re-reads it on its own schedule.

**The guard this leaves open.** `tests/docs/readme-claims.test.ts` and
`savings-claims.test.ts` guard files. The two surfaces we own that are *not*
files — the repo description and the repo topics — are guarded by nothing, and
this is the second time one of them drifted unnoticed. Whoever next touches the
claims gate should decide whether it is worth a network read in CI; until then,
re-read both in every distribution run.

**Adoption number for anyone quoting it: 133★ on 2026-09-05** (the ledger's last
figure was 102 on 2026-09-01). Both awesome-list star gates recorded above —
`hesreallyhim` at 100 and `subinium` at 1,000 — should be re-read against this,
not against 102.

## Next door to try

**That sentence was true of MCP catalogues, and false of the wider list
ecosystem** (2026-09-01). Two doors an agent can finish were found in one pass by
searching README files for a competitor's repo path (`oraios/serena`) instead of
for MCP directories: `aaif-goose/goose`'s extension directory and
`QuesmaOrg/awesome-ai-tokenomics`. Both are plain files in public repos with no
account, payment or attestation anywhere. The exhausted list was the list of
*MCP directories*, not the list of places our audience reads.

**Outcome of those two, 2026-09-04.** One in, one closed: the tokenomics PR
merged (row above, TRA-632), goose closed its directory to all new submissions
(row above, TRA-631). That is the realistic hit rate for the method, and the
merged one took two review rounds in which the maintainer read our source and
found a claim we could not support. Repeat the search — READMEs naming a
competitor's repo path — rather than searching for directories; but read
`ops/arrivals.md` in the private repo first, and let what it says about this
class of surface decide whether the search is worth a run at all.

### A door class this ledger did not have: someone else's backend slot (2026-09-04)

Same search method, different reading of the results. Several of the READMEs
that name `oraios/serena` are not lists at all — they are tools that *install* a
code-navigation MCP server on the user's behalf, which makes them distribution
without a listing: the user never chooses us, the wrapper does.

**[`headroomlabs-ai/headroom`](https://github.com/headroomlabs-ai/headroom)**
(68.9k★, pushed daily) is the developed case and has **two** such slots:

- `--code-memory` — a `click.Choice` in `headroom/cli/wrap.py`
  (`_VALID_CODE_MEMORY`) whose only real member is `serena`, installed by
  default when you run `headroom wrap` and registered at user scope in
  `~/.claude.json`.
- `--code-graph` — currently hard-wired to `DeusData/codebase-memory-mcp`.
  [Issue #1009](https://github.com/headroomlabs-ai/headroom/issues/1009) asks
  for that to become pluggable and names `codegraph` as the second candidate.
  Open since 2026-06-15, labelled `Low`, **zero comments** until ours on
  2026-09-04, which is where we made the case for the interface, added the
  criterion their table was missing (tool-schema count, the one thing a
  compression proxy cannot fix downstream) and offered to write the adapter.
  Tracked in TRA-853.

Why this class is worth more than a directory row: it ends in an install, not a
link, so the arrivals objection above does not apply to it. Cost is higher —
it is code and a maintainer's review, not a README line — and the outcome is
theirs to decide.

Two more of the same shape, unexplored, for the next run: `Mibayy/token-savior`
(1.1k★) publishes a compatibility matrix with a per-tool row telling users how
to configure it *alongside* each navigator, so inclusion there is functional
rather than promotional; and `gglucass/headroom-desktop` (535★) ships the same
opt-in add-on table as headroom itself and is likely one door with it, not two.

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

### The other two of that shape, resolved (2026-09-05)

Both were named above as unexplored. Neither turned into an outgoing message,
and the reasons are worth keeping so the next run does not re-open them.

**`gglucass/headroom-desktop` (535★) is the same door as headroom, and the same
person.** It does ship the class: a "Bundled tools" table where `serena`,
`codebase-memory-mcp` and `context7` are one-click opt-in add-ons, plus a stated
inclusion policy pointing at `research/tool-compatibility-matrix.md`. That
policy file is stale against the app it governs — it says Python-runtime-only
and "reject candidates that require profile mutation", while the shipped table
includes `rtk` (Rust binary plus a Claude Code hook) and `context7` (Node), and
the app writes its own fenced block into the user's shell profile. That gap is a
real opening for a disclosure-first issue. It is on hold anyway: the two repos
share a maintainer with our open 2026-09-04 comment on headroom #1009, so
writing into the second one the day after is the "do not write again to someone
who has not answered" rule in substance if not in letter. Revisit when #1009
moves, or after the two-week reminder window. The reasoning that identifies the
overlap is in `ops/arrivals.md` in the private repo — it names a person, so it
does not belong here.

**`Mibayy/token-savior` (1.1k★) is a competitor, not a door.** Its "How it
composes with adjacent tools" table is not a list of recommended navigators; it
tells the reader which half of Token Savior to switch off when a neighbouring
tool already covers that layer. It ships `find_symbol`, `get_change_impact` and
`find_dead_code` under those names and a `compact-only` profile that advertises
a single tool. Our overlap with it is close to total, so the honest row for us
would read "pick one", which buys nobody anything and costs a maintainer a
review. Dropped. Keep it on the competitor list instead: it is the only one we
have seen ship a one-tool profile.

### Someone else measured the category and it lost (2026-09-05)

`narumiruna/pi-extensions` (505★, pushed daily) is a Pi Coding Agent extension
monorepo. On 2026-08-30 it deprecated `@narumitw/pi-cbmem`, an extension that ran
`codebase-memory-mcp` behind a persistent MCP stdio session and registered 15
tools, with this note:

> A simple benchmark found that the extension did not improve results enough to
> justify its overhead, while token usage increased substantially.

The benchmark was real and careful: PR #1119 added `just benchmark-cbmem`, a
paired runner comparing `pi -ne` against `pi -ne -e npm:@narumitw/pi-cbmem` with
a fixed model, disabled retry and compaction, a read-only tool allowlist, hidden
exact-fact grading, and recorded cache tokens, tool activity, timing and cost. It
was deleted along with the package on the same day and now exists only in that
PR's history; `deprecated/pi-cbmem/` has no `benchmark` directory.

This is the only A/B of our category we have found that a vendor did not write,
and it went against the category. Two things follow. First, it belongs in the
same paragraph as the pr-context benchmark whenever we cite ourselves: someone
with no stake ran the comparison and got the opposite sign. Second, the design
points at the likeliest cause and it is not retrieval — their same-evidence study
requires one graph call but does not forbid source reads, so an agent that
queries the graph and then greps anyway produces exactly that result. That is
routing, and routing is the part of our product that does not port across
clients. Tracked in TRA-874; the outgoing comment is in TRA-875.
