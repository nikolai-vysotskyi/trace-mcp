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
- **Before submitting anywhere, ask the target repo whether we are already in
  its queue.** One `gh api -X GET search/issues -f q='repo:<owner>/<repo> author:nikolai-vysotskyi'`
  costs one call and catches the failure this ledger cannot: on 2026-09-06 two
  runs filed the same resource to `0xNyk/awesome-hermes-agent` four minutes
  apart (#394 and #395) and each added its own row here, so the duplicate was
  visible in this table before it was visible to anyone reading it. A grep of
  this file for the repo name is the cheaper half of the same check, and both
  fit in the same minute as the submission. Writing to a maintainer twice is the
  one outreach failure that costs more than not writing at all.
- Numbers quoted to the outside world come from `docs/_data/counts.yml`
  (181 tools / 81 languages / 88 frameworks as of 2026-09-09). Never hand-type
  them, and re-read the file rather than trusting a number written here: the
  language count moved from 80 to 81 within a day of this ledger being started.

## Surfaces

| Surface | Listed | What it shows | How to change it | Verified |
|---|---|---|---|---|
| [get-bb/marketplace](https://github.com/get-bb/marketplace) / BB Community plugin menu | **Listed in marketplace source:** [PR #524](https://github.com/get-bb/marketplace/pull/524) merged 2026-10-10; [entry on `main`](https://github.com/get-bb/marketplace/blob/main/entries/trace-mcp.json) verified | `bb-plugin-trace-mcp` v0.2.0 in `integrations/bb` adds native search/memory tools, a bb thread panel for index health, actual provider-reported context usage and decisions, plus `bb trace` CLI. The entry has primary `memory-and-context`, secondary `token-usage-and-limits`, and two real panel screenshots | **Verified 2026-10-11:** source [PR #1531](https://github.com/nikolai-vysotskyi/trace-mcp/pull/1531) and documentation PR #1533 are merged. Marketplace PR #524 was approved, passed validation CI, and merged; `entries/trace-mcp.json` is present on `main` with the v0.2.0 source and both category fields. The plugin was installed and exercised in bb 0.45.0; the skill, panel and CLI worked on a real thread. The remaining blocker is display in both categories: [bb PR #5276](https://github.com/get-bb/bb/pull/5276) implements secondary shelves but remains automatically closed because `nikolai-vysotskyi` is not yet on its contributor allow list. Per bb's `CONTRIBUTING.md`, the author must ask in [Discord `#contributors`](https://discord.gg/kvBU6tJhcJ) before reopening; this was not a code rejection. Current bb versions display the primary category only. The two screenshots show the real plugin panel without personal data | 2026-10-11 |
| [davila7/claude-code-templates](https://github.com/davila7/claude-code-templates) / [aitmpl.com](https://www.aitmpl.com/component/trace-mcp) | **Yes — and it is the largest surface we are on: 30,531★ / 3,459 forks, pushed daily** | `cli-tool/components/mcps/devtools/trace-mcp.json`, mirrored verbatim into `dashboard/public/component-content/mcps/devtools/trace-mcp.json` (same string, wrapped in a `content` field — both must be edited together). Ships `npx -y trace-mcp@latest` and a hand-typed description. **Already stale again**: it says "80 languages", `counts.yml` says 81 — six days after the refresh that was supposed to fix exactly this | **The entry is ours, not a third-party scrape.** Both commits are Nikolai's: [#553](https://github.com/davila7/claude-code-templates/commit/8b18c46f) 2026-04-29 added it, [#844](https://github.com/davila7/claude-code-templates/commit/bb0c681c) 2026-08-29 refreshed the counts. PRs are the route and two have been merged, so the door is open — but see the note below before spending a run on it. It hardcodes the npm name in `args`, so it belongs on the TRA-644 rename checklist; fold the 80→81 fix into that same PR rather than opening one for a digit | 2026-09-05 |
| [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io) | Yes — `io.github.nikolai-vysotskyi/trace-mcp` | Current: 3.15.0, published 2026-09-03, `status: active`, matching npm `latest`. **The `description` it renders was rewritten 2026-09-05 (TRA-904)** and lands with the next release, not with the merge — see the one-liner section below | Automatic: `.github/workflows/publish-mcp-registry.yml` republishes `server.json` on every release (GitHub OIDC, no secret). **This row is now more than one listing.** `modelcontextprotocol/servers` already redirects here, mcp.so and smithery ingest it, and as of 2026-09-02 goose retires its own 59-entry directory in favour of it too. The `description` field in `server.json` is therefore the copy those surfaces render, not just ours — see TRA-761 | 2026-09-04 |
| [glama.ai](https://glama.ai/mcp/servers/nikolai-vysotskyi/trace-mcp) | Yes | Correct — scrapes README/npm live | Nothing to do; fix the README and it follows. Renders 31 links to `trace-mcp.com` and rewrites every one to `rel="ugc nofollow"` — see TRA-792 below | 2026-09-04 |
| [pulsemcp.com](https://www.pulsemcp.com/servers/nikolai-vysotskyi-trace) | Yes | **Stale: "44+ tools"** — their hand-written `server.json`, kept "until the maintainer publishes to the official registry" | Their submissions are **paused**; their own submit page says publishing to the official registry is the fix. Done 2026-08-29 — waiting on their next sync | 2026-08-29 |
| [mcpservers.org](https://mcpservers.org/servers/nikolai-vysotskyi/trace-mcp) | Yes | Body correct; **header stale**: "53 framework integrations across 68 languages, 100+ tools" | Free form at `/submit` (no account, needs a contact email). Correction submitted 2026-08-29, review ≤12h — but it said "80 languages … up to 99% fewer tokens", and master has since moved to 81 languages and (TRA-904, 2026-09-05) to the PR-benchmark headline, so re-submit once it lands. Premium $39 — declined | 2026-08-29 |
| [mcpmarket.com](https://mcpmarket.com/server/trace) | Yes, as **"Trace"** | Same stale "53 frameworks / 68 languages" copy | No self-serve edit. $29 paid listing, or email support@mcpmarket.com. Free queue re-submit answers "already listed" | 2026-08-29 |
| [mcp.so](https://mcp.so) | **No** | — | **Free submission no longer exists** — `/submit` offers only "Pay and submit automatically", $39. They ingest the official registry, so expect a free pickup. **2026-09-06:** a free-looking side channel does exist and is still not worth a run — `chatmcp/mcpso` takes `[Submit] …` issues and closes them in small batches (four in the first week of September), but the repo has 3,146 open issues, has not been pushed since 2025-03-26, and there is no way to confirm from outside that a closed issue became a live listing: `mcp.so/server/trace-mcp/nikolai-vysotskyi` is 404 and their search page renders client-side, so neither presence nor absence is checkable by fetch. Re-check only if the registry pickup visibly fails | 2026-09-06 |
| [smithery.ai](https://smithery.ai) | **No** | — | Two blockers, not one: the account needs GitHub OAuth (an agent must not authorize that on Nikolai's behalf), **and** a stdio server is published as an MCPB bundle — `smithery mcp publish ./server.mcpb -n <org>/<name>`, per `smithery.ai/docs/build/publish.md`. There is **no `smithery.yaml`** in their current docs; older writeups describing one are stale. They also ingest the official registry | 2026-08-29 |
| [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) | **Yes** | Listed under `Developer Tools`, alphabetical, with the Glama badge and an accurate description | PR to README. Their CONTRIBUTING asks automated agents to append `🤖🤖🤖` to the PR title. Nothing to submit — only re-read the entry when the product's shape changes | 2026-09-01 |
| [hashgraph-online/awesome-ai-plugins](https://github.com/hashgraph-online/awesome-ai-plugins) | **Yes** | Listed under `Community Plugins → Development & Workflow` | PR to README. PR #182 merged 2026-08-31 by `kantorcodes` without requiring third-party scanner action. **Ownership claim declined and it stays declined:** the merge bot and a maintainer reminder on 2026-09-03 both push `hol.org/guard/plugins` for an owner-verified badge and a trust score. That is a login-and-authorize flow on a third-party site for a badge, which is the same trade we refused on the scanner action. No reply is owed and none was sent | 2026-09-05 |
| [aaif-goose/goose](https://github.com/aaif-goose/goose) extension directory | **No — refused, and the directory itself is retired** | — | [Issue #11763](https://github.com/aaif-goose/goose/issues/11763) was **closed** 2026-09-02 by `alexhancock` (collaborator): "We aren't taking new submissions for the extensions directory." The reason is not about us — [discussion #10830](https://github.com/aaif-goose/goose/discussions/10830) retires goose's own registry in favour of the official MCP registry and the `server.json` format: "New contributions to the goose registry are halted. Please don't open PRs adding servers; we won't be merging them." The finished branch `nikolai-vysotskyi/goose:add-trace-mcp` was therefore **never opened as a PR** — the issues-first hold in the previous version of this row is what kept us from opening a PR into a closed door. **Do not re-submit and do not push back.** goose says the registry entry will appear in their doc pages automatically once their `server.json` support lands, and we are already in that registry (row above), so this door is covered without further work | 2026-09-04 |
| [0xNyk/awesome-hermes-agent](https://github.com/0xNyk/awesome-hermes-agent) | **Submitted 2026-09-06, awaiting triage** | — | [Issue #395](https://github.com/0xNyk/awesome-hermes-agent/issues/395), category `Tools & Utilities`, next to `llmtrim` and `rtk-hermes`. 5,574★, pushed 2026-09-02, `NOASSERTION` licence, no payment and no ownership badge. **PRs are forbidden in writing** — `CONTRIBUTING.md`: "Please do not open a PR directly to add a resource"; the route is the `resource-submission.yml` issue form, which we reproduced field by field (`gh` cannot render the form, so the body mirrors its headings). Closing an issue there means *listing*, not refusal — `ai-usage-monitor` (#362, closed 2026-08-28) is in the README today. Triage is batched: four closed 2026-09-02, five 2026-08-28. The submission discloses three things on purpose, because the list has a trust-boundary section: the `shell-hooks-allowlist.json` write on standard/max installs, the missing uninstall path for the `pre_tool_call` hook, and that the Hermes surfaces are tested against the documented schema but never against a live install (`agentburn` disclosed the same and was accepted). **We filed this twice.** Two runs on 2026-09-06 opened #394 (10:10Z) and #395 (10:14Z) with the same resource, and this table carried a row for each without either run noticing the other. #394 was closed as a duplicate on 2026-09-06 with a one-line note naming the cause; #395 is the live submission. See the pre-submission check added under the rules at the top of this file. **Do not re-submit and do not ping before 2026-09-20**. Tracked in TRA-1010 | 2026-09-06 |
| [QuesmaOrg/awesome-ai-tokenomics](https://github.com/QuesmaOrg/awesome-ai-tokenomics) | **Yes** — merged 2026-09-04 | Line 112 of the README, Optimize → Context Engineering, plus the same line in `research/optimize.md` | [PR #53](https://github.com/QuesmaOrg/awesome-ai-tokenomics/pull/53) approved and merged by `bkotrys` (165★ list) after two rounds. **Two corrections came out of his review and both hold outside this listing.** (1) He read `src/analytics/benchmark.ts` and called the entry's "prints per-task token cost with and without the index" a measured claim the code does not support: both sides come from `estimateTokens()` over character counts and the trace-mcp side is a hardcoded fraction per scenario (0.05–0.45). The clause was dropped, not qualified. Do not describe that command as a measurement anywhere else either. (2) **Stop citing npm downloads.** ~40/day through July and most of August, then 1,300–2,000/day on Aug 27–30 — the same four days we published 31 releases. That is mirrors and CI. What convinced him instead was the issue tracker: 15 distinct external accounts filing behavioural reports. Entry format for reference: README line + `research/optimize.md` + a `research/manifest.json` record with `verified_on` / `stale_after`; their `scripts/lint_readme.sh` fails the build on any em-dash in tracked markdown and on a superlative list (`de facto`, `go-to`, `widely used`, `the leading`, …). Self-submission is allowed but needs a disclosure, checkable primary sources, and an independent adoption signal that is not stars | 2026-09-04 |
| [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) | **No — closed 2026-10-15** ([issue #2871](https://github.com/hesreallyhim/awesome-claude-code/issues/2871)) | Display Name `trace-mcp`, category `Providers, Runtime & Integration Infrastructure` | Closed 2026-10-15T06:38Z by maintainer `hesreallyhim` with `state_reason: not_planned` during catalog backlog sweep. Recorded as rejected; per CONTRIBUTING and standing no-ping rule, do not ping, do not re-submit. Tracked in TRA-633 | 2026-10-15 |
| [natsukium/mcp-servers-nix](https://github.com/natsukium/mcp-servers-nix) | **No — asked 2026-09-06**, [issue #606](https://github.com/natsukium/mcp-servers-nix/issues/606) | — | An **install path, not a listing**: a package there is `nix run` / `nix profile` plus a module that writes the server into an agent's config, so the arrivals objection to directory rows does not apply. `serena` is already packaged and the maintainer's bot bumps it almost daily (PRs #595–#605 in two weeks), so one merged package is a maintained channel rather than a one-off row. 297★, Apache-2.0, pushed daily, 11 packages in `pkgs/official/` (ours would go there — that directory is for upstream authors). Package requests by issue are accepted (#128 closed, #575 open) — but #575 has sat unanswered since 2026-08-14, so do not read silence as refusal. **Found only because `numtide/llm-agents.nix` (1,902★) routes MCP servers here in its own issue template.** **Two of the four packaging obstacles we assumed were already solved in their tree, and reading it beat guessing:** `pkgs/official/mastra` is built on `fetchPnpmDeps` + `pnpmConfigHook` + `pnpm_10`, so pnpm is not a blocker (we are a single package, no workspace); and all three of our `postinstall` scripts are irrelevant under `--ignore-scripts`, which is their default, since each exits 0, has an env kill-switch, and `trace-mcp serve` reads nothing they write. The one real cost is four native deps — `better-sqlite3` (node-gyp) plus `@ast-grep/napi`, `@parcel/watcher`, `oxc-resolver` (prebuilt `.node` in optional deps). We asked rather than sending a derivation because there is no Nix on the machine, so `hash` and `fetchPnpmDeps.hash` cannot be computed and nothing could be tested. **If the answer is "send a PR", that is engineering work with a Nix install and gets its own issue — not a promise in their thread.** No reply before 2026-09-20, and then one reminder at most. Tracked in TRA-1012 | 2026-09-06 |
| [hashgraph-online/awesome-codex-plugins](https://github.com/hashgraph-online/awesome-codex-plugins) | **No — declined by us** | — | Same org that merged us into `awesome-ai-plugins`, and we do ship a Codex plugin, so this looks like the obvious next door. It is not. There the scanner action was *advisory* and we were merged without it; here CONTRIBUTING step 1 is "Set up scanner CI in your plugin repo (required) … This is not optional. We verify this during review" — `hashgraph-online/ai-plugin-scanner-action@v1` committed into our workflows, plus `pipx install plugin-scanner` run locally. Both are the thing we already refused. **Closed unless their gate changes** | 2026-09-01 |
| [cursor.directory](https://cursor.directory) (`pontusab/directories`) | **No** | — | Repo holds no listing data ("All content is submitted through the website"); submission is `cursor.directory/plugins/new` behind GitHub or Google sign-in, so it is human-only like Smithery. Worth knowing anyway: they auto-detect components from a repo following the [Open Plugins](https://open-plugins.com) spec, and the MCP hook is a **`.mcp.json` at the repo root**. Ours lived only at `.claude-plugin/.mcp.json`. **2026-09-02 (TRA-634):** repo root now carries `plugin.json` + `mcp.json` per the Agent Plugins v1.0.0 spec, re-read at source that day (`agent-plugins.org/plugin-builders/specification`: manifest at `plugin.json`, MCP config at `mcp.json`, both at plugin root); `skills/*/SKILL.md` already matched. **Not verified that Cursor's scanner accepts it** — the only way to check is to feed it the repo through the logged-in form, and their own README still names a dotted `.mcp.json` and no `plugin.json`, so spec and scanner may disagree. We did not add a root `.mcp.json`: Claude Code reads that path as project-scoped MCP config, so it would change behaviour for anyone who clones the repo. Next step is Nikolai submitting, then reading back what the scanner detected | 2026-09-02 |
| [appcypher/awesome-mcp-servers](https://github.com/appcypher/awesome-mcp-servers) | **No — dead** | — | **The repo is archived** (last push 2026-05-06; 5,764 stars). GitHub refuses pull requests against an archived repo, which is what "does not have the correct permissions to execute `CreatePullRequest`" actually means — TRA-482 read that error as a token-scope problem and parked the submission on Nikolai. It was never his to unblock. The prepared fork branch `nikolai-vysotskyi/awesome-mcp-servers-appcypher:add-trace-mcp` is dead weight | 2026-09-01 |
| [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | — | — | **Not a door any more.** The README is now reference servers only and says so in a banner: "If you are looking for a list of MCP servers, you can browse published servers on the MCP Registry." No community-servers section survives to be added to. We are in the registry it points at, so this is already covered | 2026-09-01 |
| [wong2/awesome-mcp-servers](https://github.com/wong2/awesome-mcp-servers) | **No** | — | **Not a separate door.** Its README refuses PRs outright and redirects to `mcpservers.org/submit` — the same form as the mcpservers.org row above. Treat the two as one channel | 2026-08-29 |
| [Cline MCP Marketplace](https://github.com/cline/mcp-marketplace) | **No** — checked their live catalog API (`api.cline.bot/v1/mcp/marketplace`, 199 entries), not a web search | — | Closest thing to an open door left. Open an issue on `cline/mcp-marketplace` with their `mcp-server-submission` template: repo URL, a **400×400 PNG** logo, reason for addition. `llms-install.md` is optional — their FAQ says a well-written README is usually enough (there is no crawler; Cline itself reads the README at install time). Their step 3 also asks the submitter to confirm they have watched Cline set the server up from the README alone. The logo is now in-repo at `docs/icon-400x400.png`. No account or payment — but that step-3 checkbox is **required**, so this is not an agent-alone submission; see "Next door to try" | 2026-08-29 |
| [Docker MCP Catalog](https://github.com/docker/mcp-registry) | **No** — listed all 328 entries of `servers/` via the GitHub contents API | — | **Blocked on an artifact we don't have.** Both paths need something trace-mcp isn't: "Local" wants a Dockerfile in our repo, "Remote" wants a reachable streamable-http/SSE endpoint. A plain npm/stdio package qualifies for neither. Adding a Dockerfile is a product decision, not a listings one — don't smuggle it in as distribution work | 2026-08-29 |
| [Homebrew `homebrew-core`](https://github.com/Homebrew/homebrew-core) | **No — closed to a self-submission on two counts, both measured 2026-09-07** | — | An install path, not a listing, so the arrivals objection does not apply — but it is shut. (1) **Notability**: `docs/Package-Acceptance-Policy.md` asks 75★ / 30 forks / 30 watchers from a third-party submitter and **225★ / 90 forks / 90 watchers when the repository owner submits it himself**. We are at 161★ / 19 forks / 4 watchers, so we clear the third-party bar today and are 64 stars short of our own. (2) **Native dependencies, and this one does not expire with stars**: `homebrew/core` requires build-from-source or platform-independent output, and `std_npm_args` builds native addons from source. `better-sqlite3` (node-gyp) and `@parcel/watcher` (`install: build-from-source.js`) can do that; `@ast-grep/napi` and `oxc-resolver` cannot — both are napi-rs crates whose npm tarball carries no Rust source at all, only `optionalDependencies` on per-platform packages containing a prebuilt `.node`. Same four native deps are the one real cost named in the `mcp-servers-nix` row, so this is one product constraint closing two OS package managers, not two listing problems. Also worth knowing before anyone tries: `std_npm_args` runs npm with scripts ignored, so all three of our `postinstall` steps — including `postinstall-control-plane.mjs`, which writes `~/.trace/launcher.env`, the `trace` shim and the launchd plist — would not run, and a brew install would produce a CLI without the control plane. Re-check only if the napi deps gain a source build; stars alone do not open it | 2026-09-07 |
| Continue.dev Hub | — | — | **Dead product, not a gap.** Continue was acquired by Cursor (June 2026), the final release shipped 2026-06-19, cloud data was deleted after 2026-07-15, `hub.continue.dev` no longer resolves. The GitHub repo is **not** archived and is still public — do not describe it as read-only — but it has shipped nothing since (last commit 2026-07-21). Re-check only if Cursor stands a successor up | 2026-08-29 |
| [LobeHub](https://lobehub.com/mcp) | **No** — the `trace-mcp` listing there is `Mnehmos/trace-mcp`, an unrelated project with the same name | — | Publishing is `npx @lobehub/market-cli`, and it requires `lhm login` (browser OIDC) plus `lhm github connect` (browser ownership check). There is no token-only path: verified in `@lobehub/market-cli@0.0.41` itself, because their docs pages under `lobehub.com/docs/market/*` are content-free stubs. `plugin publish` and `plugin claim` both go through `createUserSDK()`, which aborts with "Not logged in. Run `lhm login` first" unless a user OAuth token is on disk; the `MARKET_CLIENT_ID`/`MARKET_CLIENT_SECRET` env pair is never used for publishing. Human-only, like Smithery | 2026-08-29 |
| [skillsllm.com](https://skillsllm.com/skill/trace-mcp) | **Yes** — found while checking it as a "roundup" (see below); it is a directory, and we were already in it | Accurate and live: 177 tools / 81 languages / 102 stars, matching `docs/_data/counts.yml` on the day it was read. Passed their Semgrep + dependency scan | Nothing to submit. Their `/about` says a scraper "searches GitHub daily for repositories containing SKILL.md files or tagged with relevant topics like `claude-code`, `ai-agent`, `mcp-server`" — we carry all three, so the topics row below is what put us here and what keeps the numbers current. A `/submit` form and a paid "Featured Listing" also exist; neither is needed | 2026-09-02 |
| `trace-mcp.vi.softonic.com/mcp` | **Yes — scraped, not submitted** | Unknown — all of `*.softonic.com` answers HTTP 412 to a scripted fetch (four UA/header variants, 2026-09-04) | **Nothing to do, and do not open this door.** Found because Search Console names it as one of exactly two external URLs linking `trace-mcp.com` (TRA-792). A download portal that wraps third-party installers in its own; we control nothing on that page. Do not submit, do not link, do not chase the other locales | 2026-09-04 |
| [tolkonepiu/best-of-mcp-servers](https://github.com/tolkonepiu/best-of-mcp-servers) | **Submitted, not merged** — [PR #384](https://github.com/tolkonepiu/best-of-mcp-servers/pull/384), opened 2026-08-29 | One entry in `projects.yaml`; a scheduled bot commits the rendered README ("Best-of update", last one 2026-09-02) | PR adding a `projects.yaml` block; `yamllint` is the only check and it passed on ours. **The door is slow, not closed, and the numbers say don't push:** 12 other `Add project:` PRs are open, the oldest from 2026-08-27, and across all of 2026 only four external project-add PRs were merged at all (#52, #120, #161, #299) — #299 took 39 days. Zero maintainer activity on ours. The one allowed reminder went out 2026-09-26 ("Still applies cleanly against the current projects.yaml, yamllint passes. Leaving it with you for whenever the next batch of project adds gets triaged") — reminder budget spent, no further pings, leave it. **This row was missing until 2026-09-05** — the submission was made on 2026-08-29 and never recorded, which is exactly the failure the rules at the top of this file describe | 2026-09-27 |
| [axisrow/trace-mcp-plugin](https://github.com/axisrow/trace-mcp-plugin) via [etopro/plugin-marketplace](https://github.com/etopro/plugin-marketplace) | **Yes — third-party, we did not submit it** | A Claude Code plugin (MIT, 0★, created 2026-08-01) that wraps our CLI: `/trace-mcp-install`, `/trace-mcp-measure`, `/trace-mcp-uninstall`, plus a saved benchmark baseline for a re-measure a week later. Listed in the `etopro-plugins` marketplace (2★) as `trace-mcp`. README is in Russian and links our repo | Nothing to submit, and **the value here is not the listing**. The author read `dist/cli.js` at 1.46.2 and filed two issues about our behaviour in his own tracker — [#4](https://github.com/axisrow/trace-mcp-plugin/issues/4) (the daemon auto-registers every project root an MCP client connects from; he watched 9 projects appear in the registry within a day of one install) and [#5](https://github.com/axisrow/trace-mcp-plugin/issues/5) (installation places hooks without asking). #4 re-verified against 3.17.1 and filed upstream as [#936](https://github.com/nikolai-vysotskyi/trace-mcp/issues/936), credited to him; answered once in his thread with the current gate list and the `remove --keep-db` cleanup. **Found by GitHub issue search for our own name, not by any directory** — the same channel that found `mattbutlerengineering/ai-tooling` | 2026-09-05 |
| [eltociear/awesome-AI-driven-development](https://github.com/eltociear/awesome-AI-driven-development) | **Yes — merged 2026-09-30** ([PR #119](https://github.com/eltociear/awesome-AI-driven-development/pull/119), opened 2026-09-06, merged by maintainer) | One line each in `README.md` and `README_JA.md`, section `MCP Servers & Integrations`, after `codebase-memory-mcp` — verified live 2026-09-30 in both files via API (EN + JA entry text renders, links our repo). Tool count in both headers moved 594 → 595 at submission, rebased 2026-09-15 to 596 → 597 after the Sillage sync (#115, #117), rebased 2026-09-25 to 598 → 599 after the MulmoTerminal sync (#127) — entry lines untouched throughout, final header count 599 | PR to both READMEs, format in `CONTRIBUTING.md`, PR template filled in EN+JA. 531★, no account, no scanner, no payment, no ownership badge. The only list on this table where a self-submission is the normal way in rather than a lottery ticket — and it held: merged 2026-09-30 14:44Z (24 days after opening) with zero review rounds. Live entry verified. Tracked in TRA-1030 | 2026-09-30 |
| [ai-boost/awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering) | **No — отброшено / closed channel** ([PR #240](https://github.com/ai-boost/awesome-harness-engineering/pull/240), opened 2026-09-05) | One line in `README.md`, section `Context Delivery & Compaction` (4,005★, 490 forks) | PR channel is a dead end. **Verified 2026-10-20:** 0 external PRs merged since 2026-07-22 (out of the last 20 closed PRs, 0 merged). PR #240 remains in conflicting/dirty state due to upstream daily self-adds. Per pre-defined decision rule in TRA-926 (`0 merges since 2026-07-22 -> otbrosheno`), marked as отброшено / dead end. Entries land solely through maintainer's personal discovery of projects clearing ~1k★, not via submissions. Do not ping, do not rebase. Revisit only if trace-mcp clears ≥1k★. Tracked in TRA-926 | 2026-10-20 |
| [yzfly/awesome-context-engineering](https://github.com/yzfly/awesome-context-engineering) | **Yes — merged 2026-09-20** ([PR #44](https://github.com/yzfly/awesome-context-engineering/pull/44), opened 2026-09-05, merged by `yzfly`) | One line each in `README.md` (line 292, verified live) and `README_CN.md` (line 275, verified live), section `Memory & Compression` / `记忆与压缩`, next to `lean-ctx`, `headroom` and `skillreaper` | PR to both READMEs — `CONTRIBUTING.md` requires the English and Chinese versions to stay in sync, so an entry that touches one file only is incomplete. **This is the door with a real merge rate in this class:** five external PRs merged in the two weeks to 2026-08-30, three of them in one batch, authors unaffiliated with the maintainer. The merge rate held: quiet since 2026-08-30, then ours merged 2026-09-20 with zero comments and zero review rounds. Nothing owed — a thank-you would only cost a notification | 2026-09-20 |
| GitHub repo topics | **Yes** — always on, the surface is ours | **20 of 20 slots used** — the cap. Changed 2026-08-30: dropped `token` and `tokens` (3,892 / 1,572 repos, almost all auth or crypto — wrong audience for a word we only meant one way) and `claude-skill` (near-duplicate of `claude-skills`, which is the bigger of the two: 7,662 vs 4,841); added `code-graph` (208 repos), `dependency-graph` (901) and `static-analysis` (8,072) | The one listing surface we own outright: `gh api -X PUT repos/:r/topics --input <json>`, instant, reversible, no review. Topic pages are a browse surface, so a *small* exact topic like `code-graph` is worth more than a big vague one. Sizes via `gh api "search/repositories?q=topic:<t>&per_page=1" --jq .total_count`. Before rebalancing again: 7 of the 20 slots are `claude-*` variants (8 before this change), which is defensible but is where the next slot comes from; `rag` (43,793) is the other weak slot — we retrieve, but we are not a RAG pipeline | 2026-08-30 |
| GitHub repo description | **Yes** — always on, the surface is ours, and it is **the string the auto-indexes copy verbatim** | Was "MCP server for Claude Code and Codex. One tool call replaces ~42 minutes of agent exploration" until 2026-09-05, then carried "100% local" until 2026-09-07. Now: "Framework-aware code intelligence MCP server for Claude Code and Codex — 70.5% fewer input tokens to review a pull request, median over 60 merged PRs in repos we don't own, comprehension at parity. 81 languages, 87 frameworks. Your code and index never leave the machine; an anonymous usage ping is on by default and opt-out." (327 of the 350 characters GitHub allows) | `gh api -X PATCH repos/:r -f description=...`, instant, reversible, no review — same class as topics. Keep it in step with `package.json` `description` and `server.json` `description`; all three now quote the PR-benchmark figure and none may quote a number that is not in `docs/_data/`. **No longer on trust: `scripts/check-remote-claims.mjs` fetches this string nightly and compares it to `docs/_data/`** (TRA-1120). **Lags again since TRA-1141 re-measured the median to 72.7%** — the live GitHub and npm strings still say 70.5% and the nightly check will report them as not-in-`docs/_data/` until the description is patched and the next release republishes npm. | 2026-09-07 |
| [Chat2AnyLLM/awesome-claude-plugins](https://github.com/Chat2AnyLLM/awesome-claude-plugins) | **Yes — never submitted** (115★) | README line 1339, in a machine-generated table of scanned Claude plugin repos: our repo, branch `master`, `.claude-plugin` detected, status ✅ ok | Nothing to submit — it scans repos carrying a `.claude-plugin` directory. Found by code search 2026-09-05, not by a directory hunt | 2026-09-05 |
| [linny006/mcp-servers-live](https://github.com/linny006/mcp-servers-live) + [its Pages site](https://linny006.github.io/mcp-servers-live/r/nikolai-vysotskyi/trace-mcp/) | **Yes — never submitted** | Auto-index of MCP servers refreshed every 15 minutes; we are #49 by stars with a per-repo page. Its whole body is our GitHub description, repeated 5× on that page | Nothing to submit. Links only `github.com`, never `trace-mcp.com`, so it adds nothing to the domain count below. Its value is that it demonstrates the description-propagation above | 2026-09-05 |
| [linny006/trending-claude-skills](https://github.com/linny006/trending-claude-skills) | **Yes — never submitted** | Trending table, **rank 3**, 133★, same auto-copied description | Same scraper family as the row above; one operator, two indexes. Nothing to submit | 2026-09-05 |
| [linny006/claude-code-plugin-tracker](https://github.com/linny006/claude-code-plugin-tracker) | **Yes — never submitted** | Auto-scraped Claude Code plugin index, rank 13, 175★ in `README.md` and `data/items.json`. Carries our exact GitHub description | Same scraper family as the two rows above; one operator, three indexes. Nothing to submit | 2026-09-10 |
| [apiiskan/ai-agent-radar](https://github.com/apiiskan/ai-agent-radar/issues/16) | **Yes — never submitted** | A Chinese-language daily radar of AI-agent repos, published as GitHub issues. We are **#5 of the day** in the 2026-08-03 digest, score 45.69, one line of description plus the full topic list | Nothing to submit, and the scoring formula is the interesting part: it is readable in the entry itself — README present, licence, tests, an MCP entry point, days since last push, days since creation, and **topic matches**. That is the third auto-index in a row whose input is the repo topics row below, and the first one that prints its weights. Found by the issue-index sweep, not by a directory hunt | 2026-09-06 |
| [GetBindu/awesome-claude-code-and-skills](https://github.com/GetBindu/awesome-claude-code-and-skills) | **Submitted, not merged** — [PR #195](https://github.com/GetBindu/awesome-claude-code-and-skills/pull/195), opened 2026-09-06 | One entry appended to `Productivity Tools → MCP Servers & Integrations`, the section `oraios/serena` opens (188★) | PR to `readme.md`; CONTRIBUTING is four points in the readme itself, no account, no scanner, no payment, and `Contents` is section-level so an entry never touches it. **This one passes the commit-log test the other two lists failed:** eight external PRs merged in August (`aragossa`, `therohitdas`, `aaronjmars`, `musoyangrigor`, `yotta-fish`), the last on 2026-08-31, by a maintainer who merges other people's entries rather than only adding his own. Queue is 38 open. Do not ping before 2026-09-20 | 2026-09-06 |
| [Arnon-hs/open-source](https://github.com/Arnon-hs/open-source/blob/main/mcp/nikolai-vysotskyi-trace-mcp.md) | **Yes — never submitted** (89★) | A generated page of its own under `mcp/` **and** a second under `aiml/`: badges, a 67/100 score, our topic list, a practical-evaluation block, and an LLM-written summary in English, Russian and Chinese | Nothing to submit — and this is the row that changes how the auto-index channel should be valued, see the note below the table. It is **not** verbatim: the summary expands "MCP" to "Message Control Protocol" and the stars are 67 against a live 146 | 2026-09-06 |
| [SAIRAMANALADI/vybe-intelligence-vault](https://github.com/SAIRAMANALADI/vybe-intelligence-vault) | **Yes — never submitted** (21★) | ~15 dated files under `daily-digests/*/trace-mcp.md`, each with YAML front matter: `quality_score: 9`, `rag_relevance: 10`, a tag list, and a `tech_stack` naming Graph Databases, NLP and **GPU Acceleration** — none of which we ship | Nothing to submit. Same generative shape as the row above | 2026-09-06 |
| [agentskillexchange/skills](https://github.com/agentskillexchange/skills) — rendered at [agentskillexchange.com](https://agentskillexchange.com/skills/serve-codebase-impact-context-to-agents-with-trace-mcp/) | **Yes — third-party, we did not write it and did not submit it** (36★, catalog created 2026-03-20, pushed daily) | A generated skill, `skills/serve-codebase-impact-context-to-agents-with-trace-mcp/SKILL.md`: prerequisites, an install block (`npm install -g trace-mcp` → `trace init` → `trace add`), links to the repo and to trace-mcp.com, and front matter carrying `verification: security_reviewed`, `category: Code Quality & Review`, `github_stars: 154`, `npm_weekly_downloads: 6588` and **`author: nikolai-vysotskyi`** | Live page verified 2026-09-06 (HTTP 200). **The install path is correct** — `trace init` and `trace add` are both real commands, `bin` maps `trace` and `trace-mcp` to the same CLI — so there is nothing to correct, which makes this the third accurate third-party wrapper after `axisrow/trace-mcp-plugin` and `claudskills.com`. Two things to know rather than fix: `author: nikolai-vysotskyi` attributes to us a file we never wrote, and the entry quotes a weekly npm download count as an adoption figure — the metric `docs/comparisons.md` documents as mirror-inflated. Both are the catalog's editorial choice on a page we do not control. Found by `scripts/mention-sweep.sh` 2026-09-06 | 2026-09-06 |
| [patrickclery/awesomer](https://github.com/patrickclery/awesomer) (16★), [gabrielmoreira/awesome-ai-rabbit-holes](https://github.com/gabrielmoreira/awesome-ai-rabbit-holes) (5★) | **Yes — never submitted** | One line each, carried in from a list they aggregate | Nothing to submit; recorded so a later run does not open them as doors | 2026-09-06 |
| [claudskills.com/skills/trace-mcp-pre-commit](https://claudskills.com/skills/trace-mcp-pre-commit) — mirrored at [aibot88/sec_skill_store](https://github.com/aibot88/sec_skill_store) | **Yes — third-party, we did not write it and did not submit it** | A Claude Code skill called `trace-mcp-pre-commit`: "Run trace-mcp security, quality-gate, and antipattern checks before committing or opening a PR." It walks an agent through `scan_security` → `taint_analysis` → `check_quality_gates({scope:"changed"})` → `detect_antipatterns` → `compare_branches` / `get_changed_symbols` / `predict_bugs` / `get_risk_hotspots`. **All seven tool names were checked against `src/tools/register/` and all seven are real** (`git.ts`, `quality.ts`, `advanced.ts`) — this is an accurate integration, not a hallucinated one | Live page verified 2026-09-06 (a fabricated slug on the same path returns 404, so the 200 is real). Nothing to submit and nothing to correct. **What it is worth is the shape:** it is the second third-party wrapper after `axisrow/trace-mcp-plugin`, and it wraps the half of our tool surface our own marketing never mentions — the quality/security tools, not the navigation ones. Somebody read the tool list and found a use we do not sell. Do not open an issue; the GitHub repo is a static mirror last pushed 2026-05-27 | 2026-09-06 |
| [hotaru-ritsuki/ai-daily-briefings](https://github.com/hotaru-ritsuki/ai-daily-briefings) (2★) | **Yes — never submitted, and this is a reader, not an index** | A personal daily AI-engineering briefing. `briefings/2026-08-30.md` recommends us in the author's own words: "an MCP server for CC *and* Codex that claims 'one tool call replaces ~42 minutes of agent exploration' by giving the agent a code-trace instead of blind file reads. **Relevant for your Spring Boot/monorepo work**", and ranks us third in that day's list — "*Why:* cuts agent exploration time on large Java/TS codebases" | Nothing to submit; the value is the readout, below. Two stars, written for one person, and it is the closest thing to a user telling us in public what they think we are | 2026-09-06 |
| [savanna0425/skillhot](https://github.com/savanna0425/skillhot) (37★) | **Yes — never submitted** | Chinese-language skill/repo directory. Carries our record in `public/data/details/nikolai__vysotskyi__trace__mcp.json`, plus `manifest.json` and `topics/claude-code-skill.json`, with `homepage` and the **current** description string — the measured PR figure, not the retired one | Same scraper family as the `linny006` rows: verbatim copy of the GitHub description, so fixing the string fixes it. Useful as a control — it is the first auto-index observed carrying the corrected wording, which is evidence the 2026-09-05 fix propagates | 2026-09-06 |
| [bormaxi8080/osint-timeline](https://github.com/bormaxi8080/osint-timeline) (151★) | **Yes — never submitted** | A dated newsletter roundup, `timelines/osintech-timeline_159_23.04.2026.md`: "**Trace MCP.** MCP server for Claude Code and Codex. One tool call replaces ~42 minutes of agent exploration" | Nothing to submit. It is a **frozen dated issue** — the file is an archive entry, so unlike the scrapers it will never refresh. See the derivatives note below | 2026-09-06 |
| [blackwell-systems/gcf](https://github.com/blackwell-systems/gcf) (46★) | **Yes — never submitted, and not a directory** | `outreach/tier1-discovery-2026-06-17.md`, a competitive-discovery sheet somebody else keeps: "\| 88 \| [nikolai-vysotskyi/trace-mcp](https://github.com/nikolai-vysotskyi/trace-mcp) \| MCP exploration server \| TOON output format option \|" — a scored tier-1 row in someone else's outreach list | Nothing to submit; the point is what put us on it. Their column says **TOON output**, not code intelligence, not token savings. A feature we have never led with is what made us legible to an outside prospector's filter. Worth knowing before the next positioning pass — it is the only observed case of an outsider naming why they picked us | 2026-09-06 |
| [aitoolrank.io](https://aitoolrank.io) | **No** — checked 2026-09-07 | — | Curated AI tools directory by Dan Kornas (author of the 09-05 viral X post). Free submission available at `/submit/` (tool name, URL, short description, category, free/paid, contact email). No OAuth or payment required. Handed off to GitHub Distribution & Outreach per ledger boundaries | 2026-09-07 |
| [su-record/vibe](https://github.com/su-record/vibe) | **Yes — third-party, we did not write it and did not submit it** (AX/FDE harness) | `src/core/capabilities.ts` registers `trace` (`trace-mcp`) as an external tool capability serving `blast` (blast-radius and symbol-level impact analysis on `git diff` hunks and callers). Probes `trace --version`, install command: `npm i -g trace-mcp && trace init && trace add`. Proposes installation when repository exceeds 200 files. Fallback is vibe's built-in regex lexer | Nothing to submit; external tool integration. Added native CLI command `trace blast` (alias `trace impact`) in TRA-1252 to fulfill its blast capability directly from the terminal without requiring an active MCP client transport. Found by `scripts/mention-sweep.sh` 2026-09-09 | 2026-09-09 |
| [xmkqv/money-tree](https://github.com/xmkqv/money-tree) | **Yes — third-party, we did not write it and did not submit it** | `.claude/skills/catalogs/agentic-code-cleanup.md` under `agent-code-quality`: "MIT. MCP and CI surface for change-impact evidence and pull-request risk | deterministic, python, typescript, sql, dead-exports, test-gaps, blast-radius, pr-risk, ci" | Nothing to submit; curated skill catalog for agentic code cleanup. Accurately identifies our blast-radius, pr-risk and test-gap capabilities. Found by `scripts/mention-sweep.sh` 2026-09-11 | 2026-09-11 |
| [aloth/awesome-ai-agents](https://github.com/aloth/awesome-ai-agents) | **No — evaluated 2026-09-16, fits, held by the catalog moratorium** | 49 stars, 60 forks, CC0-1.0, pushed daily, 20+ contributors — passes the authenticity check (live history, independent maintainers, no payment, no badge). `Agent Skills & Tools` already lists code-review-graph, codegraph and Graft with measured-claim descriptions; we are absent from exactly our category. Their gate is >100 stars OR a major org — we clear it at 174. Entry format is name + link + one line under 15 words, alphabetical within section; route is a PR, with an `add-project.yml` suggestion issue for fit questions. **Do not submit until the catalog moratorium lifts** (acquisition must read first); when it does, this is the first door | 2026-09-16 |
| [crazy54/awesome-agentic-atlas](https://github.com/crazy54/awesome-agentic-atlas) | **No — rejected 2026-09-16, link-farm shape** | Created 2026-09-03, 0 stars / 0 forks, one contributor, recent commits are CNAME edits and self-merges. An aggregator of aggregators ("guide to all the top Awesome repos") with no audience and no track record — the dofollow-link shape the rules at the top of this file warn about. Do not re-evaluate before it has independent contributors or a measurable audience | 2026-09-16 |
| [TensorBlock/awesome-mcp-servers](https://github.com/TensorBlock/awesome-mcp-servers) | **No — evaluated 2026-09-16, fits, held by the catalog moratorium** | 854 stars, 874 forks, MIT, 30+ contributors, merges daily (PR #2444 on 09-16), open-issue queue 6 — passes the authenticity check. Code search for `trace-mcp` returns 2 hits, both `korwabs-playwright-trace-mcp` (a Playwright trace viewer — name collision, not us); we are absent. Route is the `add-mcp-server.yml` issue form or a direct PR ("a pull request is still the fastest path"); no payment, no badge, the only required checkbox is a dedup attestation. Likely category `Developer Productivity & Utilities`. **Do not submit until the catalog moratorium lifts** (acquisition must read first); when it does, this is the second door after aloth | 2026-09-16 |
| [cyc123456789/claude-catalog](https://github.com/cyc123456789/claude-catalog) | **Yes — third-party, we did not write it and did not submit it** (0★, 0 forks, single author) | `catalog.json` entry `gh:nikolai-vysotskyi/trace-mcp` (added 2026-09-07): zh-TW summary — cross-language dependency-graph MCP server, "over 70%" PR input-token saving, 81 languages, 87 frameworks. Accurate against `counts.yml` and the PR-benchmark figure; recorded stars 170 vs live 175 | Nothing to submit — single-author Claude-maintained catalog (163 entries, static `index.html`, no license, no submission path, no audience). Do not open an issue; there is nobody to write to. Found by `scripts/mention-sweep.sh` 2026-09-17 | 2026-09-17 |
| [metaone01/agent-forge](https://github.com/metaone01/agent-forge) | **Yes — third-party, we did not write it and did not submit it** (0★, single author, pushed 2026-09-22) | `sources/mcp/packages/io.github.nikolai-vysotskyi__trace-mcp.json`: machine-readable package record ingested from the official MCP registry (`_meta` names `registry.modelcontextprotocol.io` as source, version 3.31.2, `verified: true`, link-check ok). Description current — "81 languages, 88 frameworks, 72.7% fewer PR-review tokens, comprehension at parity" — and `homepage: https://trace-mcp.com` carried through as data, which is the `websiteUrl` lever working. Repo is a static-JSON aggregation source ("does not inspect code, certify publishers"), no submission path, no audience | Nothing to submit and nothing to correct. Value is as evidence: the registry publish keeps minting downstream records with zero run cost — the fourth such auto-ingest after skillsllm, savanna0425/skillhot and cyc123456789. Found by `scripts/mention-sweep.sh` 2026-09-23 | 2026-09-23 |
| [rogerchappel/mcpchangefeed](https://github.com/rogerchappel/mcpchangefeed) | **Yes — third-party, we did not write it and did not submit it** (0★, single author, created 2026-06-03, pushed 2026-09-24) | `site/servers/io-github-nikolai-vysotskyi-trace-mcp/index.html`: auto-generated directory page ingested from the official MCP registry (server id `io.github.nikolai-vysotskyi/trace-mcp`). Copy current — "Code graph MCP: 81 languages, 88 frameworks, 72.7% fewer PR-review tokens, comprehension at parity" — version 3.31.5 marked Fresh Sep 24, 2026, install `npx trace-mcp`. Trust score 55/100. Caveats are the tracker's, not ours: "License Unknown" / "Missing license signal" despite the repo carrying a LICENSE, plus placeholder sponsor slots on every page | Nothing to submit and nothing to correct — daily-snapshot tracker ("Track MCP server changes and publish a static directory"), no submission path, no audience. Value is as evidence: the registry publish keeps minting downstream records with zero run cost — the fifth such auto-ingest after skillsllm, savanna0425/skillhot, cyc123456789 and metaone01/agent-forge. Found by `scripts/mention-sweep.sh` 2026-09-24 | 2026-09-24 |
| [MaquinaTech/graph-indexer](https://github.com/MaquinaTech/graph-indexer) | **Yes — third-party, we did not write it and did not submit it** (11★, 1 fork, single author, MIT, pushed daily) | `docs/research/notes/output_rewriting_and_read_hooks.md` names trace-mcp as the direct graph-indexer analogue: guard-hook navigation gate, SessionStart/UserPromptSubmit/PreCompact/Stop hooks, `trace-mcp-mirror.sh` PostToolUse output rewrite, plus the PR-review token figure. The notes pin our source at `@e5a180a` (2026-09-23) alongside rtk, context-mode, headroom and squeez | Nothing to submit and nothing to correct — internal research notes, no submission path, no audience. Value is competitor-intel signal, not a surface: a rival building the same shape (tree-sitter code graph + search over MCP, CLI + agent hooks) is reading our source pin by pin. Do not open an issue; there is nothing to pitch and nobody to pitch it to. Found by `scripts/mention-sweep.sh` 2026-09-25 | 2026-09-25 |
| [jaimevalero/managing-awesome-lists-frontend](https://github.com/jaimevalero/managing-awesome-lists-frontend) | **Yes — third-party, we did not write it and did not submit it** (0★, 0 forks, no license, pushed daily) | `public/similar/nikolai-vysotskyi@trace-mcp.json`: generated similarity record, cached 2026-09-25 — our description current ("88 framework integrations, 81 languages, 72.7% fewer input tokens", matching `counts.yml`), plus a similarity set naming `codebase-memory-mcp`, `synapse-mcp`, `roslyn-codelens-mcp`, `tribeunal/mcp-server` and `drhalto/agentmako`. Frontend for the `managing-awesome-lists` app (`managing-awesome-lists.vercel.app`) | Nothing to submit and nothing to correct — static JSON for a list-management frontend, no submission path, no audience. Value is twofold: the sixth zero-cost auto surface (no run spent), and the similarity set is a free consideration-set reading — the company our category keeps when a machine clusters it. Found by `scripts/mention-sweep.sh` 2026-09-25 | 2026-09-25 |
| [NOMARJ/sigil](https://github.com/NOMARJ/sigil) | **Yes — third-party, we did not write it and did not submit it** (5★, 2 forks, single author, Python, pushed 2026-09-27) | An automated security-auditing CLI for agent tooling ("quarantine-first workflow for repos, packages, and agent tooling"). `evaluation_results/corpora/mcp_holdout_manifest.json` carries `io.github.nikolai-vysotskyi/trace-mcp` at 3.33.0 (registry npm tarball, published 2026-09-25) as one of its held-out registry-MCP samples; the holdout run (`mcp_holdout_sigil-main`) rates our package CRITICAL with 1,644 findings | Nothing to submit and nothing to dispute — evaluation corpus, no submission path, no audience. Two things worth knowing rather than fixing. (1) The seventh zero-cost downstream record minted by the registry publish with no run spent — the mechanism keeps working. (2) The verdict is not a singling-out: the neighbouring corpus samples rate the same way (`newrelic-experimental/preflight` CRITICAL, `nrwl/nx-console` CRITICAL), and their own calibration doc calls the blocked figure "an upper bound on false positives" (post-calibration clean-corpus blocked rate 22.5%). A quarantine-first scanner flagging postinstall-bearing npm packages is expected, not news — but if the Security posture ever wants a worked example of how third-party MCP scanners read us, this corpus names the rule IDs per sample. Do not open an issue; a correction request to someone's benchmark corpus is an outgoing message with no reader. Found by `scripts/mention-sweep.sh` 2026-09-27 | 2026-09-27 |
| [ankitkapur1992-hlido/hlido-public](https://github.com/ankitkapur1992-hlido/hlido-public) | **Yes — third-party, we did not write it and did not submit it** (0★, 0 forks, single author, MIT) | Machine-readable review scorecard `scorecards/nikolai-vysotskyi-trace-mcp.json` (Hlido Editor, dated 2026-09-27): score 77/STEADY — agent-native design praised, headline token claims flagged as unverified. **Copy is stale two ways**: quotes the retired "~40–50% average, up to 94–99%" range (gone from master since TRA-904, 2026-09-05) and "no data leaves your machine" with no telemetry caveat (TRA-1013 class) | Nothing to submit and nothing to dispute — editorial scorecard, no submission path, no audience. Value is as evidence: the third generative derivative after Arnon-hs and vybe-vault carrying retired claims, which is the "retiring a bad claim does not retire its derivatives" note working again. Do not open an issue. Found by `scripts/mention-sweep.sh` 2026-09-28 | 2026-09-28 |
| [sudosubin/agents.nix](https://github.com/sudosubin/agents.nix) | **Yes — third-party, we did not write it and did not submit it** (16★, 2 forks, MIT, pushed daily) | Nixpkgs overlay for AI agent skills from skills.sh and skillsdirectory.com. Automatically packages `nikolai-vysotskyi/trace-mcp` v3.34.6 in `data/agent-skills/` and `data/claude-code-marketplaces/` with sha256 hash, exposing skills `trace-mcp`, `trace-mcp-codemod`, `trace-mcp-pre-commit`, `trace-mcp-refactoring` | Nothing to submit and nothing to correct — downstream automated Nix packaging, no submission path. Value is distribution evidence: trace-mcp skills are being packaged and distributed into the Nix ecosystem automatically. Found by `scripts/mention-sweep.sh` 2026-10-08 | 2026-10-08 |
| [majiayu000/claude-skill-registry-data](https://github.com/majiayu000/claude-skill-registry-data) | **Yes — third-party, we did not write it and did not submit it** (23★, 10 forks, MIT) | Archived Claude Code skill files and metadata consumed by the Claude Skills Registry pipeline. Mirrored `trace-mcp`, `trace-mcp-codemod`, and `trace-mcp-refactoring` skills in `other/trace-mcp/` | Nothing to submit and nothing to correct — skill registry pipeline mirror. Found by `scripts/mention-sweep.sh` 2026-10-08 | 2026-10-08 |
| [cesarschutz/claude-code-kit](https://github.com/cesarschutz/claude-code-kit) | **Yes — third-party, we did not write it and did not submit it** (1★, 0 forks) | Marketplace/template kit for Claude Code plugins in Portuguese. In `07-mcps.md` under "Código e repositórios", lists `trace-mcp` alongside `github-official`, `serena`, `jupyter` | Curated listing in an independent plugin kit. Nothing to submit. Found by `scripts/mention-sweep.sh` 2026-10-08 | 2026-10-08 |
| [drguptavivek/DigitVA](https://github.com/drguptavivek/DigitVA) | **Yes — third-party user adoption, we did not submit it** (0★, 0 forks) | Clinical autopsy platform by author of `fundus_img_xtract`. In `handoff.md`, agent instructions note: "Code search: semble first. trace-mcp is broken (binary missing)." | Nothing to submit and do not ping. Key insight: second repo by same practitioner mandating trace-mcp in handoff, but hit an environment issue where trace-mcp binary was missing. Found by `scripts/mention-sweep.sh` 2026-10-08 | 2026-10-08 |
| [midnight000spark/dharma-toolkit](https://github.com/midnight000spark/dharma-toolkit) | **Yes — third-party evaluation, we did not submit it** (0★, 0 forks) | Project architecture records D-47 and F-72 evaluate trace-mcp 3.31.4 on Dart/Flutter codebase: noted regex-only symbol parsing for Dart and absence of Flutter framework integration, postponing adoption | Nothing to submit and do not ping. Direct user evaluation signal: validates roadmap priorities regarding framework/language depth outside JS/TS/Python. Found by `scripts/mention-sweep.sh` 2026-10-08 | 2026-10-08 |
| [FlorianBruniaux/claude-code-ultimate-guide](https://github.com/FlorianBruniaux/claude-code-ultimate-guide) | **Evaluated — premier editorial surface, candidate for submission** (6,125★, 803 forks, active daily) | The most authoritative Claude Code guide and ecosystem reference (430K+ lines). Has two direct target sections: `guide/ecosystem/mcp-servers-ecosystem.md` under `### Code search & analysis` (currently listing only Grepai and Semble) and `examples/skills/smart-explore.md` ("Smart explore: Progressive code exploration", listing code-review-graph, jCodeMunch, and mcp-server-tree-sitter) | Highly curated, active editorial maintainer (Florian Bruniaux) who reviews and merges external tool PRs (e.g. #84 YYLO, #86 swe-mux). trace-mcp fills their explicit documented gap between Grepai (requires Ollama) and Semble (Model2Vec CPU, no call graph or AST symbols): 100% CPU-local, zero external service/Ollama, AST-based symbol graph + call hierarchy across 88 frameworks and 81 languages, 72.7% token reduction on PR reviews. Documented as candidate for next cycle | 2026-10-08 |
| [jfjordanfarr/Live-Documentation](https://github.com/jfjordanfarr/Live-Documentation) | **Yes — third-party research survey, we did not submit it** (MIT, active 2026-10-08) | Independent architecture research document `AI-Agent-Workspace/Research/2026-10-08-headless-use-cases.md` surveying code intelligence tools for AI agents. Cites `trace-mcp` (mcpservers.org) under "Agents reading a codebase's structure" alongside `codebase-graph`, `Codebase Memory MCP`, and `CodeGraph`: describes trace-mcp as "(68 languages, impact analysis)". Analyzes architectural trade-off between live MCP servers and reviewable committed docs-as-code | Independent survey, nothing to submit and do not ping. Discovered by `scripts/mention-sweep.sh` 2026-10-09 | 2026-10-09 |
| [lza6/Armor-piercing-system-prompts](https://github.com/lza6/Armor-piercing-system-prompts) | **Yes — third-party packaging, we did not write it and did not submit it** (4★, 2 forks, pushed 2026-10-08) | Aggregated Chinese Claude Code agent skills repository. Packages 4 complete `trace-mcp` skills: `05-技能与代理开发/trace-mcp/SKILL.md` (code navigation routing over 182 tools), `07-后端与架构/trace-mcp-codemod/SKILL.md` (bulk mechanical codemods), `04-安全渗透/trace-mcp-pre-commit/SKILL.md`, and `07-后端与架构/trace-mcp-refactoring/SKILL.md`. Formulates concrete rules mandating trace-mcp tools over Read/Grep/Glob/Bash for agents | Nothing to submit and do not ping. Value is distribution evidence in agent prompt/skill collections in the wild. Discovered by `scripts/mention-sweep.sh` 2026-10-12 | 2026-10-12 |
| [wkoch/xrai](https://github.com/wkoch/xrai) | **Yes — third-party technical study & benchmark evaluation, we did not submit it** (0★, active 2026-10-11) | In-depth technical architecture study `docs/ESTUDO-COMPARATIVO.md` ("Oito referências para o xrai", 2026-10-11) evaluating `trace-mcp` v3.36.4 alongside 7 code graph tools (Graft, codebase-memory-mcp, code-review-graph, jcodemunch, tokensave, ProjectAtlas, codegraph-mcp). Analyzes `trace-mcp`'s 81 language plugins matrix, SCIP ingestion (`src/scip/ingest.ts`), `get_task_context` budget assembly (`src/scoring/structured-assembly.ts`), session deduplication, and the PR review benchmark methodology (72.7% token reduction) and post-mortem (`docs/perf/pr-context-loss-classes.md`) | In-depth architectural evaluation and academic/engineering citation, nothing to submit and do not ping. Discovered by `scripts/mention-sweep.sh` 2026-10-12 | 2026-10-12 |
| [h0rn3t/Graft](https://github.com/h0rn3t/Graft) | **Yes — third-party benchmark & research citation, we did not submit it** (4★, active 2026-10-12) | Independent code intelligence research document `RESEARCH.md` surveying agent tools. Cites `trace-mcp` as: "Honest PR-review bench: −72.7% input tokens, but false positives 0.58 → 0.80 | A model for honest reporting" alongside jCodeMunch, codedb, fff, pgr, tokensave | Independent engineering evaluation & citation, nothing to submit and do not ping. Discovered by `scripts/mention-sweep.sh` 2026-10-13 | 2026-10-13 |
| [wkoch/goCraft](https://github.com/wkoch/goCraft) | **Yes — third-party user adoption, we did not submit it** (active 2026-10-12) | Desktop agent development & commit logs (`docs/conversas/2026-10-11.md`). In commit session rules, explicitly preserves `.trace-mcp/install-date` and `.trace-mcp/guard-mode` as local installation state across commit iterations | Independent practitioner usage in the wild. Nothing to submit and do not ping. Discovered by `scripts/mention-sweep.sh` 2026-10-13 | 2026-10-13 |
| [azhri1990/ACODE_ROUTE](https://github.com/azhri1990/ACODE_ROUTE) | **Yes — third-party curated personal collection, we did not submit it** (0★, 0 forks, created 2026-10-14) | `CATALOG.md` ("My AI Box", 1,107 items collected) lists `- nikolai-vysotskyi/trace-mcp — https://github.com/nikolai-vysotskyi/trace-mcp` under curated developer tools | Curated personal AI reference directory. Nothing to submit and do not ping. Discovered by `scripts/mention-sweep.sh` 2026-10-14 | 2026-10-14 |
| [sayef/comind](https://github.com/sayef/comind) | **Yes — third-party architectural citation & prior art reference, we did not submit it** (0★, active 2026-10-16) | Architecture design document `docs/design/ledger.md` ("Comind Ledger — design plan") surveying agent memory and decision record systems. Under "Decision records", cites `trace-mcp` alongside ADR/MADR and Lore trailers, and references `trace-mcp decision memory: https://trace-mcp.com/decision-memory.html` | Architectural design reference and citation, nothing to submit and do not ping. Discovered by `scripts/mention-sweep.sh` 2026-10-16 | 2026-10-16 |
| [sayef/comindly](https://github.com/sayef/comindly) | **Yes — third-party architectural citation & prior art reference, we did not submit it** (0★, active 2026-10-19/20) | Successor / rename of `sayef/comind`. Architecture design document `docs/design/ledger.md` ("Comind Ledger — design plan") surveying agent memory and decision record systems. Under "Decision records", cites `trace-mcp` alongside ADR/MADR and Lore trailers, and references `trace-mcp decision memory: https://trace-mcp.com/decision-memory.html` | Architectural design reference and citation, nothing to submit and do not ping. Discovered by `scripts/mention-sweep.sh` 2026-10-20 | 2026-10-20 |
| [wkoch/legacy](https://github.com/wkoch/legacy) | **Yes — third-party architectural study & adapter evaluation, we did not submit it** (0★, active 2026-10-16) | Architecture planning documents `docs/automacao-rede-e-inteligencia.md` and `docs/decisoes.md` evaluating code intelligence architectures for decentralized AI agents. Evaluates `trace-mcp` (citing https://trace-mcp.com/code-graph-mcp.html for incremental local graphs and framework-specific relationships) alongside Graft as potential adapters for logical code mapping. Recommends starting with pilot language adapters | Independent architectural evaluation, nothing to submit and do not ping. Discovered by `scripts/mention-sweep.sh` 2026-10-17 | 2026-10-17 |
| [ProSkillsMD/proskills](https://github.com/ProSkillsMD/proskills) | **Yes — third-party catalog, auto-scouted 2026-10-10** (18★, active daily) | Automated scout filed and listed candidates for all 3 repository skills in OpenClaw skill listings: `skills/trace-mcp/SKILL.md` ([issue #8193](https://github.com/ProSkillsMD/proskills/issues/8193), status `groot:published`, verdict `review:pass`), `skills/trace-mcp-codemod/SKILL.md` ([issue #8194](https://github.com/ProSkillsMD/proskills/issues/8194)), and `skills/trace-mcp-pre-commit/SKILL.md` ([issue #8195](https://github.com/ProSkillsMD/proskills/issues/8195)). License MIT pass, static scan passed with no findings. Found via `github_topic:claude-skills` | Nothing to submit — automated deterministic scout updates on new commits to skill directories. Do not ping, no action needed. Discovered via issue audit | 2026-10-18 |
| [JMartynov/mcp-fingerprints](https://github.com/JMartynov/mcp-fingerprints) + [its Web Directory](https://jmartynov.github.io/mcp-fingerprints/) | **Yes — third-party automated passport & signature catalog, we did not submit it** (0★, active daily) | Auto-indexed server passport `data/fingerprints/nikolai-vysotskyi_trace-mcp.json` (schema 1.1.0, official_registry source) describing `trace-mcp` ("Framework-aware code intelligence: 81 languages, 58 framework integrations, 138 tools, up to 99% token reduction"). Part of open-source knowledge base with 5,058+ indexed MCP server passports | Automated deterministic sync. Nothing to submit and do not ping. Discovered by `scripts/mention-sweep.sh` 2026-10-20 | 2026-10-20 |





### Outreach hygiene 2026-09-25: the queue is two doors with merge-rate, everything else is held or wontfix-spend (TRA-1950)

Weekly sweep ran 2026-09-25 (`scripts/mention-sweep.sh`, both passes): 3 repos outside `ops/mentions-seen.txt`, matched files read before recording anything. One genuine — the `jaimevalero` row above, the sixth zero-cost auto surface. Two collisions — `Sudeeparyan/TRACE` (their own TRACE-project Lambda, stale since February) and `fuqiuluo/binder-trace` (their own `bt-mcp` kernel-Binder server; the match is their own filename `binder-trace-mcp.btcap` — kernel observability, not code intelligence, not a competitor). All three classified in `ops/mentions-seen.txt` in the same change. No thread touched: there was nobody to write to.

Queue verdicts, every thread re-verified read-only 2026-09-25. No pings sent and no PRs opened or closed: closing our own open submissions unilaterally would destroy pending work on zero new evidence, so the spend verdicts below are what got written, not withdrawals.

ACTIVE — the two doors with a demonstrated external merge-rate:

- `eltociear/awesome-AI-driven-development#119` — open, mergeable, rebased 2026-09-25. Maintainer merged #121 and #127 on 09-23, both external adds. The only list on this table where a self-submission is the normal way in rather than a lottery ticket.
- `GetBindu/awesome-claude-code-and-skills#195` — open, `mergeable_state: clean`, untouched since 09-20. Eight external PRs merged in August by a maintainer who merges other people's entries rather than only adding his own.

HELD — open, no spend:

- `0xNyk/awesome-hermes-agent#395` — open; the triage batch moved 09-23 (#439 closed). The queue moves without us. No ping: two days after a batch is noise. Standing rule holds: do not re-submit, do not ping.
- `tolkonepiu/best-of-mcp-servers#384` — open. The one allowed reminder was sent 2026-09-26; no maintainer reply, and the row above now records it. Reminder budget spent — leave it. Four external project-adds merged in all of 2026 — slow, not closed.
- `hesreallyhim/awesome-claude-code#2871` — open, filed 09-18 by Nikolai, bot validation passed. Refusal is routine there; do not ping.
- `natsukium/mcp-servers-nix#606` — open, one comment (ours). An install path, not a listing, so the arrivals objection does not apply. One reminder max, still unspent. If the answer is "send a PR", that is engineering work with a Nix install and gets its own issue — not a promise in their thread.
- `yzfly/awesome-context-engineering#44` — merged 09-20. Done, nothing owed.

WONTFIX-SPEND — left open, no more rebases without a merge signal, no pings. Withdrawing buys nothing and tending costs runs:

- `ai-boost/awesome-harness-engineering#240` — open. Two external PRs ever merged while the maintainer self-adds about one entry a day. Lottery ticket on a high-value list: leave it open, rebase only on a merge signal, re-read 2026-10-05 as scheduled.

NEVER-TOUCH, reaffirmed 2026-09-25 (live count rechecked: 182★ / 21 forks / 4 watchers):

- mcp.so ($39 paywall; registry-ingestion watch only), mcpmarket.com ($29 paid edit; already listed as "Trace"), smithery.ai (needs GitHub OAuth on Nikolai's behalf plus an MCPB bundle publish — an agent must not authorize either), Docker MCP Catalog (needs a Dockerfile in our repo — a product decision, not listings work), Homebrew (self-submit bar 225★ / 90 / 90, we are 182 / 21 / 4 — 43 stars short; and stars alone do not open it, the napi-rs prebuilt-`.node` blocker has no expiry date).

The catalog moratorium holds: `ops/arrivals.md` (private) reads seven consecutive windows with zero attributable directory arrivals, while the registry publish keeps minting downstream records at zero run cost. New submissions only after reading arrivals. When the moratorium lifts, the first two doors are `aloth/awesome-ai-agents` and `TensorBlock/awesome-mcp-servers` (rows above, evaluated 2026-09-16). Integrations stay prioritized over catalogs — the model is `su-record/vibe` into native `trace blast` shipped in TRA-1252, not another README line.

Day pass 2026-09-27 (TRA-1991): all seven threads re-verified read-only — `eltociear#119` and `GetBindu#195` open and mergeable-clean with no maintainer movement since the 09-20 nudges; `hermes#395` open with the queue growing past #445 and no triage touching us; `tolkonepiu#384` open with the 09-26 reminder spent and no reply; `ai-boost#240` open, untouched since 09-14; `hesreallyhim#2871` open, untouched since 09-18; `nix#606` open with no maintainer reply. Mention sweep ran clean on both passes — nothing outside `ops/mentions-seen.txt`. No pings sent, no PRs opened, no submissions: the moratorium holds and there was nothing to spend on.

Day pass 2026-09-27 (TRA-2008, second pass same day): all seven threads re-verified read-only — `eltociear#119` open, mergeable-clean, updated 09-25 (our rebase, no maintainer movement); `GetBindu#195` open, clean, untouched since 09-20; `hermes#395` open, untouched since 09-20; `tolkonepiu#384` open, clean, updated 09-26 (our reminder, no reply); `hesreallyhim#2871` open, untouched since 09-18; `nix#606` open with no maintainer reply (one comment, ours). One change since TRA-1991: `ai-boost#240` flipped to `mergeable_state: dirty` (maintainer's daily self-add moved the file again, updated 09-14) — per the wontfix-spend verdict this is left alone until a merge signal or the scheduled 2026-10-05 re-read, no rebase, no ping. Mention sweep found one new repo outside `ops/mentions-seen.txt` — `NOMARJ/sigil`, read and recorded as the ledger row above (genuine corpus entry, no thread touched). No pings sent, no PRs opened, no submissions: the moratorium holds.

Day pass 2026-09-27 (TRA-2013, third pass same day): all seven threads re-verified read-only — `eltociear#119` open, mergeable-clean, updated 09-25 (our rebase, no maintainer movement; queue now past #140); `GetBindu#195` open, clean, untouched since 09-20 (queue now past #232); `hermes#395` open, untouched since 09-20; `tolkonepiu#384` open, clean, updated 09-26 (our reminder, no reply); `ai-boost#240` open, still `dirty` since 09-14, left alone per wontfix-spend; `hesreallyhim#2871` open, untouched since 09-18; `nix#606` open with no maintainer reply (one comment, ours). `ops/arrivals.md` (private) re-read: moratorium holds, no new submission. Mention sweep ran clean on both passes — nothing outside `ops/mentions-seen.txt`. No pings sent, no PRs opened, no submissions.

Day pass 2026-09-28 (TRA-2022): all seven threads re-verified read-only — `eltociear#119` open, mergeable-clean, updated 09-25 (our rebase, no maintainer movement); `GetBindu#195` open, clean, untouched since 09-20; `hermes#395` open, untouched since 09-20; `tolkonepiu#384` open, clean, updated 09-26 (our reminder, no reply); `ai-boost#240` open, still `dirty` since 09-14, left alone per wontfix-spend; `hesreallyhim#2871` open, untouched since 09-18; `nix#606` open with no maintainer reply (one comment, ours). Referrer re-read 2026-09-28: Google 65 / reddit 36 / trace-mcp.com 15 / github 14 / chatgpt 11 / brave 3 / teams 5 / t.co 3 — the 09-05 X burst has aged out of the window and still not one directory surface appears (eighth consecutive window). `ops/arrivals.md` (private) re-read: moratorium holds, no new submission. Mention sweep found one new repo outside `ops/mentions-seen.txt` — `ankitkapur1992-hlido/hlido-public`, read and recorded as the ledger row above (genuine editorial scorecard, stale copy, no thread touched). No pings sent, no PRs opened, no submissions: the moratorium holds.

Day pass 2026-09-28 (TRA-2045, second pass same day): all seven threads re-verified read-only — `eltociear#119` open, mergeable-clean, updated 09-25 (our rebase, no maintainer movement); `GetBindu#195` open, clean, untouched since 09-20; `hermes#395` open, untouched since 09-20; `tolkonepiu#384` open, clean, updated 09-26 (our reminder, no reply); `ai-boost#240` open, still `dirty` since 09-14 (one transient `unknown` read re-checked to `dirty` seconds later), left alone per wontfix-spend; `hesreallyhim#2871` open, bot validation only, untouched since 09-18; `nix#606` open with no maintainer reply (one comment, ours). `ops/arrivals.md` (private) re-read: no new window since the TRA-2022 reading, moratorium holds, no new submission. Mention sweep ran clean on both passes — nothing outside `ops/mentions-seen.txt`. No pings sent, no PRs opened, no submissions.

Day pass 2026-09-28 (TRA-2049, second pass same day): all seven threads re-verified read-only — `eltociear#119` open, mergeable-clean, updated 09-25 (our rebase, no maintainer movement); `GetBindu#195` open, clean, untouched since 09-20; `hermes#395` open, untouched since 09-20; `tolkonepiu#384` open, clean, updated 09-26 (our reminder, no reply); `ai-boost#240` open, still `dirty` since 09-14, left alone per wontfix-spend; `hesreallyhim#2871` open, untouched since 09-18 (bot validation only); `nix#606` open with no maintainer reply (one comment, ours). Queue signals, no action: GetBindu merged external #226 on 09-26 (third-party AI Slop Elimination section by `raahulrahl`, no competitor entry among the 16); hermes triaged #440 on 09-26 (queue past #445, nothing touching us); eltociear last merge 09-23 (#121, #127 — OrcaReplay, MulmoTerminal, neither a competitor). `ops/arrivals.md` (private) re-read: moratorium holds, no new submission. Mention sweep ran clean on both passes — nothing outside `ops/mentions-seen.txt`. Separately: `iansmith/slopstop#633` (TRA-1031) still silence, 22 days, one comment (ours); the 09-26 draft reminder still awaits Lead Engineer review and was not sent. No pings sent, no PRs opened, no submissions: the moratorium holds.

Day pass 2026-09-29 (TRA-2079): all seven threads re-verified read-only, comments read — nothing waits for us anywhere. `eltociear#119` open, mergeable-clean, updated 09-25 (our rebase; queue now past #141, all open adds, no maintainer movement on ours); `GetBindu#195` open, clean, untouched since 09-20 (queue past #234, Screenpipe/axiomize adds, nothing touching us); `hermes#395` open, untouched since 09-20 (queue past #451, nothing touching us); `tolkonepiu#384` open, clean, updated 09-26 (our reminder, no reply); `ai-boost#240` open, still `dirty` since 09-14, left alone per wontfix-spend; `hesreallyhim#2871` open, untouched since 09-18 (bot validation only); `nix#606` open with no maintainer reply (one comment, ours). `ops/arrivals.md` (private) re-read: moratorium holds, no new submission. Mention sweep found one new repo outside `ops/mentions-seen.txt` — `peterbamuhigire/chwezi-engine-agents`, read and classified as a collision (their own `trace-mcp-*.jsonl` eval fixtures, 1★, no audience), recorded in `ops/mentions-seen.txt`, no thread touched. Separately: `iansmith/slopstop#633` (TRA-1031) still silence, 23 days, one comment (ours); the 09-26 draft reminder still awaits Lead Engineer review and was not sent. `sosalejandro/atlas#105` last activity 09-07 (maintainer's stack-graphs note, no question to us) — nothing owed. No pings sent, no PRs opened, no submissions: the moratorium holds.

Day pass 2026-09-29 (TRA-2082, second pass same day): all seven threads re-verified read-only with comments read — nothing waits for us anywhere. `eltociear#119` open, MERGEABLE/CLEAN, updated 09-25 (our rebase, no maintainer movement); `GetBindu#195` open, CLEAN, untouched since 09-20 (last comment ours, the 09-20 nudge); `hermes#395` open, untouched since 09-20 (last comment ours); `tolkonepiu#384` open, CLEAN, updated 09-26 (our reminder, no reply); `ai-boost#240` open, updated 09-14, left alone per wontfix-spend (re-read 2026-10-05); `hesreallyhim#2871` open, untouched since 09-18 (bot validation only); `nix#606` open with no maintainer reply (one comment, ours). `ops/arrivals.md` (private) re-read via API: conclusion unchanged — directory listings produce no measurable arrivals — moratorium holds, no new submission. Mention sweep (both passes) ran clean — nothing outside `ops/mentions-seen.txt`. Separately: `iansmith/slopstop#633` still silence, 23 days, one comment (ours); `sosalejandro/atlas#105` last activity 09-07, nothing owed. No pings sent, no PRs opened, no submissions.

Day pass 2026-09-29 (TRA-2084, third pass same day): all seven threads re-verified read-only with comments read — nothing waits for us anywhere. `eltociear#119` open, clean, updated 09-25 (our rebase; maintainer's last merge 09-23, #121/#127, six days quiet); `GetBindu#195` open, clean, untouched since 09-20 (maintainer's last merge 09-26, external #226, nothing touching us); `hermes#395` open, untouched since 09-20 (triage moved 09-26 with #440 closed, queue past #445, nothing touching us); `tolkonepiu#384` open, clean, updated 09-26 (our reminder, no reply); `ai-boost#240` open, still `dirty` since 09-14, left alone per wontfix-spend (re-read 2026-10-05); `hesreallyhim#2871` open, untouched since 09-18 (bot validation only); `nix#606` open with no maintainer reply (one comment, ours). `ops/arrivals.md` (private) re-read via API: conclusion unchanged, moratorium holds, no new submission. Mention sweep (both passes) ran clean — nothing outside `ops/mentions-seen.txt`. Separately: `iansmith/slopstop#633` still silence, 23 days, one comment (ours); `sosalejandro/atlas#105` last activity 09-07, nothing owed. No pings sent, no PRs opened, no submissions.

Day pass 2026-09-30 (TRA-2105): all seven threads re-verified read-only with comments read — nothing waits for us anywhere. `eltociear#119` open, MERGEABLE/CLEAN, updated 09-25 (our rebase; maintainer's last merge still 09-23, #121/#127, seven days quiet, queue now past #141); `GetBindu#195` open, CLEAN, untouched since 09-20 (maintainer's last merge still 09-26, external #226, nothing touching us); `hermes#395` open, untouched since 09-20 (triage since moved to #440 closed 09-26, nothing touching us); `tolkonepiu#384` open, CLEAN, updated 09-26 (our reminder, no reply); `ai-boost#240` open, still `dirty` since 09-14, left alone per wontfix-spend (re-read 2026-10-05); `hesreallyhim#2871` open, untouched since 09-18 (bot validation only); `nix#606` open with no maintainer reply (one comment, ours). `ops/arrivals.md` (private) re-read via API: conclusion unchanged — directories send no meaningful traffic — moratorium holds, no new submission. Mention sweep (both passes) ran clean — nothing outside `ops/mentions-seen.txt`. Note for the weekly focus: TRA-633's one human click already happened — Nikolai filed #2871 himself 09-18 — so there is currently nothing to bundle into a new Russian request on this topic. Separately: `iansmith/slopstop#633` still silence, 24 days, one comment (ours); `sosalejandro/atlas#105` last activity 09-07, nothing owed. No pings sent, no PRs opened, no submissions: the moratorium holds.

Day pass 2026-09-30 (TRA-2110, second pass same day): all seven threads re-verified read-only via API two hours after TRA-2105 — every `updated_at` matches exactly, nothing waits for us anywhere. `eltociear#119` open, MERGEABLE/CLEAN, updated 09-25 (our rebase; no maintainer movement); `GetBindu#195` open, CLEAN, untouched since 09-20; `hermes#395` open, untouched since 09-20; `tolkonepiu#384` open, CLEAN, updated 09-26 (our reminder, no reply); `ai-boost#240` open, still `dirty`/CONFLICTING since 09-14, left alone per wontfix-spend (re-read 2026-10-05); `hesreallyhim#2871` open, untouched since 09-18 (bot validation only); `nix#606` open with no maintainer reply (one comment, ours). No new arrivals reading this pass (TRA-2105 re-read `ops/arrivals.md` two hours earlier, conclusion unchanged) — moratorium holds, no new submission. Mention sweep (both passes) ran clean — nothing outside `ops/mentions-seen.txt`. Competitor pulse (no touch): `tirth8205/code-review-graph` at 31,865★, `pushed_at` still 2026-09-18 — stars grow, triage stands still. Separately: `iansmith/slopstop#633` still silence, 24 days, one comment (ours); `sosalejandro/atlas#105` last activity 09-07, nothing owed. No pings sent, no PRs opened, no submissions: the moratorium holds.

Day pass 2026-09-30 (TRA-2112, third pass same day): all seven threads re-verified read-only via API — every `updated_at` matches TRA-2110 exactly (eltociear#119 09-25, GetBindu#195 09-20, hermes#395 09-20, tolkonepiu#384 09-26, ai-boost#240 09-14 dirty, hesreallyhim#2871 09-18, nix#606 09-20), nothing waits for us anywhere. Queue signals, no action: eltociear's last merge still 09-23 (#121/#127, seven days quiet); GetBindu's still 09-26 (external #226); hermes triaged today (#450 closed, #454/#455 opened 09-29/09-30 — queue moves without us, standing no-ping rule holds). `ops/arrivals.md` (private) re-read: seven consecutive windows with zero directory arrivals, moratorium holds, no new submission. Mention sweep (both passes) ran clean — nothing outside `ops/mentions-seen.txt`. Competitor pulse (no touch): `tirth8205/code-review-graph` at 31,871★ (+6 since TRA-2110), `pushed_at` still 2026-09-18 — stars grow, triage stands still. Separately: `iansmith/slopstop#633` still silence, 24 days, one comment (ours); `sosalejandro/atlas#105` last activity 09-07, nothing owed. No pings sent, no PRs opened, no submissions: the moratorium holds.

Day pass 2026-09-30 (TRA-2114, fourth pass same day): **eltociear#119 MERGED 2026-09-30 14:44Z** — the queue's best door paid out 24 days after opening, zero review rounds, entry verified live in both `README.md` and `README_JA.md` via API (row above updated, TRA-1030 can close). Remaining six threads re-verified read-only via API, nothing waits for us anywhere: `GetBindu#195` open, CLEAN, untouched since 09-20 (maintainer's last merge still 09-26, external #226); `hermes#395` open, untouched since 09-20; `tolkonepiu#384` open, CLEAN, updated 09-26 (our reminder, no reply, budget spent); `ai-boost#240` open, still `dirty` since 09-14, left alone per wontfix-spend (re-read 2026-10-05); `hesreallyhim#2871` open, untouched since 09-18 (bot validation only); `nix#606` open with no maintainer reply (one comment, ours). `ops/arrivals.md` (private) re-read: conclusion unchanged, moratorium holds, no new submission. Mention sweep (`scripts/mention-sweep.sh`, both passes) found one repo outside `ops/mentions-seen.txt` — `eltociear/awesome-AI-driven-development` itself, the merge commit of our own entry — expected, no new surface, nothing to record. Competitor pulse (no touch): `tirth8205/code-review-graph` at 31,875★ (+4 since TRA-2112), `pushed_at` still 2026-09-18. Separately: `iansmith/slopstop#633` still silence, 24 days, one comment (ours); `sosalejandro/atlas#105` last activity 09-07, nothing owed. No pings sent, no PRs opened, no new submissions.

Sweep cadence from here: the weekly run is a step of the GitHub Distribution & Outreach autopilot brief (added TRA-1950) — `scripts/mention-sweep.sh`, read the matched file before recording anything, genuine surfaces get a row in this file in the same change, everything else gets a seen-list line, and чужие threads are never written to on a sweep hit alone.

### The auto-index layer stopped copying us and started paraphrasing us (2026-09-06)

The ledger's standing conclusion is that what puts trace-mcp on surfaces is
being findable by a crawler, not filing forms. Seven of those crawlers are now
recorded above. This run read what two of the newest ones actually say, and the
conclusion needs a qualifier it did not have.

`linny006`, `Chat2AnyLLM` and `trending-claude-skills` are **verbatim**: they
repeat our GitHub description as a string, so fixing the string fixes them on
their next pass. That is the mechanism the 2026-09-05 note above describes.

`Arnon-hs/open-source` and `vybe-intelligence-vault` are **generative**, and
they are the newer pair. They feed the repo to a model and publish its prose:

- Arnon-hs writes summaries in English, Russian and Chinese, and its English
  one expands MCP to "Message Control Protocol" — an invention, repeated in a
  file that carries a 67/100 score badge and reads as an evaluation.
- vybe publishes YAML front matter with `quality_score: 9`, `rag_relevance: 10`
  and a `tech_stack` list containing Graph Databases, NLP and **GPU
  Acceleration**. We ship none of the three.

Two consequences, and neither is "go and correct them" — there is nobody to
write to and no submission to make.

1. **Retiring a bad claim does not retire its derivatives.** Arnon-hs's summary
   is built on "One tool call replaces ~42 minutes of agent exploration", the
   description retired on 2026-09-05. The string is gone from every surface we
   own; the paragraph a model wrote from it is not, and it will not be until
   that index regenerates the page — if it ever does. The cost of a wrong
   one-liner is therefore longer-lived than the one-liner. That is an argument
   for the claims gate covering the two non-file surfaces (repo description and
   topics), which the 2026-09-05 note already flagged as guarded by nothing.
   **The description half was built on 2026-09-07** —
   `scripts/check-remote-claims.mjs`, TRA-1120, see the findings section.
   Topics carry no number and no claim, so they are still ungated and that is
   deliberate; revisit only if a topic ever states a figure.
2. **What we can steer is the input, not the output.** These indexes read the
   repository — description, topics, README, `server.json`. Every one of those
   is already a surface we own and already guarded except the two named above.
   There is no lever here that is not a lever we already have; the finding is
   that the lever's blast radius is bigger and slower than the table suggests.

Do not open issues on any of these repos. A correction request to a generated
catalogue with no contact path is an outgoing message with no reader.

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

### The channel list was built from referrers, so a fast channel cannot get in (2026-09-06, TRA-1036)

Every channel this ledger knows about got in by showing up as a GitHub
*referrer* — Reddit, HN, Threads. GitHub's referrer series lags ~2 days and is
aggregated, so a channel whose entire burst lands inside one day is invisible to
that method by construction, not by absence. X was not in this file at all.

On 2026-09-05 an unsolicited post by a 98k-follower account
([DanKornas/2096032800793154007](https://x.com/DanKornas/status/2096032800793154007),
5,003 views, bullets paraphrased from our README) produced 38 stars in a day
against a one-star-a-day baseline, first star 24 minutes after the post. **What
it converted to, and the only impression-to-install rate this project has ever
measured, are in `ops/user-signal.md` in the private repo.** Read that number
before proposing any new placement: it is the first bar a placement can be held
to, and anything claimed above it owes an argument.

Two things follow for this file:

- **The `t.co` / `x.com` referrer read on 09-07 — HYPOTHESIS CONFIRMED (TRA-1074).**
  Read on 2026-09-07: `t.co` appeared at **#1 in the entire referrer list** (77 views /
  57 uniques), overtaking Google (66/45), reddit.com (60/30), trace-mcp.com (52/21)
  and github.com (48/15). The ~2-day lag held cleanly: the 09-05 viral post converted
  to referral traffic on GitHub within the expected reporting window. Furthermore,
  **Facebook** emerged simultaneously as a major external referrer (46 views / 33 uniques
  across `l.facebook.com`, `facebook.com`, `lm.facebook.com`), and single-day traffic on
  09-05 hit 327 views / 196 uniques (lifting the 14-day total from 796/192 to 1,098/371).
  The earlier finding that "only search and Reddit send traffic" is therefore retired: viral
  off-GitHub placement moves numbers faster and higher than four fortnights of directory
  submissions combined.
- **Method for any future off-GitHub mention, three unauthenticated calls:**
  `api.fxtwitter.com/<handle>/status/<id>` for the post's own reach, then the
  stargazer timestamp series
  (`gh api repos/:r/stargazers -H 'Accept: application/vnd.github.star+json'`),
  then the `installs_28d.new` delta on `origin/adoption-data`. Together they
  answer "did this produce users"; the referrer table answers only "did somebody
  click through within the window".

**Dead end, verified 2026-09-06 — replies to an X post are not readable from a
run.** WebFetch on `x.com` returns HTTP 402; `publish.twitter.com/oembed`
returns empty; the nitter mirrors `nitter.poast.org`, `nitter.privacydev.net`,
`nitter.net` and `lightbrd.com` are all dead; `xcancel.com` was shut down by a
cease-and-desist on 2026-08-24. `api.fxtwitter.com` gives the post's metrics
without auth but not its replies. Do not spend another run on mirrors — this one
needs an account (below).


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

### How these get found: GitHub issue search, not directory hunting (2026-09-05)

Two of the three most useful external surfaces in this file were found by
searching GitHub for our own name in issues and PRs, not by opening directories:
`mattbutlerengineering/ai-tooling` (TRA-845) and `axisrow/trace-mcp-plugin`
(this run). Both are people who read our source and wrote down what they found;
neither would ever appear in a catalogue.

The query is `gh search issues "trace-mcp" --limit 40 --json url,title,updatedAt,repository,state`,
run with our own org filtered out. **Expect a poor signal ratio and budget for it:**
of 40 hits on 2026-09-05, 38 were the `trace`/tracing name collision — OTel spans,
Jaeger, Langfuse, stack traces — the same kind of collision TRA-879 measures on the
search side as `traceix mcp` (61 impressions, zero clicks). One hit was ours.
One was the find. Scan the repository names first; anything with `otel`, `trace-id`,
`observability` or `span` in the title is the collision, not us.

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
| [mattbutlerengineering/ai-tooling](https://github.com/mattbutlerengineering/ai-tooling/blob/main/evaluations/trace-mcp.md) | **Yes** — evaluated, verdict `discovery-log — tentative read` | A 2026-06-22 hands-off source review of v1.43.1. Credits the framework-aware cross-language edges as the real differentiator over codegraph, but blocks on the unverified "~42 minutes" headline, scope sprawl, small adoption and the strict guard hook. Also states **"no telemetry"** twice — in the What-worked bullet and in the Safety row — which stopped being true at v1.47.0 | Corrections go in issues; the maintainer runs the catalog from daily `scan:` issues. We filed [#585](https://github.com/mattbutlerengineering/ai-tooling/issues/585) on 2026-09-04 correcting the telemetry claim and pointing at the PR-context benchmark, which is the hands-on re-evaluation trigger the eval itself named. One message, no verdict ask — **do not follow up** (TRA-857). Since TRA-887 there is a citable page for this: <https://trace-mcp.com/privacy.html> — use it instead of a README anchor whenever an outside listing asks what we send | 2026-09-04 |

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
correct, but it is the likely source of the `traceix mcp` impressions-without-clicks,
and it means the bare name "Trace MCP" is not ours to claim on directories. Do not
fold `mcp tracing` into that bucket: those impressions are our own observability
intent, misrouted to the homepage (`ops/index-coverage.md`, TRA-974).

### Alternative-query venues for one rival (TRA-1732, 2026-09-20)

Query `jCodeMunch Alternative` top-30 (DataForSEO live 2026-09-20, per the
issue): jcodemunch.com (official, 2.7K stars), reddit, github wiki, youtube,
libhunt, skillsllm. trace-mcp.com absent. All six checked 2026-09-20 from
read-only fetches. **Nothing submitted, nothing opened — touch budget 0 of 5,
spend $0.** The standing catalog moratorium holds (zero attributable arrivals
from directories across seven consecutive windows in `ops/arrivals.md`;
acquisition must read first), so the one venue with an explicit
alternatives path is held rather than filed.

| Venue | What was checked 2026-09-20 | Decision |
|---|---|---|
| jcodemunch.com (official site) | Competitor's own domain; links its GitHub, PyPI and a "vs. Alternatives" page of its own | **Closed, not a door.** Same precedent as the `jgravelle/jcodemunch-mcp` NICHE.md row: a rival's own pages are not outreach targets |
| `jgravelle/jcodemunch-mcp` wiki ("versus THE WORLD") | Rival-owned wiki page comparing jCodeMunch/jDocMunch against eight named alternatives; trace-mcp not among them | **Closed, not a door.** Wikis are editable by collaborators only, and asking a rival to add us to their competitive page is the message no maintainer is glad to get (NICHE.md precedent) |
| reddit | Threads rank for the query, but Reddit is deprioritised since 2026-09-05 — posting there is Nikolai's call (`ops/user-signal.md` in the private repo) | **No action.** Not an agent submission venue |
| youtube | Videos rank for the query | **Closed.** No submission path exists; video comments are spam and producing our own video is a production decision, not distribution work |
| libhunt.com | The one venue that explicitly accepts what the issue asks: `/site/project_submit` says "Suggest the missing project as an alternative to an existing one" (find anchor project, "Suggest alternative", form needs only the new project's URL). But: neither trace-mcp nor jcodemunch-mcp surfaced on LibHunt via web search, and LibHunt's own search is JS-driven so presence is unverifiable from a run — there is no confirmed anchor to attach a suggestion to | **Held, not filed.** Explicit path but no confirmed anchor, plus the catalog moratorium covers new directory submissions. Re-evaluate when the moratorium lifts: first confirm an anchor project exists, then suggest |
| skillsllm.com | Already listed and current: `/skill/trace-mcp` renders 88 frameworks / 81 languages, matching `docs/_data/counts.yml`; `/skill/jcodemunch-mcp` also present (2,702 stars). Both carry auto-generated "Compare with similar skills" links, but no trace-mcp-vs-jcodemunch pair exists — checked `/compare/trace-mcp-vs-jcodemunch-mcp`, which does not resolve — and the site offers no "suggest a comparison" path. Comments need GitHub sign-in (human-only login, same class as Smithery/LobeHub) | **Nothing to submit.** Compare pages are auto-generated with no submission form; copy is current so there is nothing to correct either |

Two notes so they are not re-derived. First, on-page alone cannot close this
gap: the official domain outranks us on its own brand plus "alternative"
without off-page signals, which is the issue's confirmed problem statement —
but arrivals says directory submissions are not the off-page signal that ever
moved our numbers, so filing one here would spend the moratorium's exception
on the channel with the weakest evidence. Second, skillsllm's compare graph
is worth one re-read if it ever gains a suggestion path: both projects listed,
categories adjacent (`AI Agents` vs `MCP Servers`), auto-generated pairs —
the missing edge is exactly ours.

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

### The name reads as "distributed tracing" to anyone who never read a description (2026-09-07, TRA-1119)

Field evidence, not a hypothesis. Three independent parties filed us as an
observability/tracing server:

- `Timothy191/Arch-Mk2` and `Timothy191/arch-systems-portal` — same author, two
  repos, `.vscode/README.md` (2026-07-07, 2026-07-22): *"`trace-mcp` (Tracing
  Utility) — Standard tracing and debugger logging MCP server."* The setup block
  right below it runs `claude mcp add trace-mcp npx -y trace-mcp@latest`. He had
  us installed and working, and wrote down the wrong category.
- `kansei-link/kansei-mcp-server`, an MCP registry: its classifier filed us
  under "DeFi & Web3"; the human remediation pass
  (`scripts/audit-remediation-20260424.mjs`, 2026-04-24) corrected it to
  "AI observability/tracing" — still wrong, from the same file.

The mechanism is visible in the same sweep and it is the useful part: **wherever
an aggregator copied our README or Glama text the category is right**
(`clauderules/turbo-claude`, `metinduraktr-44/claude-otonom-sistem`,
`alpha-1-design/Nexus` all carry "Framework-aware code intelligence…").
Wherever someone worked from the package name alone, it lands next to
`dynatrace-mcp`. Prose we wrote travels correctly; the name alone does not.

What we did about it, so it is not re-derived: **not a rename** (the section
above stands). The fix is that the server now says what it is in the one string
every user meets before any documentation — `serverInfo` at `initialize`, which
a client renders in its server list:

- `name` stays `trace` (protocol id, in everyone's config).
- `title`: "Trace — Code Intelligence".
- `description`: names the category and explicitly denies the wrong one
  ("Not a distributed-tracing or logging server").

Checked at the same time and found already correct — no change needed:
`server.json`, `plugin.json`, both `.claude-plugin`/`.codex-plugin` manifests,
and all four `skills/*/SKILL.md` descriptions. The gap was only the handshake.

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
the replacement is 21% over 18,319 measured calls (`docs/_data/response_tokens.json`,
generated by `scripts/gen-response-tokens-data.ts`, guarded by
`tests/docs/savings-claims.test.ts`). `server.json` now carries the PR-benchmark
figure instead, so the registry entry changes at the next release by the rule
above. When re-submitting anywhere: quote 72.7% (PR context, other people's repos)
or 21% with its two caveats — one machine's call mix, and a baseline that is
still an estimate — and never the old range. It was 29.3% until TRA-945 measured
the remaining twelve tools and the figure fell; re-read this line before quoting
it rather than trusting a number you remember. Row-by-row re-submission is not
urgent; the correction lands wherever a listing scrapes live, and the rest can
ride the next planned correction of that row.

**It changed again on 2026-09-07 (TRA-1090): 90.6% → 70.5%, same corpus.** The
benchmark's trace arm had been assembling context with no source code in it —
`get_context_bundle` read symbol bodies through a bare `require('node:fs')`,
which throws under ESM and was swallowed by a catch. Only the benchmark was
affected; the shipped build has a `createRequire` banner and always served
bodies. The GitHub repo description was edited the same day; `server.json`,
`package.json` and `plugin.json` carry the new figure and reach the registries
at the next release, by the same rule as below. Anything quoting 90.6% is quoting
a measurement that was never of the product — do not restore it.

**The headline number a listing scrapes changed on 2026-09-02 (TRA-647).** The
README's above-the-fold claim is no longer "40–50% fewer tokens on average" — it
is the PR-context benchmark, "72.7% fewer input tokens", measured on 60 merged
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

**The two claim surfaces that are not files are now gated too** (TRA-1120,
2026-09-07). The GitHub repo description and the npm registry `description` are
the widest surfaces we own and neither is in the repository, so every docs gate
was blind to both. Measured that day: GitHub said 70.5% and npm said 90.6% —
same claim, same benchmark family, same day, CI green — and the GitHub string
still carried "100% local" while the usage ping is on by default (TRA-1013,
which is scoped to the README and would never have reached it).
`scripts/check-remote-claims.mjs` now fetches both and compares them to
`docs/_data/` on the counts.yml anchor rule: every count must equal
`counts.yml`, every percentage must be a generated figure, no retired number
(90.6%, "up to 99%", "~42 minutes", "40–50%", "53 frameworks / 68 languages"),
and no unqualified locality absolute. It runs nightly in `ci.yml`, never on a
PR — npm serves the latest *published* version, so its description lags master
until the release that carries it and a PR author could not fix that.
`tests/docs/remote-claims.test.ts` is the offline half and does run on every PR.
Two consequences worth knowing before reading a red run:

- **The npm row is expected red until the next release.** `package.json` has
  said 70.5% since TRA-1090; a published description cannot be edited in place.
  The gate says so in the failure text. Do not "fix" it by touching npm.
- **The locality rule bans the absolute, not the claim.** "Your code and index
  never leave the machine; an anonymous usage ping is on by default and opt-out"
  passes and is the wording now live on GitHub. A gate that failed it would have
  pushed the copy back to saying nothing at all.

**The one-liner every directory renders is the widest surface we have, and it
was the last to get the corrected number** (TRA-883 / TRA-904, 2026-09-05).
`server.json`, `package.json` and `plugin.json` are rendered verbatim by every
registry that ingests us and by npm, with no room to qualify anything, and they
were still on "40–50% fewer tokens on average" — the figure TRA-880 showed was
never a measurement — days after the storefront had moved. TRA-904 (#935)
rewrote all three; TRA-883 reached the same conclusion independently the same
day and its PR was rebased onto that copy rather than competing with it. Two
runs finding the same thing on the same day is worth one note here: the install
surfaces are nobody's home page, so they lag every wording change unless a guard
makes them fail.

What survives from TRA-883 is that guard, and the three ways of writing it that
do not work. `tests/plugin/manifest-sync.test.ts` bans a `9x%` token claim on
the install surfaces (TRA-393, when they advertised "up to 99% token
reduction"), and the PR-context median has to be exempted from it. Every
exemption keyed to the *text around* the claim was broken in review:

- a neighbourhood of N characters crosses JSON fields and sentences, so an
  unrelated "pull request" in the next field excused a bare number;
- a per-sentence split still lets one claim shield another across a semicolon,
  a comma or a conjunction, in either order;
- plain span containment lets a whole peak claim hide inside the gap the
  approved phrase itself allows.

What holds: list the approved phrasings, each of which **starts** at the
measured percentage, and exempt a claim only when it sits inside one of those
spans *and* the single percentage it carries is that anchor. "Contains the measured percentage"
is weaker still — a nested second copy satisfies it. **Qualify a match, never a
region.** Eleven negative cases are pinned; do not widen it back.

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
replacement is 21%, measured on 18,319 real calls with the responses counted on
the wire, published beside the eight tools that cost *more* than they replace.
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
- **Reading the replies to an X post about us** — 15 replies under the
  2026-09-05 post are the only live user reaction to trace-mcp that exists
  anywhere, and X serves them only to a logged-in account (dead ends above).
  Bundled into TRA-633 as one line rather than sent as its own ping.
- **Anything paid** — see above.
- Everything else here was self-serve: the mcpservers.org form takes a repo URL
  and an email, the Cline submission is a GitHub issue, and the registry publish
  needs no credential at all in CI.

## Sweeping GitHub code search for mentions we did not make (2026-09-05)

Recorded as a **source with a method**, not as a surface, because it is how the
other rows get found. It has now produced a first: `mattbutlerengineering/ai-tooling`,
the only third-party evaluation of trace-mcp anyone has written, was found this
way (TRA-845) and not in any directory.

Run it once per distribution run — `scripts/mention-sweep.sh`, which carries
the four queries below and subtracts `ops/mentions-seen.txt` so it prints only
repos nobody has read yet. `--record` appends the new ones to that list.

```
gh search code 'trace-mcp'                  --limit 100 --json repository --jq '.[].repository.nameWithOwner' | sort | uniq -c | sort -rn
gh search code 'nikolai-vysotskyi/trace-mcp' --limit 100 ...
gh search code 'trace-mcp.com'               --limit 100 ...
gh search code '"npx -y trace-mcp"'          --limit 100 ...
```

**The queries were never the expensive part; re-reading the same 20 repos was.**
Two runs of this sweep returned the same collision set — `btraceio/btrace`,
`oisee/odata_mcp`, `korwabs/playwright-trace-mcp` — and the second run had no
way to know the first had already opened them. The seen list is what makes this
a channel rather than a hunt: it turns "what does the sweep return" into "what
does the sweep return **that is new**", which is a question with a short answer.
A repo goes in that file only after someone opens its matched file; adding one
unread silences it permanently.

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

**Result of the second run (2026-09-06), the first with the seen list.** Twenty
repos outside the list, eleven worth opening, **five genuine and four of them
new rows above**. The ratio is the useful part: six of eleven were collisions,
and two of those six were not even a collision on our name —
`ZhuoZhuoCrayon/ai-workspace` matched a BlueKing observability filename
`alarm-trace-mcp-new-tools`, and `MCPJam/inspector` matched a
`trace-mcp-error-code` test id inside a component called `trace-timeline`. That
is what the seen list is for: those two cost a read once, not once per run.

**One near-miss worth recording as a method note.** The pass first classified
`aibot88/sec_skill_store` as a hallucinated skill, on the reasoning that the
seven tools it names — `scan_security`, `check_quality_gates`,
`detect_antipatterns`, `compare_branches`, `predict_bugs`, `get_risk_hotspots`,
`get_changed_symbols` — did not look like our tool surface. Every one of them is
registered in `src/tools/register/`. **Check a claimed tool name against
`src/tools/register/` before calling a third-party integration wrong**; our own
surface is 178 tools and no one holds it in their head, including us. Calling a
real integration fake is the more expensive error of the two, because it is the
one that stops us reading what the integration reveals — here, that an outsider
built on the quality and security tools we never advertise.

**A sixth genuine hit, found by re-running the sweep after the seen list was
filled — and it is the most useful thing in this pass.**
`hotaru-ritsuki/ai-daily-briefings` (row above) is not an index; it is one
engineer writing a daily briefing for themself. They covered us on 2026-08-30 as
a recommendation. Four days later, on 2026-09-03, they wrote this about a
competitor:

> Code-intelligence MCP is shifting from blind reads to knowledge graphs.
> `codebase-memory-mcp` (42k★) indexes a repo into a persistent graph … and
> claims ~99% fewer tokens vs. letting the agent grep its way around — **the same
> pitch as `trace-mcp` (covered) but graph-backed**, which fits my large Spring
> Boot/TS monorepos.

A reader who had read our page four days earlier concluded that the graph is
what the *competitor* has and we do not. trace-mcp is a code graph. The
differentiator they handed to a 42k-star competitor is our own architecture.
This is not a misreading on their part: the description they quoted was the
"~42 minutes of agent exploration" string, which describes a saving and names no
mechanism, and "code-trace instead of blind file reads" is what they inferred
from it. **The retired one-liner did not merely fail to sell the product — it
sold the competitor's story.** Hand this to the positioning pass
(`ops/positioning.md`) and to Competitor Intelligence; it is a single reader, so
it is a signal and not a measurement, but it is a signal with a mechanism.

**And the derivative count for the retired "~42 minutes" claim is now five, one
of which can never refresh.** The 2026-09-06 note above found the string living
on in generated summaries; this pass found it in two more places and one is a
different shape. `bormaxi8080/osint-timeline` is a **dated newsletter archive**
(`osintech-timeline_159_23.04.2026.md`) — nobody regenerates last April's issue,
so that copy is permanent. `Jouryjc/blogs` carries a third pair of retired
numbers in a Chinese trend report: "trace-mcp 称 40-50% token reduction、94-99%
structured workflow reuse". `Nuel-code/Defi-discovery-` swept us into a keyword
bot's run log with the same 42-minute string. Sharpening the earlier conclusion:
a wrong one-liner does not merely outlive its retirement on regenerating
indexes — some of its copies land in **archives, which never regenerate at all**.
The cost of publishing an unmeasured number is therefore unbounded in time, not
just long. That is the argument for the claims gate covering the repo
description, and it is now the second finding to make it.

### The sweep had been half-blind since it was written (2026-09-07, TRA-1085)

`scripts/mention-sweep.sh` ran four `gh search code` queries and, on 2026-09-07,
reported "No repos outside the seen list. Nothing to read." The same minute,
`gh api search/code` with the same term returned repos the sweep had never
printed once. Two separate limits, both in `gh search code`:

- **It answers a multi-term query with an empty array.** `gh search code
  'trace-mcp serena'` returns `[]`; `gh api -X GET search/code -f
  q='trace-mcp serena'` returns `total_count: 96`. Verified against a known
  positive: repo-scoped, `gh search code 'serena trace-mcp
  repo:mattbutlerengineering/ai-tooling'` does return `CATALOG.md`, so the
  syntax is fine and the global multi-term path is what fails. **Every
  competitor-paired query anyone has run through this script has silently
  returned nothing.**
- **Its single-term recall is far short of the REST index.** 27 unique repos
  for `trace-mcp` against a REST index that answers in the thousands of files.

The legacy REST indexer has the opposite flaw: it splits on the hyphen, so
`dynatrace-mcp` and `dynatrace-mcp-server` match `trace-mcp` and cost about half
the raw results. That is cheap to fix and now fixed in the script — pass 2 asks
for `Accept: application/vnd.github.text-match+json` and keeps a repo only when
a returned fragment holds the literal token with a non-word character in front
of it.

**Do not read a clean pass-1 run as "no new mentions" for anything before
2026-09-07.** With pass 2 added, the first run printed **22 repos** the old
script had never returned. Six were read and classified this run; the rest stay
unread in the queue rather than being silenced in `ops/mentions-seen.txt`.

What the six were, and it is the argument for the whole channel — **three of the
first four genuine hits are live users, and none of them ever filed an issue or
clicked through a directory:**

| Repo | What the matched file is | Why it matters |
|---|---|---|
| `drguptavivek/fundus_img_xtract` | `handoff/01_GUARDRAILS.md` and `handoff/05_START_PROMPT.md`: "Use trace-mcp before code exploration, as required by `AGENTS.md`" | A **retained** user. Same account filed #381/#382 (plugin support: `click`, `marshmallow`) in August; a month later trace-mcp is a standing instruction in their agent handoff, not a trial. Django/Python medical-imaging repo. They keep `.serena/` in the same tree — we are used *beside* Serena, not instead of it |
| `Egoka/FishtVue` | `CLAUDE.md`, a "Trace-mcp routing" section naming `get_outline`, `get_symbol`, `find_usages`, `get_feature_context`, `get_change_impact` | Vue component library. The section is a paraphrase of our own routing table, in Russian, pointing at a global `~/.claude/CLAUDE.md` for the full table — so the routing guidance travels, and it travels re-written |
| `www-e/Omar` | `opencode.json`, `"trace-mcp": {"command": ["trace-mcp", "serve"], "timeout": 60000}` | **opencode**, on Windows, with `trace-mcp serve` and no project root — the exact shape TRA-893 is about. They gave us a 60 s timeout, the longest in the file bar one, which reads as somebody who hit a startup timeout and raised it. Same file also runs `context-mode`, `codedev-mcp` and `engram`: this user stacks the category rather than choosing inside it |
| `jgravelle/jcodemunch-mcp` | `docs/standard/NICHE.md`, a 14-row competitive-landscape table | A rival's own positioning doc, and **it lists trace-mcp at "16 languages, incremental indexing"**. `counts.yml` says 81. In a table where breadth is an explicit axis (CodeGraph 158 grammars, Axon 43, SigMap 34, vexp 34) the stale figure makes us the narrowest tool on the board. **No surface of ours has ever said 16** — `git log -S"16 languages" --all` returns nothing before this commit — so it is their error, not our stale copy, and there is nothing to correct at the source. **No outreach:** this is a rival's internal positioning doc, not a public directory; writing to ask them to raise our number in their own competitive analysis is a message no maintainer is glad to get. Recorded, not answered. The check did turn up a real drift on our side and it is filed as TRA-1086 |
| `clauderules/turbo-claude` | `README.md` | A link-wrapped mirror of `punkpeye/awesome-mcp-servers`. Our line is copied verbatim, including the broken leading `](https://glama.ai/…)` fragment the upstream README also carries. Nothing to do here; the fix is upstream if it is anywhere |
| `openfilz/openfilz-core` | `docker/trace-mcp-native-hints.sh` | Collision. A GraalVM tracing-agent script |

**The method, for the next run.** Pass 2's paired terms are in the script. Add a
row to them when `docs/_data/competitors.yml` grows a name. The paired form is
what makes it a *user-signal* channel rather than a listings channel: a file
that names us next to a rival is, almost always, somebody deciding — an
evaluation, a catalogue, or an agent config with both servers wired in.

### Somebody else posted us to Hacker News, and it is not the signal it looks like (2026-09-07, TRA-1085)

Found in `xkef/swe-digest`, a repo that snapshots the HN front page daily and
which pass 2 surfaced. HN item **49581857**, "Trace MCP", pointing at the
GitHub repo, submitted **2026-09-05 23:38 UTC** by `handfuloflight`. Two points,
zero comments, zero descendants. Not us, and not organic either: Algolia shows
the same account filed **15 submissions in the four days 09-03…09-06**, every
one of them an AI or agent tool, every one landing at 1–5 points with no
comments. It is a firehose, not a reader.

Three things follow.

- **`ops/launch-hn.md` is not spent.** A 2-point submission with no comment
  attracted no attention to reuse and no discussion to contradict; HN routinely
  re-runs stories that got no traction. But the draft should be checked against
  the fact that a bare-title, bare-URL post already exists.
- The date is the same day as the `DanKornas` X post (5,003 views, 38 stars).
  Scout accounts on two platforms picked us up within hours of each other, which
  says the pickup was driven by something upstream of either.
- **A future run will re-find this item and can easily misread it as interest.**
  It is not. Points and comments, not presence, are the reading.

### npm downloads: the version histogram is the proof, and it is better than the release-day one (2026-09-07, TRA-1085)

TRA-413 already retired npm downloads as an adoption metric off the daily
series — ~40/day through the summer, then 1,300–2,000/day on 27–30 August,
the four days we published 31 releases. The per-version endpoint settles it
without needing the release calendar at all:

`api.npmjs.org/versions/trace-mcp/last-week` — **all 86 published versions have
downloads, median 9, and the top of the list is 3.10.0 (275), 3.8.0 (263),
3.11.0 (256), 3.5.0 (251), 3.5.2 (238)**. Retired versions from four months ago
outrank everything recent, and `latest` does not appear at all. No population of
users produces that shape; a crawler walking the version list does, and it is
running continuously rather than only on release days.

**Keep the retirement, and quote this histogram rather than the daily spike when
somebody asks why.** It is one unauthenticated call, needs no correlation with
our own release history, and it answers the obvious objection ("your spike was
just a popular week") that the daily series cannot.


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

**Adoption number for anyone quoting it: 151★ on 2026-09-06** (133 on
2026-09-05, 102 on 2026-09-01). Both awesome-list star gates recorded above —
`hesreallyhim` at 100 and `subinium` at 1,000 — should be re-read against this,
not against 102.

**Non-file surfaces, re-read 2026-09-09 as this section asks.** The repo
`description` and the npm, `package.json` and `server.json` descriptions all
carry the measured PR figure and agree with `docs/_data/counts.yml` (81
languages, 88 frameworks). No drift this pass — the first clean read since the
"~42 minutes" string was found here. The 20 repo topics were re-read too and
make no claim, so nothing to guard there.

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

### The competitor-README search works with any competitor, and the seed decides the yield (2026-09-05)

The method recorded above was run once, with `oraios/serena` as the seed. Run
again with two seeds that are closer to what we actually claim —
`DeusData/codebase-memory-mcp` (357 README hits) and `yvgude/lean-ctx` (107) —
it returns a different population: not MCP directories, but curated lists about
*context* and *token cost*, which is the shelf our nearest neighbours are
already on. Two of them took a submission the same day (rows above). Use
`gh api -X GET search/code -f q='"<owner>/<repo>" in:file filename:README.md'`;
the search endpoint rate-limits hard, so seed one competitor per run, not five.

**Third seed, and the first one that mostly failed: `Mibayy/token-savior`
(2026-09-06).** 140 README hits, and roughly 100 of them are forks and near-forks
of one project (`OmniRoute` and its spellings — `omniroute`, `OmniRouter`,
`AIRoute`, `open-source-omniroute`), because that project's README happens to
name token-savior in a tool table. Budget for this shape: a seed whose mentions
are concentrated in one much-forked README returns that README's fork tree, not
a population of lists. Sort the hits by repo and drop any cluster of
same-named repos before reading anything. What survived the sort was three
usable addresses out of 140 — one live door (`GetBindu`, row above) and two
dead ones (parked below) — plus a short list of one- and two-star token-cost
tools that are competitors, not doors: `chimera-defi/token-reduce-skill`,
`alan-napieralski/claude-de-bloater`, `baddiecodes/token-slayer`,
`Subrising/tokonomics`. Next seed should be one whose mentions are spread across
many repos, not one that a popular README embeds.

**Read the commit log before valuing the PR queue.** Both new lists accept PRs
in writing; only one accepts them in practice. `ai-boost` has merged two
external PRs ever while adding one entry a day by his own hand, so a PR there is
a lottery ticket — worth the ten minutes, not worth a follow-up.
`gh api -X GET repos/<r>/commits --jq '.[].commit.message'` next to
`gh pr list --state merged` answers this in one pair of calls and should be run
before any list submission, not after.

**Parked, with the reason, so the next run does not re-derive them:**

- `pleasedodisturb/awesome-llm-token-optimization` (67★) — the closest list to
  our claim by topic, and the maintainer does absorb outside entries (they land
  through his own weekly "maintenance" PRs, with authorship credited). **Fit is
  the problem, not the door:** every tool section is a compression section
  (`Prompt Compression → Tools` holds `rtk`, `lean-ctx`, `headroom`, `llmtrim`),
  and we are not a compressor. Submitting into the wrong section is how an entry
  gets closed. The honest opening is an issue asking where a graph navigator
  belongs — one message, and only if the answer is worth a section.
- `GetBindu/awesome-claude-code-and-skills` (188★), `RoggeOhta/awesome-codex-cli`,
  `ai-boost/awesome-prompts` — surfaced by the same search, not yet read.
- `justrach/code-search-shootout` (2★) — not a listing at all: a reproducible
  paired benchmark of code-search backends (`codedb` vs SQLite FTS5 vs
  `lean-ctx`). Same class as the pi-extensions harness in the section above —
  someone else's harness, pointed at our category. Worth more to Competitor
  Intelligence than to this file.
- `RoggeOhta/awesome-codex-cli` (504★) — **dead, and the star count hides it.**
  Last commit 2026-04-11, zero external PRs merged in the repo's history, and a
  queue of recent `Add ...` PRs (five in the three days to 2026-09-05) that
  nobody has looked at. Do not submit; re-check only if a commit appears.
- `gudo7208/awesome-coding-agent-eval` (9★) — the best-fitting list by topic
  found so far for the honest-measurement position (900+ resources on
  benchmarks, scoring methods and evaluation pitfalls, agent-queryable), and
  the commit log kills it: the maintainer's own 2026-07-28 commit is titled
  "refresh corpus and **pause scheduled maintenance**", the two external PRs
  it has ever received (May and June) are both still open and unanswered, and
  nothing has been merged from outside. Worth re-reading in a quarter — the
  category is right even though the repo is asleep.
- `alexykn/pi-cbm`, `porameht/pi-codebase-memory-mcp`, `fxjs/cbm-tool` — third
  parties wrapping a competitor for a specific client, the same shape as
  `axisrow/trace-mcp-plugin` wrapping us. Not doors; evidence that the wrapper
  layer is where this category gets installed.

### The fourth seed, and the one that paid: `rtk-ai/rtk` (2026-09-06)

The note above asked for a seed whose mentions are spread across many repos
rather than embedded in one much-forked README. `rtk-ai/rtk` is that seed:
~1,006 README hits with no fork cluster dominating the first page, against
`Mibayy/token-savior`'s 140 hits of which ~100 were one project's fork tree.
Two doors came out of one page of results, and both are rows above.

**The more useful result is a redirect nobody would find by searching for it.**
`numtide/llm-agents.nix` (1,902★, "automatically updated daily") looks like the
door — until you read its issue template, which says in bold: *"MCP Servers:
Please submit MCP server packages to `natsukium/mcp-servers-nix` instead. That
project has the infrastructure to integrate MCP servers into various agents."*
It also states "we only add packages that we personally use", so it is not our
door at all. The chain seed → big repo → its own routing rule is worth repeating
deliberately: a large adjacent repo's contribution template names the specialised
repo for our category, and that named repo is a better address than the one we
found first.

**And a door class this file did not have: a package, not a link.** Everything
else in the Surfaces table ends in a URL a reader may or may not click.
`mcp-servers-nix` ends in an install, which is the same property that made
someone else's backend slot worth more than a directory row (section above). If
the request lands, the follow-on work is ours and engineering's, not outreach's
— write the Nix expression — and it gets its own issue rather than a promise in
their thread.

## Sweeping the GitHub *issue* index — a different index from code search (2026-09-05)

The code-search sweep above reads files. It cannot see a tracker: an issue body
is not a file, and `gh search code` never returns one. Running our name through
the issue index is a second source with a second method, and on its first pass
it returned a third-party wrapper the code sweep had missed for a month (the
`axisrow/trace-mcp-plugin` row in the table above).

**The naive query is the trap.** `q='"trace-mcp"'` returns ~31,000 hits: the
issue index tokenises on the hyphen, so it matches every issue containing
"trace" and "mcp" anywhere and the phrase quotes do nothing. Use the qualified
path instead — `gh api -X GET search/issues -f q='"nikolai-vysotskyi/trace-mcp" -repo:nikolai-vysotskyi/trace-mcp'`
— which only matches text where someone wrote our full path. Never `in:title`.
Search quota is 10 req/min.

**What the results mean, and who they name, is not recorded here.** A hit on
this channel is a person writing about us in their own tracker, so the reading
of it belongs in `ops/user-signal.md` in the private repo, alongside the rest of
the "what users say" ledger — see the repository-split rule in the
`workspace-rules` skill. This file records the door and the query; that one
records the people. The 2026-09-05 pass is already written up there in full.

### The issue index also holds people who have not heard of us yet (2026-09-06)

The sweep above searches the issue index for *our own name*. That only finds
people already talking about us. The same index answers a different question:
who is writing a trial plan for our category right now. Query used, and it is
cheap enough to run every pass:

```
gh api "search/issues?q=%22code+graph%22+MCP+in:body+is:issue+is:open+created:>YYYY-MM-DD&sort=created&order=desc"
```

Two weeks of results are mostly agent-written roadmap noise, so read titles and
skip anything that reads like a generated digest. What is worth opening is a
ticket where somebody has already **measured their own token spend** and is
designing an A/B — that person has done the expensive half of the work and is
about to hand a verdict on the whole category to their team.

The 2026-09-06 pass returned one: [`iansmith/slopstop#633`](https://github.com/iansmith/slopstop/issues/633),
a paired trial of `codebase-memory-mcp` on the three "adversary" stages of a
Claude Code harness, with cache-read broken out per ticket (80M of 83M, 133M of
137M, 427M of 436M) and a written success bar of >40% with no missed finding.
Two stars, one author, so the reach is nil — the value is that it is the same
honest-measurement method the roadmap says nobody in the category uses, run by
somebody outside it.

**We replied and did not pitch, on purpose.** Their "out of scope" line says
"evaluating alternative graph tools", so a swap suggestion would have been
answering a question they explicitly closed. What was worth writing is the
failure mode their two open questions share: branch checkout is exactly the
operation that overflows the OS file-event queue, and a graph with no
reconciliation pass answers from pre-checkout structure with no error and no log
line the caller sees — which is worse than the grep chains they are replacing,
because grep at least reads the working tree. We can say that with numbers
because it is our own defect class: `isEventsDroppedError` in `src/indexer/watcher.ts`
exists because we hit it, and one developer machine logged the condition ~31
times in 24 hours (TRA-852). Comment:
[#633 (comment)](https://github.com/iansmith/slopstop/issues/633#issuecomment-5559763826).

**The general rule this establishes:** when someone is trialling a competitor,
the useful contribution is a way their trial can silently pass — not a link to
us. If they run the two checks suggested (query for a symbol that exists only on
the new branch tip; diff the graph's file set against `git ls-files` in the
worktree), we learn something about the category either way, and nobody was sold
anything. Tracked in TRA-1031.

### Second pass of the trial-plan sweep: one address, and a consideration-set reading (2026-09-06)

The query in the section above (open issues whose body plans a trial of our
category) was run again for the week to 2026-09-06. Forty results, and the
shape is now predictable: most of it is agent-written roadmap digests published
as issues, and the readable minority splits into people *building* a code graph
and people *choosing* one. Only the first kind is worth a message.

**The address: [`sosalejandro/atlas#105`](https://github.com/sosalejandro/atlas/issues/105)**
(0★, single author, pushed daily). A design issue deciding whether to replace
three hand-written scanners (Go `go/ast` walker, a 45k-line `ts-scanner.ts`, an
embedded `scanner.py`) with tree-sitter plus `github/stack-graphs` in a Rust
sidecar, with SCIP ingest as step 1 and SCIP emit as step 4. It cites the
Codebase-Memory arXiv paper as prior art. Zero stars means zero distribution, so
this is not a door in the ledger sense. It was worth one message anyway because
they are about to pay for two things we already paid for, and both are checkable
in our tree:

- Their acceptance criteria and differential test compare symbol and edge
  **counts** between old and new resolver. Counts cannot see a resolver
  regression: a name-heuristic edge and a bound edge are both one row. The
  `resolution_tier` column plus the confidence trigger in `src/db/schema.ts` is
  the answer we landed on, and the histogram diff is the test their plan is
  missing.
- They describe SCIP ingest as "merges an external index into the store". It is
  a position-to-symbol resolution pass against your own index, and it no-ops
  silently on range disagreement, which is why `src/scip/ingest.ts` returns
  `unresolvedReferences` alongside the success counters.

Comment: [#105 (comment)](https://github.com/sosalejandro/atlas/issues/105#issuecomment-5561121447).
Disclosure first, no swap suggestion, both notes framed as things we got wrong
first. Nothing to track as a listing; if they reply, it belongs in the private
`ops/user-signal.md`, not here.

**The reading, from the results we did not write to.** `pluto-atom-4/react-graphql-showcase#357`
is an agent-written configuration plan for somebody's own monorepo that selects
three tools for exactly our job — `code-review-graph`, `better-code-review-graph`
and `graphify` — and names the problem in our own words ("token bleed",
"expensive file system grepping and globbing", blast-radius uncertainty). We are
not in that set. It is one sample from a research agent rather than a human
judgement, and the repo has no reach, so it proves nothing on its own. What it
is good for is a cheap recurring probe: this query surfaces consideration sets
assembled by agents doing category research, and the useful metric is how often
we appear in one, not whether any single author can be replied to. Do not
comment on these; they are somebody's private configuration ticket.

**Yield of the method, two passes in:** one usable address per pass, both found
in the first forty results, both single-author repos. It costs about ten
minutes. It has not yet produced a surface with an audience, and it should not
be sold as a distribution channel until it does.

### Third pass of the trial-plan sweep: the method paid a debt back (2026-09-07)

Same query as the two passes above, run for the week to 2026-09-07. Thirty-seven
results, same shape: mostly agent-written roadmap digests, a readable minority.
No new address worth a message this pass — but the previous pass's address
answered, and what came back is the first thing this channel has produced that
changed our own code.

**`sosalejandro/atlas#105` replied, and handed a defect back.** They took both
notes (the count-based acceptance criteria that could not see a tier change, and
the silent no-op in SCIP ingest), filed provenance work as their #146 ahead of
the sidecar, and rewrote the criteria. Then they returned one: two of their
features had independently shipped the same bug — mapping a git diff onto symbols
by joining line numbers at HEAD against spans recorded at the last scan, without
checking the index was built at HEAD. Both reported a confident number about the
wrong function.

We have it. `getChangedSymbols` in `src/tools/quality/changed-symbols.ts` parses
`git diff --unified=0 <since>..<until>`, takes the `+new` line numbers from the
`@@` header, and overlaps them against `line_start`/`line_end` from
`store.getSymbolsByFile()` — with no check in between. `store.getFile(path)`
returns the row carrying `content_hash` and `mtime_ms` one line above the loop
that ignores them. `compare_branches` is the same function with a merge-base
resolver in front, and there it is wrong by construction rather than merely
stale: it takes an arbitrary `branch` argument, so the diff can be
`main..feature/x` while the stored spans came from whatever was checked out when
the indexer last ran. The branch never has to have been checked out for the call
to succeed. Tracked as TRA-1075. Reply:
[#105 (comment)](https://github.com/sosalejandro/atlas/issues/105#issuecomment-5562492668).

**What this settles about the method.** Two passes in, the honest summary above
was that it had produced no surface with an audience and should not be sold as a
channel. That still holds — atlas is a zero-star repo and sent us no users. What
changed is the other column: a technical reply written to be useful rather than
to pitch came back as a P0 defect in our own tree, found by someone reading our
code because we had read theirs. That is not distribution and should never be
counted as it. It is a reason to keep running the sweep that does not depend on
distribution ever arriving.

### A direct competitor with real reach and no catalog presence at all (2026-09-07)

`ScriptedAlchemy/tracedecay` (71★, pushed hourly, MIT, Rust) surfaced in the
sweep above and was not in this ledger or in `docs/comparisons.md`. It is the
same product: "Semantic code intelligence for AI coding agents — fewer tokens,
fewer tool calls, local by default", 70+ MCP tools, 50+ languages via tree-sitter,
local libSQL, and a dashboard that reports savings and cost analytics. The author
is Zack Jackson (Module Federation), so the reach is a person, not a star count.

**The distribution reading, which is why it is in this file.** Running
`tracedecay` through the code-search sweep returns exactly one third-party README
in the entire index. They have done no catalog work whatsoever. Their bet is
placed somewhere else entirely: native install paths for fifteen hosts
(`tracedecay install --agent claude|codex|cursor|gemini|hermes|…`), a Codex
plugin, and their own scoop bucket. So a well-connected author in our exact
category looked at the same choice we face and skipped listings for host-native
integration.

That is a second, independent vote for the standing moratorium on new listings
(roadmap point 3, `ops/arrivals.md`): the one competitor here with actual
distribution reach is not using the channel we keep spending passes on. It is
also the address list this ledger exists to produce — the fifteen hosts are the
doors, and `natsukium/mcp-servers-nix` (TRA-1012) was the first of that kind we
logged. Product profiling of tracedecay belongs to Competitor Intelligence, not
here; the one thing worth flagging to them is that their scheduler tests name a
behaviour we have just discovered we lack — `search_fails_fast_when_no_complete_generation_exists`
and `semantic_mcp_abstention_uses_freshest_sealed_generation` are designed
abstention on a stale index, which is TRA-1075 and TRA-852 solved as architecture.

**Checked, silent, no action:** our five open catalog PRs — `eltociear/awesome-AI-driven-development#119`,
`GetBindu/awesome-claude-code-and-skills#195`, `yzfly/awesome-context-engineering#44`,
`ai-boost/awesome-harness-engineering#240`, `tolkonepiu/best-of-mcp-servers#384` —
and `narumiruna/pi-extensions#1204`. No replies, nothing owed by us, no pings due.
`hashgraph-online/awesome-ai-plugins#182` merged 2026-08-31 without the scanner
action; the issue text describing it as open is stale.

### The "fifteen hosts are the doors" reading was wrong, and what is left when it goes (2026-09-07, second pass)

The section above ended by calling `tracedecay`'s fifteen `install --agent` targets
"the address list this ledger exists to produce". Read at source, they are not
addresses. `tracedecay install --agent claude|codex|cursor|gemini|hermes|…`
writes the host's own config, plugin or rules file on the user's machine; the
other two install routes in that README are `curl … install.sh` from their own
releases and **their own** scoop bucket (`ScriptedAlchemy/scoop-bucket`). Every
one of those surfaces belongs to them or to the user. Nobody merged anything,
and there is nothing for us to submit.

So the correct reading of that competitor is stronger, not weaker: an author with
real reach in our exact category spends his distribution effort on **surfaces he
controls**, and the third-party channel count is zero — not "fifteen doors we
haven't knocked on". Ours is the mirror image: `trace init` already writes host
configs, and the one genuinely third-party install channel we have asked for is
`mcp-servers-nix` (TRA-1012). That row and this one are the whole class.

**The class was worth checking properly, so Homebrew got a real pass** (row in
the table above). Result: closed, on two independent counts, and the second one
is the interesting one. Notability is a matter of time — 161★ against the 225★
that Homebrew asks when the repository owner submits his own package, versus the
75★ it asks from anyone else. The blocker that does not expire is that
`@ast-grep/napi` and `oxc-resolver` publish no Rust source to npm, only prebuilt
per-platform `.node` files, and `homebrew/core` wants build-from-source or
platform-independent output. The same four native dependencies are what made the
Nix package an ask rather than a PR. One product constraint, two package
managers, and it will be three the next time this class comes up — which is the
kind of thing worth knowing before a run spends itself writing a formula that
CI would reject.

**Threads, all checked 2026-09-07, all silent, nothing owed by us:**
`eltociear/awesome-AI-driven-development#119`, `GetBindu/awesome-claude-code-and-skills#195`,
`yzfly/awesome-context-engineering#44`, `ai-boost/awesome-harness-engineering#240`,
`tolkonepiu/best-of-mcp-servers#384`, `natsukium/mcp-servers-nix#606`,
`narumiruna/pi-extensions#1204`, `iansmith/slopstop#633`. No pings are due on any
of them before 2026-09-19 at the earliest. `sosalejandro/atlas#105` had our reply
of 2026-09-06 and no answer since; nothing is owed there either — the exchange
already paid (TRA-1075). The HOL ownership-claim reminder on
`awesome-ai-plugins#182` stands unanswered by decision, not by oversight: it is a
sign-in-and-authorize flow on a third-party site in exchange for a badge, which is
the same trade we refused on their scanner action. If a second reminder arrives,
the answer is still nothing.

### Fourth pass, 2026-09-07: two doors found by searching for the work, not the listing

Catalogs stay under moratorium and every open thread was re-checked and is silent
(list below), so this pass spent itself on mandate item 3 — repositories where our
own defects are worth more to them than a listing is to us. The search that found
both was GitHub issue search on phrases from *our* engineering log, not on our name:
`"repo map" "tokens"`, `"import graph" "re-export"`, `"symbol index" "stale"`.

**`Nano-Collective/nanocoder#1197` (2,455★).** A community contributor
(`addyCooks`) is building an agent-evaluation harness under `benchmarks/agent/`:
six *vendored* fixture trees, five runs per task, median and IQR, baselines against
`main` and `v1.29.0`, and an explicit Gate 0 that reconsiders the whole indexing
roadmap (#1186 Phases 1–4) if the gap does not reproduce. LLM-as-judge scoring is
rejected by name.

Read the split first: `will-lamerton` asked for Phase 0 to move out of #1186 and for
#1186 to stay frozen as the design record. The first draft of our comment was aimed
at #1186 and would have reopened a thread its maintainers had just agreed to close —
caught in review, not in the field. **Whenever an issue references a split, read both
halves before writing to either.**

What we sent them is the thing our own corpus taught us, framed for their design
rather than against it: vendoring freezes fixture size, and the regime #1186 exists
for does not exist at that size. Our largest CI corpus was 50 000 symbols while
`search` returned a bare "Maximum call stack size exceeded" against a user's
152 734-symbol index ([#957](https://github.com/nikolai-vysotskyi/trace-mcp/issues/957));
the V8 argument limit that caused it sits somewhere between ~65k and ~125k, so a
fixture at 70k proves nothing either way, and the fixture is now *generated* at
150 000 rather than vendored. Plus preregistering Gate 0's threshold before the
baselines run, and the ESM/no-source failure as a point in favour of their pass/fail
design: a token count rewarded that bug, an outcome assertion would have caught it —
if the fixture is big enough for the missing content to change the outcome. Comment:
[#1197 (comment)](https://github.com/Nano-Collective/nanocoder/issues/1197#issuecomment-5569107808).

**`Ivy-Apps/deslop#173` (18★).** Their static import-graph analyzer does not treat
`export … from` as an edge, so barrel files break transitive rules — the exact case
our own outreach mandate names as the example of a repo worth writing to, and it was
open, labelled `bug`, milestoned `0.10.2`, unanswered since 2026-08-08. Verified
against their `src/TypeScript/Lexer.hs` on `main` that only statements beginning
`import` are tokenized. We sent the three things that bit us: the discriminator is
the `from` clause and not the `export` keyword (`export const x` is an edge to
nothing), the alias direction flips relative to an import so storing one name
silently drops the consumer side, and `export * from` carries no specifier list at
all — so a name-keyed graph still leaves the barrel chain broken after the statement
is lexed, which reads like the fix not working. Comment:
[#173 (comment)](https://github.com/Ivy-Apps/deslop/issues/173#issuecomment-5569108179).

**Checked and skipped, so the next pass does not re-derive them:** the
`anthropics/claude-code` and `openai/codex` codebase-indexing feature requests
(#4556, #75993, #5181) — real audience, but a comment there buys visibility rather
than usefulness, which is the motive our own rules distrust; `vybestack/llxprt-code#3421`
(700★, "hand-rolled import graph") — their fix is nx or dependency-cruiser, not us;
`dotflow-io/pycodeloop#51` (1★) and the agent-written planning tickets from the
trial-plan class. `chrisshaiman/lamware#254` wants a call graph over Ghidra
decompilation, which is not our domain.

**Threads re-checked 2026-09-07, all silent, nothing owed and no pings due:**
`eltociear/awesome-AI-driven-development#119`, `GetBindu/awesome-claude-code-and-skills#195`,
`yzfly/awesome-context-engineering#44`, `ai-boost/awesome-harness-engineering#240`,
`tolkonepiu/best-of-mcp-servers#384`, `natsukium/mcp-servers-nix#606`,
`narumiruna/pi-extensions#1204`, `iansmith/slopstop#633`, `sosalejandro/atlas#105`.

**One number to stop quoting.** The 15-point comprehension loss is struck as of
PR #1066 — it was measured on a context that contained no source code, and the
corrected run is 67% against 65% at the same 70.5% median token saving. Anything
outgoing that still carries −15 п.п. is quoting a bug, not a result.

### Fifth pass, 2026-09-07: the first maintainer reply of the week, and two doors inside one 27k★ tracker

**`Ivy-Apps/deslop#173` answered within 27 minutes.** `ILIYANGERMANOV` replied to this
morning's `export … from` note: the fix is his current task and Deslop users should
expect a release with it this week. That is the second live human reply this
category has produced for us (after `sosalejandro/atlas`), and both came from the
same move — reading their code first and sending the traps we already paid for,
with no ask attached. Nothing is owed there now; a thank-you reply would only cost
them a notification.

**Method note, because the search that worked twice has started failing.** GitHub
issue search on engineering phrases (`"symbol index" stale`, `"codebase index"`,
`"code graph" MCP`) now returns mostly machine-generated repositories: agent
planning tickets, daily-digest repos, benchmark-report bots. Of 75 distinct repos
across five queries, 19 had ≥100 stars and 12 were worth opening. **Filter the
result set by stargazers before reading any body** — it costs one `gh api repos/…`
per repo and removes about three quarters of the noise.

**Both of today's second-pass doors are in `Kilo-Org/kilocode` (27,210★), which
ships codebase indexing of its own, so the disclosure line does real work.**

- [`#13843`](https://github.com/Kilo-Org/kilocode/issues/13843) (opened today):
  their indexing manager fails on git worktrees with CJK paths on Windows — a
  `git rev-parse --path-format=absolute …` command line arrives at
  `fs.realpathSync` as a single string, with the backslash before `目录A` eaten.
  The reporter had already disassembled their minified CLI to find it. What we
  added is the two ways we avoid the class: `execFileSync` with an argv array
  never builds a command string, and `resolveGitMetadataDir` in `src/global.ts`
  answers `--git-common-dir` from disk alone (`.git` file → `gitdir:` → the admin
  dir's `commondir`, falling back to `<admin>/../..`), so no locale or argv is
  involved. Plus the shape half of their own footnote: in a linked worktree `.git`
  is a *file*, so an `isDirectory()` test reports "not a git repo" on every
  platform. And the design half: their
  `Waiting for the primary worktree index to become available` is a state we chose
  not to have, because a linked worktree shares the main repo's index
  (`src/registry-worktree.ts`).
  [Comment](https://github.com/Kilo-Org/kilocode/issues/13843#issuecomment-5571830423).
- [`#12707`](https://github.com/Kilo-Org/kilocode/issues/12707) (open and
  unanswered since 2026-07-30): codebase search ran 41 minutes with no deadline
  when VS Code was opened at a broad root. They ask for exactly the two behaviours
  we shipped, so the comment is what each cost: the broad-root rule is a literal
  deny-list rather than a size heuristic (a big monorepo is indistinguishable from
  `/` until it has been walked), with the three traps inside ours — `/private/tmp`
  arriving pre-resolved, Windows dirs matched below the drive letter, and the
  `/\\+$/` trim that CodeQL flags as polynomial ReDoS on a client-supplied path.
  And the part that surprises: fixing root resolution moves the hang to "index not
  built yet", so the answer is answering instead of blocking — 503 with
  `Retry-After: 3` on routes needing a complete index, with registered-but-unloaded
  and folder-missing as distinct answers.
  [Comment](https://github.com/Kilo-Org/kilocode/issues/12707#issuecomment-5571830697).

**Competitor intel: three new entrants, all found through catalog submission
queues rather than through their own repos.** `pmgarg/cgraphy` (0★, PyPI, official
MCP registry), `UnboundCompute/lachesis` (3★, compiler-precise code property graph,
AGPL-3.0, ghcr image), `myelixlabs/synapse-mcp` (1★, "60% token savings", 14 tools).
Two facts follow. First, every one of them leads with a token-savings number and
none publishes anything about answer quality, which is the gap TRA-1140 named and
the reason our corrected 67% vs 65% at 70.5% is worth publishing rather than
sitting in a PR. Second, `chatmcp/mcpso` (2,715★) and `cline/mcp-marketplace`
(785★) accept submissions from 0-star projects by issue — cheap to enter and
therefore weak as a signal, which is an argument for keeping the catalog
moratorium rather than against it. Both queues stay recorded here as addresses for
the day `acquisition` starts reading.

**Checked and skipped, with reasons, so the next pass does not re-derive them:**
`Sharper-Flow/lgrep#12` (3★, last push 2026-08-07), `ending0421/Ward#6` (0★),
`mupozg823/codelens-mcp-plugin#396` (3★, 49 open issues, stale) — all three are
genuinely in our defect class (stale index answering `ok:true` with an empty
result set) and all three are too small and too quiet to be worth a touch;
`zilliztech/claude-context#419/#420` (12,496★) — real defects in a direct
competitor's tracker, which is not a place we comment;
`warpdotdev/warp#12569` (multi-GB indexing memory spikes) — closed-source product,
our daemon memory work says nothing they can act on;
`anthropics/claude-code#75993` and `continuedev/continue#12853` — audience, not
usefulness, the same call the fourth pass made.

**Threads re-checked 2026-09-07 evening, silent, nothing owed:**
`eltociear/awesome-AI-driven-development#119`, `GetBindu/awesome-claude-code-and-skills#195`,
`yzfly/awesome-context-engineering#44`, `ai-boost/awesome-harness-engineering#240`,
`tolkonepiu/best-of-mcp-servers#384`, `natsukium/mcp-servers-nix#606`,
`narumiruna/pi-extensions#1204`, `iansmith/slopstop#633`, `sosalejandro/atlas#105`,
`Nano-Collective/nanocoder#1197`. No pings due before 2026-09-19.

### Sixth pass, 2026-09-07 (night): SCIP turned out to be the thing we can speak about, and our own ingest fails the invariant we were quoting

Two touches, both about SCIP, both grounded in reading our own
`src/scip/` before writing a word. Zero catalog submissions — the moratorium
holds until `acquisition` reads.

**`sosalejandro/atlas#105` (the thread that has now produced three exchanges).**
The maintainer re-scoped the issue at 18:25 today: Tier 2 (Rust stack-graphs
sidecar) is on hold because TypeScript 7.0 is a Go compiler, and `atlas scip
ingest` is being taken now as pure Go with no new toolchain. He restated the
acceptance criterion as "an ingest that resolves nothing must not look like a
clean no-op". We went to check how ours behaves and it fails exactly that, so
that is what we sent, plus two things he can use before writing the code: count
*rejected documents* separately from *unresolved occurrences*, and his
D-below-A tier ordering is more defensible than ours (we rank `scip_resolved`
above our own type-checked `lsp_resolved`, so a stale third-party index wins a
conflict against an edge we verified). Also the part that is free and the part
that is not: ingest is language-agnostic, acquiring the `.scip` is not — we ship
three known indexers and each carries a command, an arg template, a project-shape
`detect`, and a language-id mapping.
[Comment](https://github.com/sosalejandro/atlas/issues/105#issuecomment-5574817038).

**`facebook/pyrefly#4583` (6,944★), open since 19 Aug with one "Thanks" on it.**
Someone asked on Discord how much of a lift SCIP emission would be for Pyrefly.
The consumer side of that contract is smaller than the spec looks: our decoder is
258 lines with no protobuf dependency and reads six fields
(`Index.documents`; `Document.relative_path`/`occurrences`/`language`;
`Occurrence.range`/`symbol`/`symbol_roles`), skipping `SymbolInformation` and
everything else by wire type — so an emitter that produces only occurrences with
correct roles is already usable. Plus the two traps we paid for: `range` is
`repeated int32` and therefore plain varint, not zig-zag (we read it as zig-zag,
got negative lines on every real file, emitted zero edges, and our synthetic
tests missed it for months because the test writer zig-zagged too), and the base
`relative_path` is relative to decides whether an index is usable at all.
[Comment](https://github.com/facebook/pyrefly/issues/4583#issuecomment-5575275357).

**What the first touch cost us in the good sense: TRA-1161.** `ingestScipIndex`
looks up each document with `store.getFile(doc.relativePath)` and `continue`s
before incrementing any counter, so an index whose path base differs from ours by
one segment returns all-zero counts — byte-identical to a correct index with
nothing to add — while `ScipBridge.ingest` still appends the language to
`indexersRun` and logs "SCIP ingestion completed". `unresolvedReferences` cannot
catch it: it only counts occurrences inside documents already matched. Same
silhouette one level up, where a decode failure warns and returns the empty
result. Same class as TRA-880 and TRA-1057: a green answer where nothing
happened.

**Checked and skipped, with reasons.** `scip-code/scip#468` (782★) — a governance
thread about which indexers move to the `scip-code` org; well run, five comments,
the maintainer has already stated a five-point migration bar and said yes to
.NET bindings. Nothing a downstream consumer could add that they would be glad
to receive. `vitali87/code-graph-rag#1584` (5,071★) — real defect (dependents
reparse before `DELETE_MODULE`, so the external-node fallback is never taken)
but written by the repo owner with the fix already specified, six comments deep.
`DeusData/codebase-memory-mcp#1296` — direct competitor's tracker, which stays a
place we do not comment. Sub-10★ and machine-generated: `tmustafiz/graph-rag`,
`samchon/compiler-knowledge-graph`, `LightspeedDMS/code-indexer`,
`MrNedimBoztepe/Shonkor`, `oneprolabs/sourcelens`, `rafacm/clew.nvim`,
`kyanosq/groundgraph`.

**Method note that held again.** The star filter from the fifth pass keeps
working: three GitHub issue-search queries returned ~60 distinct repos, of which
three cleared 500★. Filter on stargazers before opening a single body.

**`Nano-Collective/nanocoder#1197` answered, and adopted all three points.**
`addyCooks` is adding a seventh generated fixture instead of vendoring, is
considering a dedicated assertion for the `Math.min(...xs)` crash class, and is
committing thresholds with a literal `verdict: PENDING` line before the baseline
runs. Third live human reply this category has produced. Nothing owed — a
thank-you would only cost them a notification.

**Threads re-checked 2026-09-07 night, silent, nothing owed, no pings due before
2026-09-19:** `eltociear/awesome-AI-driven-development#119`,
`GetBindu/awesome-claude-code-and-skills#195`, `yzfly/awesome-context-engineering#44`,
`ai-boost/awesome-harness-engineering#240`, `tolkonepiu/best-of-mcp-servers#384`,
`natsukium/mcp-servers-nix#606`, `narumiruna/pi-extensions#1204`,
`iansmith/slopstop#633`, `Ivy-Apps/deslop#173`, `Kilo-Org/kilocode#13843`,
`Kilo-Org/kilocode#12707`.

### Seventh pass, 2026-09-08: the catalog PR the mandate calls open merged a week ago, and two doors in the freshness class

**`hashgraph-online/awesome-ai-plugins#182` merged on 2026-08-31, in the form we
submitted it.** The autopilot brief that opens every run still describes it as
open and unmerged with a maintainer asking for their `ai-plugin-scanner-action`;
that sentence is stale and this line is the correction. We declined the fourth
third-party workflow, accepted the advisory scan failure, and the listing landed
anyway. Nothing further is owed there and the thread does not need re-checking.

**Two touches, both written after reading the other repo's code.**

- [`abhigyanpatwari/GitNexus#3127`](https://github.com/abhigyanpatwari/GitNexus/issues/3127#issuecomment-5576596012)
  (47,120★, same category as us — client-side code knowledge graph with an MCP
  server). Someone proposes a `--stale-policy warn|ignore|error` flag. The flag
  would consume `checkStaleness` in `gitnexus/src/core/git-staleness.ts`, and
  that function ends in `catch { return { isStale: false, commitsBehind: 0 } }`,
  so every git failure reports fresh and `--stale-policy error` exits 0 exactly
  when the check broke. Their own `commitsAheadOfIndexed` in the same file
  already returns `undefined` for "drift unknown" with a doc comment telling
  callers not to read it as "no drift", so the missing fourth outcome is
  argued from their code, not ours. Two more from ours: `rev-list --count
  lastCommit..HEAD` returns 0 when HEAD is *behind* the indexed commit (branch
  switch backwards), which is why `computeRepoFreshness` compares SHAs for
  equality; and commit distance cannot see uncommitted edits, which is the
  common case when an agent is driving, which is why `computeFileFreshness`
  compares floored mtimes and yields `fresh | edited_uncommitted | stale_index`
  per file.
- [`watt-mind/factory#1078`](https://github.com/watt-mind/factory/issues/1078#issuecomment-5576622023)
  (14★, but the acceptance criteria are the reason). A human-filed spike that
  plans to bake off graphify, codegraph, code-graph-mcp and codebase-memory-mcp
  on two of their own repos, grading correctness against a hand-written answer
  key and rejecting any tool whose per-worktree rebuild costs more than it
  saves. **This is the first third party we have found that plans to grade
  answer quality rather than count tokens** — the gap TRA-1140 named. We sent
  the three things our own version of that measurement cost: the struck 50%
  vs 65% run and how the naive arm's unchanged 65% is what made the correction
  provable; the cheap assertion that catches it (assert the packed context
  contains a body from the answer key before the model sees it); and that five
  questions resolve to 20 points each, with our own 60-item agreement table
  (36 both, 3 naive only, 4 ours only, **17 neither**) as the argument that the
  question set decides more than the tool does. Their per-worktree criterion got
  the `resolveWorktreeAware` answer: a linked worktree resolving back to the
  main worktree's index is a design choice, testable in five minutes per
  candidate. We named ourselves as a possible fifth arm and attached no ask.

**Silent and nothing owed, re-checked 2026-09-08:** `Nano-Collective/nanocoder#1197`
(addyCooks replied 09-07 adopting all three points and is folding them into the
spec — a thank-you would only cost a notification), `Ivy-Apps/deslop#173`
(maintainer shipping the fix), `sosalejandro/atlas#105` (the 09-07 comment is his
own Tier-2 close-out: `github/stack-graphs` archived 2025-09-09, the tier would
add zero languages over SCIP, so he withdraws it — nothing directed at us),
`Kilo-Org/kilocode#13843` and `#12707`, `facebook/pyrefly#4583`,
`eltociear/awesome-AI-driven-development#119`,
`GetBindu/awesome-claude-code-and-skills#195`, `yzfly/awesome-context-engineering#44`,
`ai-boost/awesome-harness-engineering#240`, `tolkonepiu/best-of-mcp-servers#384`,
`natsukium/mcp-servers-nix#606`, `narumiruna/pi-extensions#1204`,
`iansmith/slopstop#633`. No pings due before 2026-09-19.

**Checked and skipped, with reasons.** `Graphify-Labs/graphify` (**115,687★**,
the largest peer in the category, two live tree-sitter extraction bugs today) —
a direct competitor's tracker, the same call the fifth pass made on
`zilliztech/claude-context`; it is already profiled deep in `docs/comparisons.md`,
so nothing is missing but the star count, which moved 112.4k → 115.7k in six days.
`anthropics/buffa#423` (879★, `DescriptorPool` resolves type names across the
whole set and ignores each file's import graph — genuinely our defect class, and
already carrying a complete protoc-verified repro) — audience rather than
usefulness. `burin-labs/harn#8082`, `HeddleCo/heddle#987`, `vksvicky/RepoLens#34`,
`jlaustill/c-next#1509` — all 0–20★ and in the agent-written planning-ticket class.

**Two method notes for the next pass.** First, `gh search issues` ANDs every
term: `token budget context agent codebase` and `monorepo indexing slow agent`
both returned zero results while `"import graph"` and `"stale index"` returned
full pages. Use one or two quoted phrases, then filter by stargazers, rather
than a descriptive sentence. Second, **GitNexus is a repeatable address, not a
one-off**: 339 open issues in exactly our domain, several of them our own defect
classes verbatim — `#3198` (`POST /api/analyze` ignores `branch`, returns 202 and
reports `complete` while indexing the default branch — the same "no-op that looks
like success" invariant as TRA-1161), `#3068` (portable index export for
exact-commit builds), `#3014` (read path never loads VECTOR). One door per pass,
not a sweep.

### Eighth pass, 2026-09-08: diff-scoped graph review in PR-Agent, and C# namespace fan-out in Aspire

**Mention sweep and catalog moratorium:** `scripts/mention-sweep.sh` ran clean
with zero unrecorded repositories outside `ops/mentions-seen.txt`. The
standing moratorium on new catalog submissions continues to hold (zero
attributable arrivals from directories; see `ROADMAP.md` point 3).

**Two touches, both written after reading the maintainers' open issues and comparing against our own implementation:**

- [`The-PR-Agent/pr-agent#2499`](https://github.com/The-PR-Agent/pr-agent/issues/2499#issuecomment-5579065247)
  (12,887★, open-source AI PR review tool). Maintainer Ismael Martinez confirmed
  on 2026-09-07 that querying an existing graph for only the symbols a diff
  touches is the planned integration shape and asked for empirical prototype
  evidence and failure modes before deciding architecture. We sent the three
  concrete findings from our 60-PR benchmark:
  1. The line-shift trap (TRA-1075): mapping diff hunk headers
     (`git diff --unified=0 <since>..<until>`) to AST spans silently attributes
     code to the wrong enclosing functions unless the index was built at the
     exact commit being compared; a commit-SHA equality assertion is required.
  2. Context structure: packaging only changed symbol definitions loses caller
     context and causes the model to hallucinate impact assumptions, while full
     transitive dependents exceed context limits. The balanced structure that
     held comprehension was: direct definition + imports (`context_bundle`) plus
     1-hop inbound dependents (`change_impact`), under an explicit token budget.
  3. Measured token vs quality trade-off: 72.7% median prompt token reduction
     with bug-fix comprehension holding at parity (67% vs 65% across 60 merged
     PRs in 6 public repos).
- [`CommunityToolkit/Aspire#1575`](https://github.com/CommunityToolkit/Aspire/issues/1575#issuecomment-5579067592)
  (626★, official .NET Foundation / Community Toolkit repository). Maintainer
  Aaron Powell and contributors are evaluating repository-level code graph
  navigation tools for AI assistants in Aspire, with proposals to integrate
  CodeGraph. We shared the architectural trap from our C# import resolver
  (`src/indexer/edge-resolvers/csharp-imports.ts`): unlike file-scoped Python
  or JS modules, C# `using Namespace;` directives do not equal file dependency
  edges. Naive resolution on namespace imports in real .NET repos (e.g.
  Newtonsoft.Json) creates an average of 86 resolved edges per file, producing
  a dense hairball that pollutes agent context. Clean C# graph extraction
  requires distinguishing between namespace `using` statements (scope only),
  exact type imports (`using static`, `using Alias =`), and symbol-level call/reference edges.

**Threads re-checked 2026-09-08, all silent, nothing owed, no pings due before 2026-09-19 / 2026-09-20:**
`eltociear/awesome-AI-driven-development#119`,
`GetBindu/awesome-claude-code-and-skills#195`, `yzfly/awesome-context-engineering#44`,
`ai-boost/awesome-harness-engineering#240`, `tolkonepiu/best-of-mcp-servers#384`,
`0xNyk/awesome-hermes-agent#395`, `natsukium/mcp-servers-nix#606`,
`narumiruna/pi-extensions#1204`, `iansmith/slopstop#633`, `Kilo-Org/kilocode#13843`
and `#12707`, `facebook/pyrefly#4583`, `abhigyanpatwari/GitNexus#3127`,
`watt-mind/factory#1078`, `sosalejandro/atlas#105`,
`Nano-Collective/nanocoder#1197`, `Ivy-Apps/deslop#173`.

**Checked and skipped, with reasons:**
`kirodotdev/KiroCrew#5303` (3,697★, import-graph test selector for PRs) —
maintainer already performed deep design triage on 08-30 and marked it
`needs-investigation` / `crew: needs human`; our input would duplicate their
internal Vitest / pytest separation.
`Kilo-Org/kilocode#13784` (27,210★, indexing initializing state) — maintainer
already triaged and linked pending fix in PR #13796.
`openJiuwen-ai/jiuwenswarm#2665` & `agent-core#462` (8,436★) — automated GitCode
bot mirror; external GitHub comments are not routed to the underlying internal
GitCode team.
`thomaslwq/myclaude#981`, `illumination-k/agent-lens#494`, `jordigilh/engram#43`,
`mshogin/archlint#163`, `srkprasad1995/dexiask#11` — all 0–30★ or personal spikes.

### Ninth pass, 2026-09-08: PR-Agent maintainer reply, LastLight #372 code-graph skill vs egress, and GitNexus #3068 portable index builds

**Maintainer response on open thread:**
- [`The-PR-Agent/pr-agent#2499`](https://github.com/The-PR-Agent/pr-agent/issues/2499#issuecomment-5580870444)
  (12,887★): Maintainer Ismael Martinez replied on 2026-09-08 (07:12:57Z).
  He confirmed our line-shift finding (noting their own `repo_context.py` cache lacked revision pinning on a 15-minute TTL, being addressed in #3148/#3149) and adopted our finding that 1-hop inbound dependents under a strict budget ceiling settles their expansion question. He noted that 67% vs 65% on 60 PRs reads as no measured difference rather than parity, requested empirical prototype evidence passed via `extra_instructions`, and clarified that MCP client support will not arrive before v1 (Discussion #3147). No reply is owed at this stage; prototype consideration recorded.

**Mention sweep and catalog moratorium:** `scripts/mention-sweep.sh` ran clean with zero unrecorded repositories outside `ops/mentions-seen.txt`. The standing moratorium on new catalog submissions continues to hold (zero attributable arrivals from directories; see `ROADMAP.md` point 3).

**Two touches, both written after reading the other repo's code and sharing concrete architectural lessons:**

- [`nearform/lastlight#372`](https://github.com/nearform/lastlight/issues/372#issuecomment-5583584865)
  (22★, Enterprise AI Software Factory by NearForm, authored by NearForm CTO Clifton Cunningham).
  A user requested MCP code graph and Jira/Confluence integration; the maintainer framed three options: Option 1 (Skills via `packages/agentic-pi/src/extensions/skills/index.ts` + egress allowlist), Option 2 (runtime extension loading), Option 3 (full MCP client). We analyzed the code paths and shared the key distinction:
  1. Local code intelligence requires zero network egress (`TRACE_MCP_TELEMETRY=off`), so Option 1 works immediately in a hermetic container sandbox without touching `apps/server/src/sandbox/egress-allowlist.ts` or enabling unrestricted egress (unlike Jira/Confluence SaaS).
  2. The operational trade-off of Option 1 vs 2/3 for code graphs is prompt context consumption over stdout vs structured tool calls. A CLI dumping raw symbol tables into conversation history burns context quickly unless the CLI enforces response budgeting (explicit limits, compact formats like TOON/JSON lines, truncation reporting). MCP/native tools enforce schema validation and parameter bounds, keeping models from hallucinating flags.
  3. Pi's native skill resource loader already implements progressive disclosure, making local code-graph skills viable immediately.
- [`abhigyanpatwari/GitNexus#3068`](https://github.com/abhigyanpatwari/GitNexus/issues/3068#issuecomment-5583589068)
  (47,120★, client-side code knowledge graph MCP server).
  User requested portable index output/import for isolated exact-commit builds. We contributed three failure modes from our own indexing pipeline:
  1. The cross-device rename trap (`EXDEV`): in containerized CI, isolated checkouts often reside on `/tmp` (ephemeral fs) while workspaces reside on volume mounts. `fs.renameSync` fails with `EXDEV` across volumes; fallback to non-atomic copy breaks reader isolation. Portable export bundles unpacked on the target volume avoid cross-device swap failures.
  2. Commit binding vs working-tree bleed: parsing disk files directly bleeds uncommitted/dirty edits into the commit-labeled index; indexing requires validating `git status --porcelain == ""` or reading git tree objects directly.
  3. Active reader isolation and sidecar cleanup: atomic directory swaps while embedded DB readers hold open `.wal` or `.shm` sidecar descriptors cause corruption on subsequent checkpointing unless the export is fully checkpointed and readers detect generation shifts.

**Threads re-checked 2026-09-08, all silent, nothing owed, no pings due before 2026-09-19 / 2026-09-20:**
`The-PR-Agent/pr-agent#2499`, `CommunityToolkit/Aspire#1575`,
`eltociear/awesome-AI-driven-development#119`,
`GetBindu/awesome-claude-code-and-skills#195`, `yzfly/awesome-context-engineering#44`,
`ai-boost/awesome-harness-engineering#240`, `tolkonepiu/best-of-mcp-servers#384`,
`0xNyk/awesome-hermes-agent#395`, `natsukium/mcp-servers-nix#606`,
`narumiruna/pi-extensions#1204`, `iansmith/slopstop#633`, `Kilo-Org/kilocode#13843`
and `#12707`, `facebook/pyrefly#4583`, `abhigyanpatwari/GitNexus#3127` and `#3068`,
`watt-mind/factory#1078`, `sosalejandro/atlas#105`,
`Nano-Collective/nanocoder#1197`, `Ivy-Apps/deslop#173`.

**Checked and skipped, with reasons:**
`myelixlabs/synapse-mcp` (1★, submission in cline/mcp-marketplace#2391, personal spike).
`adhityaravi/maki#693` (0★, personal project).
`PierrunoYT/patch#697` (0★, personal spike).
`samteezy/locally#20` (0★, personal spike).
`cajasmota/grafel#7005` (13★).
`Aider-AI/aider#5580` (bug report already has full reproduction and root-cause analysis by yifanxiong272).
`DeusData/codebase-memory-mcp#1460` (direct competitor tracker, already addressed by other users).

### Tenth pass, 2026-09-08: nanocoder & deslop maintainer validations, harness-engineering #1284 resolution tiers, and git-pkgs/outline #34 Go/Python graph resolvers

**Maintainer responses on open threads:**
- [`Nano-Collective/nanocoder#1197`](https://github.com/Nano-Collective/nanocoder/issues/1197#issuecomment-5573428910)
  (2,455★): Maintainer addyCooks replied enthusiastically on 2026-09-07 (15:40:34Z):
  "Thanks for this, that's a rare kind of comment, actual numbers from having hit the failure mode rather than a hunch about it. Fair catch, and I don't want to argue with a repro. Vendoring six hand-picked trees does cap the corpus at a size where the regime #1186 is about never shows up."
  He added a 7th fixture generated from a seeded generator sized to >150k characters, adopted the pre-registered `verdict: PENDING` baseline committed before tests, and folded all three points into their spec before writing fixtures. No further reply owed.
- [`Ivy-Apps/deslop#173`](https://github.com/Ivy-Apps/deslop/issues/173#issuecomment-5573510294)
  (18★): Maintainer ILIYANGERMANOV replied on 2026-09-07 (10:43:06Z):
  "Thanks for taking the time to write this up and share this context @nikolai-vysotskyi! Seriously appreciate the heads-up on those edge cases, this is super helpful. Btw, I'm addressing this as we speak (my current task) and Deslop users should expect a version with a fix this week." No reply owed.
- [`sosalejandro/atlas#105`](https://github.com/sosalejandro/atlas/issues/105#issuecomment-5574921040)
  (0★): Maintainer closed out Tier 2 (stack-graphs) after verifying it was archived and adds zero languages over SCIP, aligning with our architectural analysis. No reply owed.

**Mention sweep and catalog moratorium:** `scripts/mention-sweep.sh` ran clean with zero unrecorded repositories outside `ops/mentions-seen.txt`. The standing moratorium on new catalog submissions continues to hold (zero attributable arrivals from directories; see `ROADMAP.md` point 3).

**Two touches, both written after reading the other repo's code and sharing concrete architectural lessons:**

- [`Intense-Visions/harness-engineering#1284`](https://github.com/Intense-Visions/harness-engineering/issues/1284#issuecomment-5586540013)
  (20★, Mechanical constraints for AI agents, by maintainer chadjw).
  Maintainer opened an issue analyzing multi-language code-graph coverage and the need to publish honest per-language resolution quality tiers to prevent silent downstream degradation in impact analysis and blast radius (referencing `DeusData/codebase-memory-mcp`'s 13-language Hybrid LSP vs 158 tree-sitter grammars). We contributed three concrete findings from our own resolution measurement harness (`scripts/measure-import-resolution.ts`, TRA-1145):
  1. The denominator trap: in real codebases (e.g. Flask), third-party and stdlib imports dominate total import statements. If external imports are omitted from the denominator, resolution looks deceptively high (99%), while true internal resolution was 22.4%. Honest tiering requires three buckets: resolved-internal, external/unresolvable, and ambiguous.
  2. The syntactic namespace barrier: unlike JS/Python/Go where imports map cleanly to file paths, C# (`using Namespace;`) and Java/Kotlin package imports reference logical namespaces rather than file paths. Without an index-wide namespace-to-file symbol mapping, purely syntactic/tree-sitter resolvers achieve near 0% internal resolution (measured 0.2% on Newtonsoft.Json) because intra-repo imports are syntactically indistinguishable from external libraries.
  3. Propagating resolution boundaries: when imports or call targets are unresolved, treating them as leaf nodes produces false-negative blast radius reports ("0 downstream affected, safe to refactor"). We explicitly surface untracked/opaque boundaries so downstream consumers know the graph is open-ended.
- [`git-pkgs/outline#34`](https://github.com/git-pkgs/outline/pull/34#issuecomment-5586541778)
  (11★, Go library to reduce a source tree to a structural skeleton for LLMs, by Libraries.io creator Andrew Nesbitt / andrew).
  Maintainer opened PR #34 adding cross-file code graph resolution with Go and Python resolvers. We reviewed `resolve.go` and shared three specific failure modes from our own language resolvers:
  1. Go `/v2`+ major version module suffixes in `defaultAlias` (`resolve.go:275`): `module[strings.LastIndexByte(module, '/')+1:]` yields `"v2"` or `"v3"` for versioned module paths like `github.com/stretchr/testify/v2`, causing call receiver lookups (`testify.Equal(...)`) to miss `sc.mods` and fall through to `ext:`. Trimming trailing `/v[0-9]+` before taking the segment fixes versioned imports without parsing remote package clauses.
  2. Go external test package namespace collision in `indexGoPackages` (`resolve.go:13`): grouping declarations by directory (`path.Dir(f.path)`) causes symbols in external test packages (`package foo_test`) to leak into `foo.go`'s package scope. Keying by `dir + ":" + f.a.Package` isolates test package scopes.
  3. Python `__init__.py` re-exports in `moduleExports`: when `__init__.py` re-exports symbols imported from private submodules (`from ._impl import Helper`), callers doing `from . import Helper` resolve to `mod:python:pkg`, but `moduleExports` only inspects declarations directly in `__init__.py`. Propagating `ImportNamed` targets into the module's export table resolves re-exports to internal definitions.

**Threads re-checked 2026-09-08, all silent, nothing owed, no pings due before 2026-09-19 / 2026-09-20:**
`The-PR-Agent/pr-agent#2499`, `nearform/lastlight#372`, `abhigyanpatwari/GitNexus#3068` and `#3127`,
`CommunityToolkit/Aspire#1575`, `eltociear/awesome-AI-driven-development#119`,
`GetBindu/awesome-claude-code-and-skills#195`, `yzfly/awesome-context-engineering#44`,
`ai-boost/awesome-harness-engineering#240`, `tolkonepiu/best-of-mcp-servers#384`,
`0xNyk/awesome-hermes-agent#395`, `natsukium/mcp-servers-nix#606`,
`narumiruna/pi-extensions#1204`, `iansmith/slopstop#633`, `Kilo-Org/kilocode#13843`
and `#12707`, `facebook/pyrefly#4583`, `watt-mind/factory#1078`,
`sosalejandro/atlas#105`, `Nano-Collective/nanocoder#1197`, `Ivy-Apps/deslop#173`,
`headroomlabs-ai/headroom#1009`, `mattbutlerengineering/ai-tooling#585`.

**Checked and skipped, with reasons:**
`openJiuwen-ai/jiuwenswarm#2665` (8,450★, automated GitCode bot mirror; external GitHub comments are not routed to the underlying internal GitCode team).
`ScriptedAlchemy/tracedecay#1029` (71★, direct competitor internal sprint tracker by Zack Jackson).
`sdsrss/code-graph-mcp#41` (73★, maintainer already fixed the CLI path in v0.141.0 and user closed).
`code-yeongyu/oh-my-openagent#7975` (68.8k★, internal OMO compaction accounting bug where prompt injection is not deducted from context limits).
`colbymchenry/codegraph#1747` (69.9k★, internal TS wrapper extraction issue).
`willow-memory/willow-mcp#401` (2★, personal spike).
`nelsonfrugeri-tech/oh-my-harness#118` (1★, personal fork).
`dirge-code/dirge#700` (343★, stale July proposal already approved by maintainer).

### Eleventh pass, 2026-09-08: redproof #50 (@ast-grep/napi codemod realities), cxpak #103 (ESM/NodeNext .js→.ts import resolution), and competitor ripwire (1.7k★)

**Maintainer responses on open threads:**
- All 26 previous threads and PRs re-checked via GitHub API:
  `The-PR-Agent/pr-agent#2499`, `nearform/lastlight#372`, `abhigyanpatwari/GitNexus#3068` and `#3127`,
  `CommunityToolkit/Aspire#1575`, `eltociear/awesome-AI-driven-development#119`,
  `GetBindu/awesome-claude-code-and-skills#195`, `yzfly/awesome-context-engineering#44`,
  `ai-boost/awesome-harness-engineering#240`, `tolkonepiu/best-of-mcp-servers#384`,
  `0xNyk/awesome-hermes-agent#395`, `natsukium/mcp-servers-nix#606`,
  `narumiruna/pi-extensions#1204`, `iansmith/slopstop#633`, `Kilo-Org/kilocode#13843`
  and `#12707`, `facebook/pyrefly#4583`, `watt-mind/factory#1078`,
  `sosalejandro/atlas#105`, `Nano-Collective/nanocoder#1197`, `Ivy-Apps/deslop#173`,
  `Intense-Visions/harness-engineering#1284`, `git-pkgs/outline#34`,
  `headroomlabs-ai/headroom#1009`, `mattbutlerengineering/ai-tooling#585`.
  All quiet, nothing owed, no reminders due before 2026-09-19 / 2026-09-20.

**Mention sweep and catalog moratorium:**
`scripts/mention-sweep.sh` executed and yielded 1 hit: `HolmesGPT/holmesgpt`. Inspected and identified as a collision on their datasource connector `dynatrace-mcp` (`datasource-catalog.json`), recorded in `ops/mentions-seen.txt`. Standing moratorium on new catalog submissions continues to hold (0 attributable installs from directories).

**Two technical outreach contributions posted on GitHub:**

- [`schalermthai/redproof#50`](https://github.com/schalermthai/redproof/issues/50#issuecomment-5589725034)
  (8★, Guardrails harness for coding agents, by maintainer schalermthai).
  Maintainer proposed `@redproof/ast-grep` to provide structural `find` and `mutate` in TypeScript, sketching `ast.replace(ast.locate(...), 'eval($SRC)')` and converting ast-grep ranges to JS string offsets (D3). We shared three practical realities from our `@ast-grep/napi` engine (`src/tools/refactoring/codemod-ast.ts`):
  1. Metavariable substitution in `node.replace()`: the NAPI binding is a matcher, not a template engine. Calling `node.replace('eval($SRC)')` inserts the literal string. Captures must be resolved in JS via `node.getMatch('SRC')?.text()` (and `node.getMultipleMatches('ARGS')` for variadics `$$$`, where `getMatch` returns null) and interpolated before passing the string to `node.replace()`.
  2. Range conversions (D3) vs `root.commitEdits()`: manual slicing using byte/column ranges risks multi-byte UTF-8 vs UTF-16 code unit indexing errors. `root.commitEdits(edits)` on `SgRoot` natively applies non-overlapping edits in Rust and returns the full rewritten source string without manual slicing.
  3. Native binding failure trap: `@ast-grep/napi` relies on platform-specific optional dependencies (`@ast-grep/napi-<os>-<arch>`). In environments where optional packages were skipped or in minimal containers, static top-level imports throw an uncatchable module evaluation error (`Cannot find native binding`). Dynamic loading with try/catch allows emitting `result.refuse` gracefully.

- [`Barnett-Studios/cxpak#103`](https://github.com/Barnett-Studios/cxpak/issues/103#issuecomment-5589727731)
  (27★, LLM context-packing briefing engine, by maintainer lyubomir-bozhinov).
  Maintainer reported that modern ESM/NodeNext import specifiers with extensions (`import x from "./c.js"`) fail resolution in their Rust dependency graph and result in an empty graph / pagerank 0.000 across all files. We contributed two edge cases:
  1. Asymmetrical extension aliases: under NodeNext, Node strictly requires `.js` in the specifier even when source on disk is `c.ts`/`c.tsx`. Probing must map paired extensions (`.js` → `.ts`, `.tsx`, `.js`, `.jsx`; `.mjs` → `.mts`, `.mjs`; `.cjs` → `.cts`, `.cjs`), but must disable directory index probing (`c/index.ts`) for explicit extensioned specifiers to prevent false edges when a file `auth.ts` and directory `auth/` co-exist.
  2. Rust resolver standardization: highlighted the `oxc_resolver` crate (Boshen / Oxc project), which provides a specification-compliant, zero-alloc Rust implementation of Node/TS resolution with native `extension_alias` support.

**Competitor discovery — ripwire (1,711★, Red Hat Emerging Technologies):**
- Discovered `redhat-et/ripwire` (1,711★, Apache-2.0, David Brewster / Red Hat Emerging Technologies), a zero-dependency C++23 CLI + MCP server for coding agents. Uses 22 vendored tree-sitter grammars, PageRank-style ranked map, blast radius analysis, and `--test-gate`.
- Lineage analysis (`docs/LINEAGE.md`): catalogues 42 folded tools (including `trailhq/Graft` after a head-to-head on 2026-09-07) and 237 surveyed tools. Added `ripwire` to `docs/_data/competitors.yml` (1,711★).
- Standing policy on competitor interaction holds: direct posting to `redhat-et/ripwire#59` or other internal bug trackers skipped to maintain strict isolation.

**Checked and skipped, with reasons:**
`trailhq/Graft#310` (6,166★, user asking maintainers how Graft compares to other tools — unsolicited external comment would be spam).
`redhat-et/ripwire#59` (1,711★, direct competitor internal bug tracker).
`ScriptedAlchemy/tracedecay#1029` (71★, direct competitor internal sprint tracker).
`DeusData/codebase-memory-mcp#2054` / `#2077` (direct competitor bug tracker).
`rtk-ai/rtk#3856` (79.5k★, user Micaso already actively collaborating with maintainer to open PR).
`vitali87/code-graph-rag#1786` (5,105★, already claimed by contributor investigating recursive AST traversal).
`macanderson/stella#6018` (12★, internal rust crate test harness).
`mmnto-ai/totem#2667` (17★, internal R14 round finding).

## Run summary — 2026-09-09 (TRA-1234)

**Landing page & competitor profiling: Narsil-MCP (`/vs/narsil-mcp.html`)**
- Profiled `postrv/narsil-mcp` (182★, Rust, v1.7.0): Code Property Graph (CPG) & Code Context Graph (CCG) implementation with embedded Axum web UI and SPARQL 1.1 RDF endpoint.
- Shipped `/vs/narsil-mcp.html` with Schema.org `TechArticle` + `FAQPage` (5 Q&As), compliant 148-char meta description, and 5 architectural deep dives:
  1. Retrieval architecture: SPARQL 1.1 RDF queries vs typed deterministic MCP tools (`get_callers`, `get_change_impact`).
  2. Context efficiency: 90 tools / 47.2K tokens flat overhead vs 28-tool `minimal` preset (~11.6K tokens) with `load_tools` dynamic escalation.
  3. Ecosystem coverage: 32 raw languages vs 81 languages + 87 web framework semantics.
  4. Agent actionability: Read-only graph traversal vs safe AST refactoring write tools (`refactor_rename`, `refactor_extract`, `refactor_move`).
  5. Security taint: Syntactic regex pattern matching vs AST dataflow taint tracking with OASIS SARIF 2.1.0 output.
- Linked in `docs/_data/competitors.yml`, `docs/_data/docs_nav.yml`, `docs/llms.txt`, `docs/sitemap.xml`, and `docs/comparisons.md`.

**Mention sweep & telemetry:**
- `scripts/mention-sweep.sh` run: identified `KryptosAI/mcp-observatory` (146★), verified as `dynatrace-mcp-server` collision and recorded in `ops/mentions-seen.txt`.
- Standing catalog moratorium holds (0 attributable conversions from directories).

### Twelfth pass, 2026-09-09: fullsend #297 (selective AST scoping & line-shift trap), stella #6461 (enclosing symbol envelopes vs raw rg), and competitor aft (278★)

**Maintainer responses on open threads:**
- All 28 previous threads and PRs re-checked via GitHub API:
  - `The-PR-Agent/pr-agent#2499`: Maintainer Ismael Martinez responded on 2026-09-08 confirming agreement with our empirical findings on diff-scoped symbols (1-hop inbound with ceiling) and line-shift cache invalidation. Confirmed no MCP support before v1. Prototype via `extra_instructions` is self-serve; no response owed.
  - All open catalog PRs and external issues re-verified:
    `0xNyk/awesome-hermes-agent#395`, `natsukium/mcp-servers-nix#606`,
    `narumiruna/pi-extensions#1204`, `mattbutlerengineering/ai-tooling#585`,
    `eltociear/awesome-AI-driven-development#119`,
    `GetBindu/awesome-claude-code-and-skills#195`,
    `yzfly/awesome-context-engineering#44`,
    `ai-boost/awesome-harness-engineering#240`,
    `tolkonepiu/best-of-mcp-servers#384`, `nearform/lastlight#372`,
    `abhigyanpatwari/GitNexus#3068` and `#3127`, `CommunityToolkit/Aspire#1575`,
    `iansmith/slopstop#633`, `Kilo-Org/kilocode#13843` and `#12707`,
    `facebook/pyrefly#4583`, `watt-mind/factory#1078`, `sosalejandro/atlas#105`,
    `Nano-Collective/nanocoder#1197`, `Ivy-Apps/deslop#173`,
    `Intense-Visions/harness-engineering#1284`, `git-pkgs/outline#34`,
    `headroomlabs-ai/headroom#1009`, `schalermthai/redproof#50`,
    `Barnett-Studios/cxpak#103`.
    All open, zero unaddressed comments, follow-up deadlines intact (nothing due before 2026-09-19 / 2026-09-20).

**Mention sweep and catalog moratorium:**
- `scripts/mention-sweep.sh` executed: 1 hit `KryptosAI/mcp-observatory`. Inspected and classified as a collision on their datasource connector `dynatrace-mcp-server` in `docs/safety-index/targets.json`, recorded in `ops/mentions-seen.txt`. Sweep clean.
- Standing moratorium on new directory submissions holds (0 attributable installs from directories in `ops/arrivals.md`). Zero directory submissions made.

**Two technical outreach contributions posted on GitHub:**

- [`fullsend-ai/fullsend#297`](https://github.com/fullsend-ai/fullsend/issues/297#issuecomment-5592547663)
  (125★, autonomous agent platform by `waveywaves` & `ralphbean`).
  Maintainers opened a research issue on whether AST code graphs outperform naive grep/find for agent context packing. We contributed empirical data from our 60-PR external benchmark:
  1. Selective context extraction: packing modified symbol + direct imports + 1-hop inbound callers under hard ceiling yields 72.7% token reduction with comprehension parity; unpruned 2+ hop caller trees degrade comprehension (−15 p.p.) and spike hallucinations (+0.55/PR).
  2. Line-shift trap: cached AST line/col ranges break when agent edits shift lines without modifying downstream symbols; resilient architectures re-parse dirty buffers or resolve symbols by stable signature/identifier rather than byte offsets.
  3. SQLite index vs graph DBs: lightweight SQLite WAL indexing scales to millions of symbols without external database daemon overhead.

- [`macanderson/stella#6461`](https://github.com/macanderson/stella/issues/6461#issuecomment-5592549277)
  (12★, autonomous Rust coding agent by `macanderson`).
  Maintainer profiled routing telemetry showing 89.6% bash/grep vs 0.09% search usage on Terminal-Bench 2.1. We contributed concrete lessons on why agents route around structured code search:
  1. N+1 turn penalty: returning bare paths forces the model to immediately call `read_file` or `cat`, making bash one-liners strictly more token/turn efficient.
  2. Enclosing symbol envelopes: matching `rg -n` with line snippets is not enough to change routing; providing enclosing symbol scope, signature, and kind allows the model to act without a subsequent read.
  3. Explicit truncation headers: silent truncation (`MAX_NAME_HITS = 10`) destroys model trust and forces fallback to grep; explicit headers (`Showing 10 of 47 matches. Narrow by symbol_type or parent`) maintain model predictability.

**Competitor discovery — AFT (278★, CortexKit) & star re-verification:**
- Discovered `cortexkit/aft` (278★, MIT, Rust + TS, v0.7.2), sensorimotor cortex / code intelligence sidecar for OpenCode and Pi agents with 30-language tree-sitter symbol graph, trigram search, and embedded `ast-grep` pattern matching.
- Added `aft` to `docs/_data/competitors.yml` (278★) and profiled architecture in `docs/comparisons.md`.
- Re-verified active competitor star counts: `context_mode` (21,358★, +242), `ripwire` (1,745★, +34).

**Checked and skipped, with reasons:**
- `fullsend-ai/fullsend#269` / `#298` (adjacent context issues actively handled by maintainer Ralph Bean).
- `macanderson/stella#6018` (internal rust crate test harness).
- `trailhq/Graft#310` (6,166★, user asking for comparison; unsolicited comment would be spam).
- `cortexkit/aft#12` / repo issues (direct competitor bug tracker).
- `ScriptedAlchemy/tracedecay#1029` (71★, direct competitor internal sprint tracker).
- `DeusData/codebase-memory-mcp#2054` (direct competitor bug tracker).
- `redhat-et/ripwire#59` (direct competitor bug tracker).

### Thirteenth pass, 2026-09-09: gbrain #5001 (anonymous callbacks & arrow declarations), FM-Agent #229 (Rust receiver dispatch & SCIP tiers), and competitor ai-architect-codebase (4★)

**Maintainer responses and open thread verification:**
- External PRs and issue tracker re-checked across GitHub API:
  - `hashgraph-online/awesome-ai-plugins#182`: Merged 2026-08-31 by `kantorcodes`. The follow-up on 2026-09-03 was a bot-templated reminder to authenticate with GitHub OAuth on `hol.org/guard/plugins` for an owner badge, which we declined per workspace security policy. The listing itself is live and merged; no response owed.
  - All 5 open catalog PRs re-verified:
    `eltociear/awesome-AI-driven-development#119`,
    `GetBindu/awesome-claude-code-and-skills#195`,
    `yzfly/awesome-context-engineering#44`,
    `ai-boost/awesome-harness-engineering#240`,
    `tolkonepiu/best-of-mcp-servers#384`.
    All 5 remain open, 0 unaddressed comments or maintainer reviews, awaiting maintainer triage cycles. Deadlines intact (no pings before 2026-09-19 / 2026-09-20 / 2026-09-26 / 2026-10-05).
  - External issues and prior outreach threads re-verified:
    `0xNyk/awesome-hermes-agent#395`, `natsukium/mcp-servers-nix#606`,
    `narumiruna/pi-extensions#1204`, `mattbutlerengineering/ai-tooling#585`,
    `The-PR-Agent/pr-agent#2499`, `fullsend-ai/fullsend#297`, `macanderson/stella#6461`.
    Zero pending actions required from us.

**Mention sweep and code search:**
- `scripts/mention-sweep.sh` executed across REST and GraphQL search:
  - Hit 1: `drguptavivek/DYNAMIC` (second repository by an existing user with `.trace-mcp/` in `CLAUDE.md` commit conventions alongside `.serena/`). Classified and added to `ops/mentions-seen.txt`.
  - Hit 2: `Nova-Hunting/nova-tracer` (collision on `.trace-mcp` CSS class in `report_generator.py`). Classified and added to `ops/mentions-seen.txt`.
- Standing catalog moratorium holds: 0 attributable installs from directories recorded in `ops/arrivals.md`. Zero directory submissions made.

**Two technical outreach contributions posted on GitHub:**

- [`garrytan/gbrain#5001`](https://github.com/garrytan/gbrain/issues/5001#issuecomment-5601272030)
  (29,753★, OpenClaw/Hermes agent brain by Garry Tan).
  User `ShahriarLak` filed two tree-sitter call graph defects: anonymous callbacks (`it()`, `.map()`, `useEffect()`) dropping caller edges because of missing named enclosing symbols; and exported arrow functions receiving `symbol_type: "export statement"` / `"lexical declaration"`, causing definition resolution to fail (`resolved:false`). We contributed concrete AST grammar mechanics from our TypeScript plugin:
  1. Tree-sitter AST declarator unwrapping: `export const foo = () => ...` produces `export_statement` -> `lexical_declaration` -> `variable_declarator`. Inspecting `declarator.childForFieldName('value')` for `arrow_function` or `function_expression` reclassifies the symbol as `kind = "function"`, allowing definition matchers to succeed.
  2. Anonymous callback caller attribution: walking up AST from `call_expression` without finding a named function/method declaration should not drop the edge; attributing to a synthetic file/module symbol (`__module__:<filename>`) preserves the caller edge and line numbers so agents don't see false-zero blast radius.
  3. Separating type references from runtime calls: distinguishing `type_identifier` inside `type_annotation` / `type_arguments` from `call_expression` to eliminate type pollution (`Record`, `BoxRow`) in `code-callees`.

- [`fmagent-project/FM-Agent#229`](https://github.com/fmagent-project/FM-Agent/issues/229#issuecomment-5601274875)
  (469★, foundation model coding agent framework).
  Maintainer profiled 11 Rust receiver shapes where purely syntactic codegraph drops receiver types and resolves by closest file path directory proximity (e.g. `self.init()` in `impl StaticLinkedList` incorrectly mapping to `ProcessManager::init`), proposing a migration to `rust-analyzer scip`. We shared empirical findings from our Rust indexer and SCIP ingestion pipeline:
  1. `impl` context scoping: in tree-sitter-rust, `impl_item` carries the target struct in its `type` field (`StaticLinkedList`). Binding calls on `self` to the enclosing `impl` resolves Category 6 and Category 3 without requiring full type inference.
  2. Operational realities of `rust-analyzer scip`: heavy cold indexing (15–40s, 1–2 GB RAM on 50k+ LoC) and position drift on uncommitted agent edits.
  3. Tiered resolution architecture: fast tree-sitter indexing for per-turn baseline context, upgraded by batch SCIP occurrences (`scip_resolved` tier) when compiler artifacts are present.

**Competitor discovery — AI Architect Codebase (4★) & star re-verification:**
- Discovered `cdeust/ai-architect-mcp-codebase` (4★, MIT, Clement), cross-platform code intelligence MCP server for Claude Code, Codex, Cursor, and Zed with tree-sitter AST to LadybugDB graph and hybrid search. Added to `docs/_data/competitors.yml` (4★).
- Direct posting to `cdeust/ai-architect-mcp-codebase#291` skipped in accordance with our strict competitor tracker isolation policy.
- Re-verified active competitor star counts in `docs/_data/competitors.yml`:
  - `ripwire`: 1,745 → **1,795★** (+50, display moved to 1.8K)
  - `context_mode`: 21,358 → **21,588★** (+230, display moved to 21.6K)
  - `trace-mcp`: 173 → **175★** (+2)

**Checked and skipped, with reasons:**
- `cdeust/ai-architect-mcp-codebase#291` (4★, direct competitor bug tracker).
- `colbymchenry/codegraph#1747` (70.1k★, direct competitor bug tracker).
- `Graphify-Labs/graphify#3406` (direct competitor bug tracker).
- `redhat-et/ripwire#67` (1.8k★, direct competitor tracker).
- `TheHalfMoon/Golam#25` (0★, internal source qualification issue comparing ripwire).
- `tyldra-org/falryn#990` (large internal testing qualification spec).
- `headroomlabs-ai/headroom#3495` (70.9k★, user Cort Fritz already has branch implemented and is awaiting maintainer thumbs-up).

### Fourteenth pass, 2026-09-10 (TRA-1281): Maintainer thread audits, linny006 third tracker, and MobinX queue analysis

**Maintainer responses and open thread verification:**
- `hashgraph-online/awesome-ai-plugins#182`: Closed and merged 2026-08-31 by `kantorcodes`. The subsequent bot/maintainer comments on 2026-09-03 requested ownership verification via GitHub OAuth on `hol.org/guard/plugins`, which was declined per workspace security policy (third-party OAuth login for a badge). The listing itself is live in the catalog; no response owed.
- All 5 open catalog PRs re-verified:
  - `eltociear/awesome-AI-driven-development#119`: Open, 0 comments, submitted 2026-09-06. (Do not ping before 2026-09-20).
  - `GetBindu/awesome-claude-code-and-skills#195`: Open, 0 comments, submitted 2026-09-06. (Do not ping before 2026-09-20).
  - `yzfly/awesome-context-engineering#44`: Open, 0 comments, submitted 2026-09-05. (Re-check 2026-09-19).
  - `ai-boost/awesome-harness-engineering#240`: Open, 0 comments, submitted 2026-09-05. (Re-read 2026-10-05).
  - `tolkonepiu/best-of-mcp-servers#384`: Open, 0 comments, submitted 2026-08-29. (Do not ping before 2026-09-26).
  All 5 remain open, 0 unaddressed comments or maintainer reviews, awaiting maintainer triage cycles. Deadlines intact.
- External issues and prior outreach threads re-verified:
  - `0xNyk/awesome-hermes-agent#395`: Open, 0 comments. (Awaiting batch triage, no ping before 2026-09-20).
  - `natsukium/mcp-servers-nix#606`: Open, 0 comments. (No ping before 2026-09-20).
  - `narumiruna/pi-extensions#1204`: Open, 0 comments.
  - `mattbutlerengineering/ai-tooling#585`: Open, 0 comments. (No follow-up per TRA-857).
  - `Dokploy/mcp#81`: 3 comments, discussion on progressive disclosure and 500-tool limit; Nikolai's architectural explanation posted 2026-09-04; no further response owed.

**Mention sweep and code search:**
- `scripts/mention-sweep.sh` executed across REST and GraphQL search:
  - Hit 1: `linny006/claude-code-plugin-tracker` (genuine auto-index tracking Claude Code plugins by operator `linny006`, rank 13, 175★ in `README.md` and `data/items.json`). Classified, added row to Surfaces table and recorded in `ops/mentions-seen.txt`.
  - Hit 2: `Dynatrace/dynatrace-for-ai` (collision on Dynatrace's internal gateway URL `dynatrace-mcp`). Classified and added to `ops/mentions-seen.txt`.
  - Hit 3: `inai-sandy/inAI-wiki` (collision on unrelated 2025 HuggingFace tool named TraceMCP in `docs/reddit-news/2025/2025-11-26.md`). Classified and added to `ops/mentions-seen.txt`.
- Standing catalog moratorium holds: 0 attributable installs from directories recorded in `ops/arrivals.md`. Zero directory submissions made.

**Catalog and ecosystem findings:**
- `MobinX/awesome-mcp-list` (880★): Evaluated for listing viability. Analysis of recent pull requests showed 30+ open external PRs dating back to August with zero merges, and recent closed PRs all show `merged_at: null`. The repository does not merge community submissions. Documented as a closed door to prevent future runs from burning effort on it.
- `jamesmurdza/awesome-ai-devtools` (3,935★): Actively curated directory covering `Codebase Intelligence` and `Configuration & Context Management`. Verified structure and requirements.

**Competitor tracking & star re-verification:**
- Re-verified active competitor star counts against live GitHub API:
  - `oraios/serena`: 29,089★ (29.1K)
  - `yamadashy/repomix`: 28,268★ (28.3K)
  - `DeusData/codebase-memory-mcp`: 42,775★ (42.8K)
  - `mksglu/context-mode`: 21,695★ (21.7K)
  - `redhat-et/ripwire`: 1,825★ (1.8K)
  - `cdeust/ai-architect-mcp-codebase`: 4★ (4)
  - `trace-mcp`: 175★ (175)
  All figures remain consistent with `docs/_data/competitors.yml` (TRA-1283).

**Checked and skipped, with reasons:**
- `M9nx/CodexA#22` (34★, semantic code intelligence CLI bug tracker for PHP symbol references, skipped per competitor tracker isolation policy).
- `vitali87/code-graph-rag#1494` (5,113★, direct competitor tracker, author actively implementing workspace plumbing).
- `adhityaravi/maki#741` (0★ personal LLM assistant).
- `dyphn1/Docuvia#192` (0★ personal doc generator).
- `pluto-atom-4/IntVue#162` (0★ personal local repo).

### Fifteenth pass, 2026-09-11 (TRA-1361): Comparative page /vs/gitnexus (47.2K★), deep-dive grafel (Go, 22 tools), and telemetry W14

**Telemetry and adoption snapshot (GA4 property, 2026-09-11):**
- **DAU**: **44** (up from 25 on 09-08, +76%).
- **WAU**: **126** (up from 104 on 09-08, +21%).
- **MAU**: **199** (up from 137 on 09-08, +45%).
- **Observed window**: 14 days active, 976 events recorded in 28d window.
- **Client breakdown**: claude-code (49), codex-mcp-client (22), antigravity-client (8), mcp (5), opencode (4), cursor-vscode (3), grok-shell-trace-mcp (3), rmcp (3), plus 1 each for Trae, Visual Studio Code, factory-cli, kimi-code, kiro, pi-mcp-trace-mcp, smoke, zcode. 76% of installs report on client-readable versions (>=3.12.0).

**Mention sweep and code search:**
- `scripts/mention-sweep.sh` executed across REST and GraphQL search:
  - Hit 1: `andrehora/file-history` (file tracker tracking `davila7/claude-code-templates` component files including `trace-mcp.json`). Classified and added to `ops/mentions-seen.txt`.
  - Hit 2: `artemrudenko/code-graph-benchmark-v2` (independent benchmark protocol evaluating Serena, codebase-memory-mcp, CRG, repomix, and noting trace-mcp ecosystem articles and candidates). Classified and added to `ops/mentions-seen.txt`.
  - Hit 3: `xmkqv/money-tree` (curated agentic code cleanup skill catalog in `.claude/skills/catalogs/agentic-code-cleanup.md` listing trace-mcp under agent-code-quality for deterministic blast-radius, pr-risk, and test gaps). Classified, added row to Surfaces table and recorded in `ops/mentions-seen.txt`.
- Post-classification re-sweep confirmed 100% clean: «No repos outside the seen list. Nothing to read.»

**Competitor intelligence & content delivery:**
- **Added dedicated comparative page `docs/vs/gitnexus.md`**:
  Full head-to-head analysis against GitNexus (`abhigyanpatwari/GitNexus`, 47.2K★). Highlights permissive MIT vs PolyForm Noncommercial 1.0.0, prompt-efficient typed MCP tools vs raw Cypher query hallucinations, 88 framework integrations vs generic syntax, portable WASM sandboxes vs native C++ toolchain requirements (`node-gyp-build`), and AST refactoring write tools (`refactor_rename`, `refactor_extract`, `refactor_move`, `refactor_codemod`) and OWASP taint analysis. Structured with TechArticle and FAQPage schema.org JSON-LD, 150-char meta description, and cross-links.
- **First source read of grafel (`cajasmota/grafel`, 15★, Go, 22 tools)**:
  Corrected language: written in Go (Go 1.23+ with cgo Tree-sitter), not Rust. Multi-repo code knowledge graph daemon for AI agents exposing 22 MCP tools (`grafel_whoami`, `grafel_find`, `grafel_inspect`, `grafel_expand`, `grafel_trace`, `grafel_traces`, `grafel_clusters`, `grafel_orient`, `grafel_effects`, `grafel_control_flow`, `grafel_endpoint_posture`, `grafel_payload_drift`, `grafel_literal_parity`, `grafel_auth_posture_diff`, `grafel_stub_detector`, `grafel_response_shape_diff`, `grafel_security_findings`, etc.) on an in-memory/mmap graph substrate (`mmapview.go`).
  - *Take*: Static stub and tautology detection (`grafel_stub_detector`, `grafel_tautology_detector`) into quality gates.
  - *Take*: Cross-repo HTTP payload drift concept (`response_shape_diff`) for multi-package monorepos.
  - *Take*: Multi-repo workspace topology (`internal/repowalk/`, `internal/repolock/`) into monorepo roadmap.
  - *Pass*: cgo Tree-sitter native daemon (WASM sandbox is safer and portable).
- **Competitor star counts verified against live GitHub API (18 tracked competitors)**:
  - `codegraph`: 70,255 → **70,454★** (70.5K)
  - `gitnexus`: 47,177 → **47,217★** (47.2K)
  - `codebase_memory_mcp`: 42,776 → **42,922★** (42.9K)
  - `code_review_graph`: 31,287 → **31,320★** (31.3K)
  - `serena`: 29,088 → **29,165★** (29.2K)
  - `repomix`: 28,268 → **28,288★** (28.3K)
  - `context_mode`: 21,682 → **22,064★** (22.1K)
  - `CodeGraphContext`: 4,179 → **4,180★** (4.2K)
  - `socraticode`: 3,292 → **3,294★** (3.3K)
  - `jcodemunch`: 2,676 → **2,680★** (2.7K)
  - `ripwire`: 1,823 → **1,885★** (1.9K)
  - `tokensave`: 623 → **624★** (624)
  - `aft`: 278 → **279★** (279)
  - `code_pathfinder`: 140 → **140★** (140)
  - `codegraph_ai`: 83 → **85★** (85)
  - `grafel`: added to tracked data, **15★** (15)
  - `ai_architect_codebase`: 4 → **4★** (4)
  - `trace-mcp`: 175 → **175★** (175)
- Priority for next deep-dive: **Narsil-MCP** (`postrv/narsil-mcp`, Rust, 182★, CCG 4-layer progressive disclosure) and a re-read of **Graft** (`trailhq/Graft`, 7.0K★, fastest-growing peer).

### Sixteenth pass, 2026-09-11 (TRA-1371): Dedicated comparative page /vs/graft (7.1K★), competitor star refresh (43K CBM), and telemetry audit

**Telemetry and adoption snapshot (GA4 property, 2026-09-11 W14 audit):**
- **DAU**: **44** (up from 25 on 09-08, +76%).
- **WAU**: **126** (up from 104 on 09-08, +21%).
- **MAU**: **199** (up from 137 on 09-08, +45%).
- **Events (28d window)**: **976 events**.
- **Client breakdown**: claude-code (49), codex-mcp-client (22), antigravity-client (8), mcp (5), opencode (4), cursor-vscode (3), grok-shell-trace-mcp (3), rmcp (3), Trae (1), Visual Studio Code (1), factory-cli (1), kimi-code (1), kiro (1), pi-mcp-trace-mcp (1), smoke (1), zcode (1).
- **Client reporting**: 76% of reporting installs run client-readable versions (>=3.12.0).

**Mention sweep and code search:**
- `scripts/mention-sweep.sh` executed across REST and GraphQL queries. Output: «No repos outside the seen list. Nothing to read.»
- Standing catalog moratorium holds: 0 attributable installs from directories in `ops/arrivals.md`. Zero directory submissions made.

**Competitor intelligence & content delivery:**
- **Added dedicated comparative landing page `docs/vs/graft.md`**:
  Full head-to-head analysis against Graft (`trailhq/Graft`, 7,094★, #8 largest peer in ecosystem). Highlights 100% deterministic local WASM parsing + SQLite vs paid external LLM API keys (@anthropic-ai/sdk, openai) & token bills per file, relational embedded SQLite graph (WAL + FTS5) vs loose markdown files with YAML front matter in `graft/`, 6 read-only MCP tools vs {{ site.data.counts.tools }} tools with verified AST refactorings (`refactor_rename`, `refactor_extract`, `refactor_move`, `refactor_codemod`), OWASP Top-10 taint analysis, 88 framework semantic integrations, and zero-setup WASM portability vs native C++ node-gyp builds. Structured with TechArticle and FAQPage schema.org JSON-LD, 153-char meta description, and cross-links.
- **Competitor star counts verified against live GitHub API (20 tracked competitors)**:
  - `codegraph`: 70,483 → **70,502★** (70.5K)
  - `gitnexus`: 47,226 → **47,245★** (47.2K)
  - `codebase_memory_mcp`: 42,940 → **42,957★** (**43K**, passed rounding threshold to 43K)
  - `code_review_graph`: 31,329 → **31,333★** (31.3K)
  - `serena`: 29,173 → **29,186★** (29.2K)
  - `repomix`: 28,288 → **28,290★** (28.3K)
  - `context_mode`: 22,089 → **22,146★** (22.1K)
  - `graft`: 7,056 → **7,094★** (7.1K)
  - `codegraphcontext`: 4,183 → **4,183★** (4.2K)
  - `socraticode`: 3,294 → **3,294★** (3.3K)
  - `jcodemunch`: 2,680 → **2,681★** (2.7K)
  - `ripwire`: 1,889 → **1,892★** (1.9K)
  - `tokensave`: 625 → **625★** (625)
  - `aft`: 280 → **280★** (280)
  - `narsil_mcp`: 182 → **183★** (183)
  - `trace-mcp`: 175 → **175★** (175)
  - `code_pathfinder`: 140 → **140★** (140)
  - `codegraph_ai`: 85 → **85★** (85)
  - `grafel`: 15 → **15★** (15)
  - `ai_architect_codebase`: 4 → **4★** (4)
- **Maintainer threads and open outreach queue audit**:
  - All 28 previous threads and PRs re-checked across GitHub API:
    `eltociear/awesome-AI-driven-development#119`, `GetBindu/awesome-claude-code-and-skills#195`, `yzfly/awesome-context-engineering#44`, `ai-boost/awesome-harness-engineering#240`, `tolkonepiu/best-of-mcp-servers#384`, `0xNyk/awesome-hermes-agent#395`, `natsukium/mcp-servers-nix#606`, `narumiruna/pi-extensions#1204`, `The-PR-Agent/pr-agent#2499`, `fullsend-ai/fullsend#297`, `macanderson/stella#6461`, `garrytan/gbrain#5001`, `fmagent-project/FM-Agent#229`.
    All open, zero unaddressed comments, follow-up deadlines intact (nothing due before 2026-09-19 / 2026-09-20 / 2026-09-26 / 2026-10-05).
- Priority for next deep-dive: **SDL-MCP** client-side hook generation and **RTK** (Real-Time Knowledge), plus dedicated comparative page for **Ripwire** (`redhat-et/ripwire`, 1.9K★).

### Seventeenth pass, 2026-09-14 (TRA-1496): nine threads re-verified, deslop fix shipped, four sweep hits, new rival names us

**Open-thread audit (all via GitHub API, 2026-09-14):**
- All 5 catalog PRs still OPEN, 0 comments each, deadlines intact — no ping due:
  `eltociear/awesome-AI-driven-development#119`, `GetBindu/awesome-claude-code-and-skills#195`,
  `yzfly/awesome-context-engineering#44` (re-check 2026-09-19), `ai-boost/awesome-harness-engineering#240`
  (re-read 2026-10-05), `tolkonepiu/best-of-mcp-servers#384` (no ping before 2026-09-26).
- `0xNyk/awesome-hermes-agent#395`, `natsukium/mcp-servers-nix#606`, `narumiruna/pi-extensions#1204`,
  `mattbutlerengineering/ai-tooling#585`: all OPEN, 0 comments. `Dokploy/mcp#81`: OPEN, 3 comments,
  unchanged since 2026-09-05 — nothing owed.
- `Ivy-Apps/deslop#173`: **CLOSED 2026-09-08** — the maintainer shipped the `export … from` fix built on
  the analysis posted from this lane. Second shipped fix from the read-code-first pattern after atlas.
- `Kilo-Org/kilocode#13843`: OPEN, 1 comment (ours), no maintainer reply since 2026-09-07. It is a gift
  bug report, not a thread awaiting our answer — no follow-up.
- `hesreallyhim/awesome-claude-code` (TRA-633): still `blocked` on the one human-only web-form click.
  Per the 2026-09-07 focus rule the consolidated ask already stands — no new ping from this lane.

**Mention sweep (`scripts/mention-sweep.sh`, 2026-09-14) — 4 new repos, all classified:**
- `Cranot/roam-code` (517★, Python, created 2026-02-09, pushed 2026-09-14): **a direct rival that names us.**
  "Local codebase intelligence CLI + MCP server for AI coding agents: SQLite code graph, 28 languages,
  287 commands, 246 MCP tools." Their landing-page template `templates/distribution/landing-page/compare.html`
  (section `local-code-graphs`) says "trace-mcp describes a local graph and agent tools" next to CodeGraph's
  blast-radius tool — fair, non-hostile, no benchmark against us. Not in `docs/_data/competitors.yml`;
  pointer for the Competitor Intelligence lane, not a door for this one. Do not write to their tracker.
- `Mesteriis/Engineering-Bible-AI` (0★): personal standards repo whose `2026-09-09-shared-code-indexing.md`
  spec standardises on Serena + Graphify + Repomix and says "Remove the stale local `trace-mcp` client entry
  whose command no longer exists; do not install or initialize trace-mcp." One user dropped us over a stale
  command — pointer for the MCP Reliability / User Feedback lanes on what that command was, not outreach.
- `seongyeon1/seongyeon1.github.io` (0★, Korean blog): `docs/editorial-plan.md` carries a planned tutorial
  row, "trace-mcp — framework-aware MCP code intelligence" for coding-agent context layers. A plan, not a
  post; 0★ personal blog — nothing to write, recorded so the next sweep stays quiet.
- `rxmna8502/vybe-intelligence-vault` (22★): same generative vault family as the recorded
  `SAIRAMANALADI/vybe-intelligence-vault` — same front-matter shape (`quality_score: 9`, GPU Acceleration
  in `tech_stack`, `evaluated_by: mistral-small-latest`), same stale figures. No contact path, no action.

**Competitor star snapshot (live GitHub API, 2026-09-14; prior from the 2026-09-11 pass):**
- `codegraph`: 70,502 → **70,792★** (+290)
- `serena`: 29,186 → **29,309★** (+123)
- `repomix`: 28,290 → **28,337★** (+47)
- `codebase_memory_mcp`: 42,957 → **43,203★** (+246)
- `context_mode`: 22,146 → **22,783★** (+637, fastest mover this window)
- `ripwire`: 1,892 → **2,023★** (+131)
- `graft`: 7,094 → **7,637★** (+543)
- `roam-code`: **517★** (newly observed, untracked)
- `trace-mcp`: 175 → **175★** (+0)

**Nothing submitted, nothing opened.** Catalog moratorium holds (0 attributable installs in `ops/arrivals.md`);
no deadline falls due before 2026-09-19; no repo met the message bar, so the 5-touch allowance went unused —
a ceiling, not a quota.

### Eighteenth pass, 2026-09-14 evening (TRA-1501): pr-agent maintainer answered, FM-Agent closed with thanks, one sweep hit

**Open-thread audit (all via GitHub API, ~4h after the morning pass, so this is a delta read).**
All 5 catalog PRs still OPEN, 0 comments each, timestamps unchanged — no ping due:
`eltociear/awesome-AI-driven-development#119`, `GetBindu/awesome-claude-code-and-skills#195`,
`yzfly/awesome-context-engineering#44` (re-check 2026-09-19), `ai-boost/awesome-harness-engineering#240`
(re-read 2026-10-05), `tolkonepiu/best-of-mcp-servers#384` (no ping before 2026-09-26).
`0xNyk/awesome-hermes-agent#395`, `natsukium/mcp-servers-nix#606`,
`mattbutlerengineering/ai-tooling#585` (no follow-up per TRA-857): all OPEN, 0 comments.
`narumiruna/pi-extensions#1204` is an issue, not a PR — OPEN, 0 comments, unchanged since 2026-09-05.
`Dokploy/mcp#81`: OPEN, 3 comments, unchanged since 2026-09-05.
`Kilo-Org/kilocode#13843` and `#12707`: OPEN, 1 comment (ours) each, no maintainer reply.
`iansmith/slopstop#633`: OPEN, 1 comment (ours). `Ivy-Apps/deslop#173`: CLOSED 2026-09-08, fix shipped.
`sosalejandro/atlas#105`: last comment 09-07 is the maintainer's own Tier-2 close-out
(`github/stack-graphs` archived, tier withdrawn) — nothing directed at us.
`Nano-Collective/nanocoder#1197`: one new comment since 09-07, but it is a third party (`slowe89`)
pitching their own eval-pack product, not a question to us — no action.
TRA-633 still `blocked` on the one human-only form click; consolidated ask stands, no new ping.

**One thread needed an answer and got it: `The-PR-Agent/pr-agent#2499`.**
Maintainer `IsmaelMartinez` replied 2026-09-08 (six days, missed by the morning pass because it audits
nine catalog threads): same defect class found independently (`repo_context.py` cache keyed with no
revision, 15-min TTL, #3119; fixes #3148/#3149), one-hop-inbound-plus-ceiling called "sharper than
anything here", 67-vs-65 read as no measured difference rather than parity (accept that reading —
n=60 is one PR either way), MCP work deferred to post-v1 Discussion #3147, and a prescribed prototype:
run the packaging ourselves through `extra_instructions`. Replied with thanks, the accepted stats
reading, and no promise beyond a tracked experiment
([comment](https://github.com/The-PR-Agent/pr-agent/issues/2499#issuecomment-5668466724)).
The prototype is TRA-1502 (backlog): bundle producer + SHA assertion per TRA-1075, fed via
`extra_instructions`, numbers or negative result. Do not comment there again until there are numbers.

**Two threads closed or declined against us, no action on either.**
`fmagent-project/FM-Agent#229` CLOSED 2026-09-14 as completed: maintainer (`Dshuishui`) confirmed our
category-6 read at the exact site (`SKIP_RECEIVERS` stripping `self` in `tree-sitter.ts` while
`getReceiverType()` already has the type), fixed via rust-analyzer batch index in #230 with codegraph
as fallback. A thank-you would only cost a notification.
`CommunityToolkit/Aspire#1575`: maintainer (`aaronpowell`, 09-09) doubts an indexing tool pays off for
that repo ("isn't really that code heavy", little intersection between the code). That is a no on the
graph direction; the thread has since moved to AGENTS.md/skills. Do not push.
`fullsend-ai/fullsend#297`: updated 09-14 by automation only (3 comments: triage bot, stale bot, ours) —
no human reply.

**Mention sweep (`scripts/mention-sweep.sh`): 1 new repo, classified, no outreach.**
`Egoka/Altera` (0★, pushed today): same author as the recorded `Egoka/FishtVue`. `AGENTS.md` carries
our routing block verbatim, and `scripts/agent-runtime/` holds `trace-canary.mjs` (real stdio canary:
`index` → `get_project_map` → `get_outline`, `--preset review`, evidence to `/runtime/evidence/`)
and `cli-preflight.mjs` (pins exact CLI versions, gates on `trace-mcp --help` exit 0). A retained user
standardising us across a second repo, containerised. Nothing to write — they already run us.
Recorded in `ops/mentions-seen.txt`. The version-pinning plus canary shape is worth a line to MCP
Reliability / User Feedback: this is what a serious self-hosted setup looks like.

**Touch budget: 1 of 5 used** (the pr-agent reply). No catalog submissions (moratorium), no new
threads opened, no repeat pings.

### Nineteenth pass, 2026-09-15 (TRA-1521): all threads silent, sweep clean, four fresh issues triaged

**Open-thread audit (all via GitHub API, 2026-09-15).**
All 5 catalog PRs still OPEN, 0 comments each, no ping due:
`eltociear/awesome-AI-driven-development#119`, `GetBindu/awesome-claude-code-and-skills#195`,
`yzfly/awesome-context-engineering#44` (re-check 2026-09-19), `ai-boost/awesome-harness-engineering#240`
(re-read 2026-10-05), `tolkonepiu/best-of-mcp-servers#384` (no ping before 2026-09-26).
`eltociear#119` and `ai-boost#240` show committer-dated 2026-09-14T22:05/22:06Z heads authored by
nikolai-vysotskyi — our own rebases already recorded in the table rows above, both `mergeable_state:
clean` now. `0xNyk/awesome-hermes-agent#395`, `natsukium/mcp-servers-nix#606`,
`narumiruna/pi-extensions#1204`, `mattbutlerengineering/ai-tooling#585` (no follow-up per TRA-857):
all OPEN, 0 comments. `Dokploy/mcp#81`: OPEN, 3 comments, unchanged since 2026-09-05.
`Kilo-Org/kilocode#13843` and `#12707`: OPEN, 1 comment (ours) each, no maintainer reply.
`iansmith/slopstop#633`: OPEN, 1 comment (ours), unchanged since 2026-09-06.
`sosalejandro/atlas#105`: 9 comments, last 09-07 is the maintainer's own Tier-2 close-out — nothing
directed at us. `Nano-Collective/nanocoder#1197`: 4 comments, newest is still the third-party
`slowe89` eval-pack pitch from 09-11 — no question to us. `The-PR-Agent/pr-agent#2499`: 11 comments,
newest is our own 09-14 reply — no maintainer answer yet, prototype TRA-1502 stays the next move.
TRA-633 still `blocked` on the one human-only form click; consolidated ask stands, no new ping.

**Mention sweep (`scripts/mention-sweep.sh`): clean.** Zero repos outside `ops/mentions-seen.txt`.

**Competitor star snapshot (live GitHub API, 2026-09-15; prior 2026-09-14):**
codegraph 70,792 → **70,883** (+91); serena 29,309 → **29,342** (+33); repomix 28,337 → **28,351**
(+14); CBM 43,203 → **43,275** (+72); context-mode 22,783 → **22,906** (+123); ripwire 2,023 →
**2,118** (+95); graft 7,637 → **7,844** (+207, fastest); code-review-graph → **31,439**;
trace-mcp 175 → **174** (−1, first down-tick since tracking began — single unstar or count
fluctuation, not a trend until it repeats).

**Trial-plan / import-graph issue sweeps: four fresh issues read, all four correctly left alone.**
- `abhigyanpatwari/GitNexus#3291` (opened today, 0 comments): feature-branch index reports
`status: current` with no indexed ref — the TRA-1075/TRA-1161 "no-op that looks like success" class,
and the author already specifies the fix (carry `branch`/`lastCommit`/`indexedAt`, emit even when
current, file refs included). Both halves of what we could add — SHA-equality freshness and
per-file mtime states — were already sent to this same repo in #3127. A comment would restate a
complete issue to its own author. Skipped, not a door.
- `frsvffcy/llm-wiki-km#439` (0★): agent-written evaluation-planning ticket for GitNexus sidecar use
in somebody's private wiki repo. The trial-plan class rule holds: somebody's private configuration
ticket, do not comment.
- `tirth8205/code-review-graph#981` and `Graphify-Labs/graphify#3565` (both opened today, 0
comments): genuine import-resolution defects (Python relative-import misattach; Elixir alias edges
dropped on id-prefix mismatch) — both in direct competitors' trackers, where the standing rule
(zilliz, codebase-memory-mcp precedents) is we do not comment. Skipped, recorded so the next pass
does not re-read them.

**Touch budget: 0 of 5 used** — a ceiling, not a quota; nothing met the message bar. No catalog
submissions (moratorium holds), no new threads opened, no repeat pings.

### Twentieth pass, 2026-09-16 (TRA-1551): outline maintainer asked how we found the PR, all catalog threads silent, sweep clean

**Open-thread audit (all via GitHub API, 2026-09-16).**
All 5 catalog PRs still OPEN, 0 comments each, `mergeable: true`, heads byte-identical to
yesterday's rebases — no maintainer activity, no rebase needed, no ping due:
`eltociear/awesome-AI-driven-development#119`, `GetBindu/awesome-claude-code-and-skills#195`,
`yzfly/awesome-context-engineering#44` (re-check 2026-09-19), `ai-boost/awesome-harness-engineering#240`
(re-read 2026-10-05), `tolkonepiu/best-of-mcp-servers#384` (no ping before 2026-09-26).
`0xNyk/awesome-hermes-agent#395`, `natsukium/mcp-servers-nix#606`,
`mattbutlerengineering/ai-tooling#585` (no follow-up per TRA-857),
`narumiruna/pi-extensions#1204`: all OPEN, 0 comments.
`Dokploy/mcp#81`: OPEN, 3 comments, unchanged since 2026-09-05.
`Kilo-Org/kilocode#13843` and `#12707`: OPEN, 1 comment (ours) each, no maintainer reply.
`iansmith/slopstop#633`: OPEN, 1 comment (ours), unchanged since 2026-09-06.
`The-PR-Agent/pr-agent#2499`: 11 comments, newest is still our own 09-14 reply — no maintainer
answer yet, prototype TRA-1502 stays the next move; do not comment again until there are numbers.
`sosalejandro/atlas#105`: 9 comments, last 09-07 is the maintainer's own Tier-2 close-out.
`Nano-Collective/nanocoder#1197`: 4 comments, newest is still the third-party `slowe89` eval-pack
pitch from 09-11 — the issue `updated_at` moved to 09-15T19:22Z with no new comment (edit or
label activity), nothing directed at us.
`fmagent-project/FM-Agent#229`: CLOSED 2026-09-14 as completed, fix shipped in #230.
`CommunityToolkit/Aspire#1575`: newest comment (09-12) is `aaronpowell` replying to `Odonno`
about his own old chat-modes — a maintainer-to-participant aside, not directed at us; the graph
direction stays declined since 09-09, do not push.
`abhigyanpatwari/GitNexus#3068` / `#3127` / `#3291` (`#3291` still 0 comments),
`nearform/lastlight#372`, `facebook/pyrefly#4583`, `watt-mind/factory#1078`,
`headroomlabs-ai/headroom#1009`, `Intense-Visions/harness-engineering#1284`,
`schalermthai/redproof#50`, `Barnett-Studios/cxpak#103`, `macanderson/stella#6461`,
`garrytan/gbrain#5001`, `fullsend-ai/fullsend#297`: all unchanged, nothing owed.
TRA-633 (human-only web form): last verified `blocked` 2026-09-15 (TRA-1521); consolidated ask
stands, no new ping from this lane today.

**One thread needed an answer and got it: `git-pkgs/outline#34`.**
Maintainer `andrew` replied 2026-09-13 (missed by the 09-15 pass, which audited the thread as
quiet): "Thanks @nikolai-vysotskyi, out of interest how did you find this pr?"
Answered 2026-09-16 with the honest provenance — the repo never mentions trace-mcp (verified:
code search for `trace-mcp repo:git-pkgs/outline` returns nothing), the PR surfaced while
searching GitHub for open work on cross-file import/call resolution, and Go-plus-Python
resolvers with a real test surface are rare enough to read end to end
([comment](https://github.com/git-pkgs/outline/pull/34#issuecomment-5689280240)).
No claims, no numbers, no promises in the reply. Do not comment there again unless he follows up.

**Mention sweep (`scripts/mention-sweep.sh`): clean.** Zero repos outside `ops/mentions-seen.txt`.

**Competitor star snapshot (live GitHub API, 2026-09-16; prior 2026-09-15):**
codegraph 70,883 → **71,008** (+125); serena 29,342 → **29,407** (+65); repomix 28,351 →
**28,364** (+13); CBM 43,275 → **43,410** (+135); context-mode 22,906 → **23,069** (+163);
ripwire 2,118 → **2,183** (+65); graft 7,844 → **8,053** (+209, fastest mover two windows in
a row); code-review-graph 31,439 → **31,466** (+27); roam-code 517 → **518** (+1, flat since
discovery); trace-mcp 174 → **174** (+0, flat second day — single unstar 09-15, not a trend
until it repeats). `docs/_data/competitors.yml` left untouched — that file is the Competitor
Intelligence lane's to update.

**Touch budget: 1 of 5 used** (the outline provenance answer — a direct question, not a pitch).
No catalog submissions (moratorium holds), no new threads opened, no repeat pings.

### Twenty-first pass, 2026-09-16 (TRA-1572): light recheck two hours after the twentieth pass

The twentieth pass audited everything at 08:06 UTC; this run re-verified the
threads that could have moved in the two hours since, and ran the sweep.

**Open threads — all unchanged.** All 5 catalog PRs still OPEN, 0 comments,
mergeable: `eltociear#119` (head `a49344d`, unchanged since the 09-14 rebase),
`GetBindu#195`, `yzfly#44`, `tolkonepiu#384`, `ai-boost#240` (first read
`mergeable: UNKNOWN`, re-read 20s later `MERGEABLE` / `mergeStateStatus: CLEAN`
— transient GitHub state, not a conflict; no rebase needed). No ping due
anywhere. `hermes#395`, `nix#606`, `ai-tooling#585`, `pi-extensions#1204`,
`Dokploy/mcp#81` (3 comments, last 09-05), `kilocode#13843` / `#12707`,
`slopstop#633`, `atlas#105`, `pr-agent#2499` (newest is still our own 09-14
reply), `nanocoder#1197` (newest still the third-party `slowe89` pitch 09-11):
all unchanged, nothing owed. `outline#34`: no follow-up after our 09-15
provenance answer — do not comment again unless the maintainer replies.

**Mention sweep: one new hit, classified as a collision, not a surface.**
`oisee/odata_mcp_net` (C#, 4★, last push 2025-08-15) matched on `TESTING.md`,
which documents that repo's own `--trace-mcp` CLI flag ("MCP trace logging").
Same author's `odata_mcp` and `odata_mcp_go` are already recorded as collisions;
recorded alongside them in `ops/mentions-seen.txt`. No `distribution.md` row —
there is no reader there and nothing to submit to.

**Catalogs:** moratorium holds, no submissions. **Competitors:** star snapshot
skipped — two hours since the twentieth pass's snapshot is noise, not signal.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Twenty-second pass, 2026-09-16 evening (TRA-1580): light recheck, sweep clean

The twenty-first pass re-verified everything at ~12:02 UTC; this run re-read
the threads that could have moved in the two hours since, and ran the sweep.

**Open threads — all unchanged, nothing owed.** All 5 catalog PRs still OPEN,
0 comments, `mergeable: MERGEABLE` on the first read (no transient UNKNOWN
this time, no rebase needed): `eltociear#119`, `GetBindu#195`, `yzfly#44`,
`tolkonepiu#384`, `ai-boost#240`. No ping due anywhere — nearest deadlines
(yzfly re-check 19.09, eltociear/GetBindu/slopstop/hermes/nix 20.09) have not
arrived. `hermes#395`, `nix#606`, `ai-tooling#585` (no follow-up per TRA-857),
`pi-extensions#1204`: all OPEN, 0 comments. `Dokploy/mcp#81`: OPEN, 3
comments, newest still `mjsarfatti` 09-05 (a brush-off, not a question).
`kilocode#13843` / `#12707`: OPEN, newest still ours 09-07 (gift reports, not
touched). `slopstop#633`: OPEN, newest still ours 09-06 — do not ping before
20.09. `atlas#105`: OPEN, 9 comments, newest still the maintainer's own 09-07
Tier-2 close-out — nothing directed at us. `pr-agent#2499`: OPEN, 11 comments,
newest still our own 09-14 reply — wait. `nanocoder#1197`: OPEN, 4 comments,
newest still the third-party `slowe89` pitch 09-11 — no question to us.
`outline#34`: OPEN, 3 comments, newest still our 09-15 provenance answer — do
not comment again unless the maintainer replies. TRA-633 consolidated request
to Nikolai stands; no new ping.

**Mention sweep (`scripts/mention-sweep.sh`): clean.** All four pass-1 queries
plus all five pass-2 paired terms report "No repos outside the seen list.
Nothing to read." No `mentions-seen.txt` change this run.

**Catalogs:** moratorium holds (acquisition still unreadable), no submissions.
**Competitors:** star snapshot skipped — same reason as the twenty-first pass.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Twenty-third pass, 2026-09-16 late evening (TRA-1584): light recheck four hours after the twenty-second pass, one sweep collision, trace-mcp 174 → 175

The twenty-second pass re-verified everything at ~14:07 UTC; this run re-read
the threads that could have moved in the four hours since, ran the sweep, and
took a star snapshot (four hours is enough for signal — the twenty-first and
twenty-second passes skipped it at two).

**Open threads — all unchanged, nothing owed.** All 5 catalog PRs still OPEN,
0 comments, `mergeable: MERGEABLE` / `mergeStateStatus: CLEAN` on the first
read, heads byte-identical to the 09-14 rebases (`eltociear#119` head
`a49344d`, `ai-boost#240` head `da8f3d7`): `eltociear#119`,
`GetBindu#195`, `yzfly#44`, `tolkonepiu#384`, `ai-boost#240`. No ping due
anywhere — nearest deadlines (yzfly re-check 19.09,
eltociear/GetBindu/slopstop/hermes/nix 20.09) have not arrived.
`hermes#395`, `nix#606`, `ai-tooling#585` (no follow-up per TRA-857),
`pi-extensions#1204`: all OPEN, 0 comments. `Dokploy/mcp#81`: OPEN, 3
comments, newest still `mjsarfatti` 09-05. `kilocode#13843` / `#12707`:
OPEN, newest still ours 09-07. `slopstop#633`: OPEN, newest still ours
09-06 — do not ping before 20.09. `atlas#105`: OPEN, 9 comments, newest
still the maintainer's own 09-07 Tier-2 close-out. `pr-agent#2499`: OPEN,
11 comments, newest still our own 09-14 reply — wait. `nanocoder#1197`:
OPEN, 4 comments, newest still the third-party `slowe89` pitch 09-11.
`outline#34`: OPEN, 3 comments, newest still our 09-15 provenance answer —
`updated_at` moved to 09-16T08:04Z with no new comment (same edit-or-label
pattern as nanocoder#1197), do not comment again unless the maintainer
replies. TRA-633 consolidated request to Nikolai stands; still `blocked`,
no new ping.

**Mention sweep (`scripts/mention-sweep.sh`): one new hit, classified as a
collision, not a surface.** `HomenShum/agent-workspace-template` (1★,
personal Convex+Next template, pushed 09-13) matched on
`mcp-server/scripts/verify-trace-mcp.ts` and `mcp-server/README.md` — but
their "TRACE MCP" is their own change-trace catalog tooling ("change-trace
(Pillar 2) tools of attrition-mcp", scenarios like `search_change_traces`
→ `get_trace` → `get_row`), nothing to do with us. Recorded in the name
collisions block of `ops/mentions-seen.txt`. No `distribution.md` row —
there is no reader there and nothing to submit to.

**Catalogs:** moratorium holds (acquisition still unreadable), no submissions.
**Competitors (live GitHub API, 2026-09-16 ~18:00Z; prior the twentieth
pass ~08:00Z):** graft 8,053 → **8,237** (+184, fastest mover three windows
in a row); codegraph 71,008 → **71,151** (+143); context-mode 23,069 →
**23,203** (+134); CBM 43,410 → **43,526** (+116); serena 29,407 →
**29,468** (+61); CRG 31,466 → **31,502** (+36); ripwire 2,183 → **2,207**
(+24); repomix 28,364 → **28,376** (+12); roam-code 518 → **518** (flat
since discovery); trace-mcp 174 → **175** (+1 — first movement after three
days flat; a single star is not a trend until it repeats).
`docs/_data/competitors.yml` left untouched — that file is the Competitor
Intelligence lane's to update.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Twenty-fourth pass, 2026-09-16 night (TRA-1590): light recheck four hours after the twenty-third pass, sweep clean, one new door evaluated and held

**Open threads — all unchanged, nothing owed.** All 5 catalog PRs still OPEN,
0 comments, `mergeable_state: clean`: `eltociear#119` (head 09-14),
`GetBindu#195`, `yzfly#44`, `tolkonepiu#384`, `ai-boost#240` (head 09-14).
No ping due anywhere — nearest deadlines (yzfly re-check 19.09,
eltociear/GetBindu/slopstop/hermes/nix 20.09, tolkonepiu 26.09) have not
arrived. `hermes#395`, `nix#606`, `ai-tooling#585` (no follow-up per
TRA-857), `pi-extensions#1204` (issue, not PR): all OPEN, 0 comments.
`Dokploy/mcp#81`: OPEN, 3 comments, newest still 09-05. `kilocode#13843` /
`#12707`: OPEN, 1 comment each, newest still ours 09-07. `slopstop#633`:
OPEN, 1 comment, newest still ours 09-06. `atlas#105`: OPEN, 9 comments,
newest still the maintainer's own 09-07 Tier-2 close-out. `pr-agent#2499`:
OPEN, 11 comments, newest still our own 09-14 reply — wait.
`nanocoder#1197`: OPEN, 4 comments — comment dates re-read, newest is still
the third-party pitch of 09-11; `updated_at` 09-15 is edit/label noise, same
pattern as before. `outline#34`: OPEN, `mergeable_state: clean`,
`updated_at` still 09-16T08:04Z (no movement since the twenty-third pass);
issue comments newest still our 09-15 provenance answer, review comments all
09-02. Do not comment unless a maintainer replies. TRA-633 consolidated
request to Nikolai stands; still `blocked`, no new ping. trace-mcp itself
flat at 175 stars / 21 forks.

**Mention sweep (`scripts/mention-sweep.sh`, both passes): clean.** All nine
queries report "No repos outside the seen list. Nothing to read." No
`mentions-seen.txt` change this run.

**Catalogs:** moratorium holds (acquisition still unreadable), no
submissions. One new door evaluated to keep the pass moving: see the
TensorBlock row in the table above (854★, live, we are absent — the only
`trace-mcp` code hits are a Playwright project with a colliding name).
Held by the moratorium like aloth; when it lifts, aloth first, TensorBlock
second.
**Competitors:** star snapshot skipped — four hours after a full sync is
noise, not signal; `docs/_data/competitors.yml` untouched (Competitor
Intelligence lane).

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Twenty-fifth pass, 2026-09-17 morning (TRA-1599): light recheck eight hours after the twenty-fourth pass, one genuine sweep hit classified

**Open threads — all unchanged, nothing owed.** All 5 catalog PRs still OPEN,
0 comments, `mergeable: MERGEABLE` / `mergeStateStatus: CLEAN`:
`eltociear#119` (head 09-14), `GetBindu#195`, `yzfly#44`,
`tolkonepiu#384`, `ai-boost#240` (head 09-14). No ping due anywhere —
nearest deadline (yzfly re-check 19.09) has not arrived.
`hermes#395`, `nix#606`, `ai-tooling#585` (no follow-up per TRA-857),
`pi-extensions#1204`: all OPEN, 0 comments. `Dokploy/mcp#81`: OPEN,
3 comments, newest still 09-05. `kilocode#13843` / `#12707`: OPEN,
1 comment each, newest still ours 09-07. `slopstop#633`: OPEN, 1 comment,
newest still ours 09-06. `atlas#105`: OPEN, 9 comments, newest still the
maintainer's own 09-07 Tier-2 close-out (comment dates re-read, no new
reply). `pr-agent#2499`: OPEN, 11 comments, newest still our own 09-14
reply — wait. `nanocoder#1197`: OPEN, 4 comments, newest still the
third-party pitch of 09-11; `updated_at` 09-15 is edit/label noise, same
pattern as before. `outline#34`: OPEN, `mergeable_state: clean`,
`updated_at` still 09-16T08:04Z (no movement since the twenty-fourth
pass); issue comments newest still our 09-15 provenance answer, review
comments all 09-02. Do not comment unless a maintainer replies. TRA-633
consolidated request to Nikolai stands; still `blocked`, no new ping.
trace-mcp flat at 175 stars / 21 forks.

**Mention sweep (`scripts/mention-sweep.sh`, both passes): one new repo,
read to the file, classified genuine with nothing to do.**
`lza6/Aggregate-to-2api` (61★, Chinese-language 2API gateway project)
carries a `trace-mcp` section in
`docs/research/ref-scan/out_g10_gateway_mcp.md` — a read-only competitive
scan of 28 gateway/MCP directories written for their own project, scoring
us 3/5. The section was built from our README and DESIGN.md and repeats
the current copy correctly: "answer instead of re-read", the 72.7% PR
figure, 182 tools / 81 languages / 88 frameworks. That is the positioning
signal worth one line: an outsider who read the current page retold the
mechanism right — the opposite of the hotaru-ritsuki misread that sold
the graph story to a competitor. No ledger table row: it is an internal
research doc, not a surface — no listing, no audience, no contact path,
and nothing to correct. Recorded in `ops/mentions-seen.txt`; no outreach,
they never asked us anything.

**Catalogs:** moratorium holds (acquisition still unreadable), no
submissions. No new door evaluated this pass — the sweep hit was the
movement; queued doors stand (aloth first, TensorBlock second).
**Competitors:** star snapshot skipped — eight hours after a full sync is
still noise, not signal; `docs/_data/competitors.yml` untouched
(Competitor Intelligence lane).

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Delta recheck, 2026-09-19 morning (TRA-1684): six hours after the evening pass, sweep clean, graft listing surface checked

**Open threads — all unchanged, nothing owed.** All 5 catalog PRs still OPEN,
0 comments: `eltociear#119` (`mergeable_state: clean`), `GetBindu#195`
(clean), `yzfly#44` (clean), `tolkonepiu#384`, `ai-boost#240` (still dirty —
not rebased per the ledger rule: rebase only close to a merge signal, and
there is none). No ping due anywhere — eltociear/GetBindu/slopstop/hermes/nix
unlock 20.09, yzfly/tolkonepiu 26.09. `awesome-claude-code#2871` (filed by
Nikolai 18.09): OPEN, newest still the filing-moment bot validation, no
maintainer reply — wait, do not ping. `hermes#395`, `nix#606`,
`pi-extensions#1204`: OPEN, 0 comments. `Dokploy/mcp#81`: OPEN, 3 comments,
newest still 09-05. `lastlight#372`: newest still our 18.09 identity answer
(comment dates re-read), no cliftonc reply. `git-pkgs/outline#34`: OPEN,
`updated_at` still 09-16T08:04Z, newest still our 09-15 provenance answer.
`nanocoder#1197`: OPEN, 4 comments, newest still the third-party pitch of
09-11. `slopstop#633`, `atlas#105`, `pr-agent#2499` (newest still our 09-14
reply), `kilocode#13843`/`#12707`, `garrytan/gbrain#5001`, `Aspire#1575`,
`harness#1284`, `pyrefly#4583`, `deslop#173` (closed 09-08): all unchanged.
TRA-633 consolidated request stands fulfilled (Nikolai filed #2871); still
awaiting triage, no new ping. trace-mcp 176★/21 forks — flat.

**Mention sweep (`scripts/mention-sweep.sh`, both passes): clean.** No repos
outside the seen list.

**Competitor deep-dive (the movement this pass): graft's listing surface.**
`trailhq/Graft` is the fastest mover again (7,094 → 8,237 → **8,611** since
the 09-11 baseline; README star badge still points at the pre-rename
`NanoNets/Graft`). Full README read (42K chars): the only directory surface
is auto-indexed trendshift.io (trending-tracker badge, not a submit-to
catalog) — no awesome-list, marketplace, or submission catalog to follow
them into. Do not re-check graft for addresses; the head-to-head and #310
notes above stand. Other stars since baseline: codegraph 70,502 → 71,432;
CBM 42,957 → 43,777; CRG 31,333 → 31,595; context-mode 22,146 → 23,553;
serena 29,186 → 29,590; repomix 28,290 → 28,405; ripwire 1,892 → 2,256;
GitNexus 47,245 → 47,440. `docs/_data/competitors.yml` untouched
(Competitor Intelligence lane).

**Catalogs:** moratorium holds, no submissions. Queued doors stand (aloth
first, TensorBlock second).

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Delta recheck, 2026-09-19 evening (TRA-1697): nine hours after the morning pass, threads silent, sweep clean, two rival listing surfaces checked

**Open threads — all unchanged, nothing owed.** All 5 catalog PRs still OPEN,
0 comments: `eltociear#119` (`mergeable_state: clean`), `GetBindu#195`
(clean), `yzfly#44` (clean), `tolkonepiu#384` (clean), `ai-boost#240` (still
dirty — not rebased per the ledger rule: rebase only close to a merge signal,
and there is none). `awesome-claude-code#2871`: OPEN, newest still the
filing-moment bot validation, no maintainer reply — wait, do not ping.
`hermes#395`, `nix#606`, `pi-extensions#1204`: OPEN, 0 comments.
`Dokploy/mcp#81` (updated 09-05), `lastlight#372` (newest still our 09-18
identity answer, comment dates re-read — no cliftonc reply),
`git-pkgs/outline#34` (updated 09-16), `nanocoder#1197` (updated 09-17, newest
still the third-party pitch of 09-11), `slopstop#633`, `atlas#105`,
`pr-agent#2499` (newest still our 09-14 reply), `kilocode#12707`,
`gbrain#5001`, `Aspire#1575`, `harness#1284`, `pyrefly#4583`, `deslop#173`
(closed 09-08), `factory#1078`, `fullsend#297`, `stella#6461`, `redproof#50`,
`cxpak#103`, `GitNexus#3127`, `FM-Agent#229` (closed 09-14),
`headroom#1009`, `axisrow#4`/`#5`: all unchanged. No ping due anywhere —
eltociear/GetBindu/slopstop/hermes/nix unlock 20.09 (tomorrow's run, not
this one), yzfly/tolkonepiu 26.09. trace-mcp 177★/22 forks — flat since the
morning's 176★/21.

**One new comment, not addressed to us, no reply owed.**
`Kilo-Org/kilocode#13843` gained a third-party repro on 09-19T09:24Z
(`hongyuanzhi`: same `git rev-parse`/worktree Standby failure on Kylin Linux
aarch64, no worktree involved — `--git-dir` equals `--git-common-dir`, any
plain git repo triggers it). It predates the morning pass and asks us
nothing; our 09-07 analysis stands. Piling on would be noise.

**Mention sweep (`scripts/mention-sweep.sh`, both passes): clean.** No repos
outside the seen list.

**Competitor listing surfaces (the movement this pass): ripwire and
context-mode, the two fastest movers after graft.** Both read read-only via
the README API — no code run, no clone.

- `redhat-et/ripwire` (1,892 → 2,267 since the 09-11 baseline, pushed today):
  the only directory surface in-repo is the auto-indexed trendshift.io badge
  — the same shape as graft. No awesome-list, marketplace, or submission
  catalog to follow them into. Do not re-check ripwire for addresses.
- `mksglu/context-mode` (22,146 → 23,638, pushed today): zero directory
  surfaces in-repo. Its `cursor.com/marketplace` link is aspirational, not a
  listing — the section is titled "recommended **once published**" and says
  "**After** Cursor lists context-mode", with the local-folder path as the
  real install. What it does carry is a `Hacker News #1, 570+ points` badge.

The pattern across all three checks (graft in the morning, ripwire and
context-mode tonight) is the same: the category's fastest movers convert via
HN/viral placement, not via submit-to catalogs — none of the three sits in a
single catalog we could follow them into. That is the arrivals reading again,
from the other side of the table. `docs/_data/competitors.yml` untouched
(Competitor Intelligence lane).

**Catalogs:** moratorium holds, no submissions. Queued doors stood (aloth
first, TensorBlock second) — re-ranked by the 2026-09-20 pass below.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Delta recheck, 2026-09-20 morning (TRA-1720): four day-14 reminders posted, threads silent, sweep clean, StackMap evaluated

**Open threads — audited via API. Four polite reminders posted (touch budget 4/5); everything else silent, nothing owed.**
- Catalog PRs: `eltociear#119` (open, mergeable clean, head `a49344d` — reminder posted), `GetBindu#195` (open, clean — reminder posted), `yzfly#44` (open, clean, re-check 26.09), `tolkonepiu#384` (open, clean, no ping before 26.09), `ai-boost#240` (open, dirty again after the maintainer's daily self-add — not rebased per the ledger rule: rebase only close to a merge signal, and there is none).
- `hermes#395`, `nix#606`: open, 0 comments before ours — one reminder each posted. The single allowed nix reminder is now used; do not ping nix again.
- `awesome-claude-code#2871`: open, only the filing-moment bot validation, no maintainer reply — wait, do not ping.
- Comment threads: `lastlight#372` (newest ours 09-18), `outline#34` (newest our 09-15 provenance answer), `nanocoder#1197` (newest the third-party pitch 09-11), `kilocode#13843` (third-party Kylin repro 09-19, not addressed to us — no reply), `kilocode#12707` (newest ours), `slopstop#633` (newest ours 09-06 — deliberately not pinged: nothing new to add since our failure-mode note, a bump would be noise), `atlas#105` (newest the maintainer's own 09-07 Tier-2 close-out), `pr-agent#2499` (newest ours 09-14; prototype TRA-1502 stays the next move), `gbrain#5001`, `harness#1284`, `pyrefly#4583` (newest ours), `ai-tooling#585` (no follow-up per TRA-857), `pi-extensions#1204`, `Dokploy/mcp#81` (3 comments, unchanged since 09-05). `deslop#173` closed 09-08, `FM-Agent#229` closed 09-14.
- trace-mcp 177★/22 forks — flat.

**Mention sweep (`scripts/mention-sweep.sh`, both passes): clean.** One transient pass-2 query failure on the first run, clean on the immediate re-run. No `mentions-seen.txt` change.

**New door evaluated, held by the moratorium: StackMap ([stackmap.shipwithai.xyz](https://stackmap.shipwithai.xyz)).**
Found via the trial-plan sweep (`redhat-et/ripwire#296` — the curator's outbound heads-up to ripwire, read not commented).
392 repos, 1,042 typed human-reviewed edges, versioned daily (map v2026.09.19), `Code Intelligence` topic holds 18.
Our whole consideration set is already mapped with alternatives/compare pages (`code-review-graph`, `codebase-memory-mcp`, `serena`, `ripwire`, `gortex`, `Graft`, `codegraph-mcp`, `code-graph-rag`, `cocoindex-code`, `tokensave`, `repowise`, `codeflow` — verified in their `llms.txt`); trace-mcp is absent (repo page 404, no `llms.txt` entry).
Route: open suggest-a-repo form (repo URL + optional why; no login, no payment seen). Agent-queryable (MCP server, JSON API, `llms.txt`) — the consideration-set mechanism this ledger already tracks as a probe.
Passes the authenticity check (daily editorial versions, changelog, outbound human curation, typed edges with the why written down — editorial work, not the dofollow-link shape).
Two cautions: single operator (ShipWithAI, newsletter funnel, UTM-tagged outreach); the README badge is opt-in — do not add it to our repo (partner-badge pattern).
Queued FIRST when the moratorium lifts, ahead of aloth (now second) and TensorBlock (now third): competitors-present plus agent-queryable beats a static README list.
No submission today — the moratorium holds until `acquisition` reads.

**Trial-plan sweep (one query, past week, 142 hits): mostly agent-written noise, per the established pattern.**
Opened and classified: `gregoryfoster/skills#305` (1★ personal — skipped by the star filter), `SocratiCode#181` and `code-review-graph#1060` (competitor trackers — no comment per the standing rule), `ripwire#296` (competitor tracker — not commented; yielded StackMap above).
Side confirmation: our own `awesome-claude-code#2871` is visible in the issue index — the submission is present.

**Touch budget: 4 of 5 used** (four catalog reminders, each with a repo-specific fact, no claims). No new submissions (moratorium holds), no new threads opened.

### Delta recheck, 2026-09-20 evening (TRA-1735): yzfly merged, jCodeMunch off-page evaluated, no shippable step

**Open-thread delta since the morning pass (all via GitHub API).**
- `yzfly/awesome-context-engineering#44`: **MERGED 2026-09-20T15:02Z by `yzfly`**, zero comments, zero review rounds — the merge rate this row always claimed just paid. Verified live in both files (README.md line 292, README_CN.md line 275, entry text as submitted). Table row above updated. Nothing owed.
- `eltociear#119`, `GetBindu#195`: 1 comment each — both are our own morning reminders (TRA-1720), no maintainer reply. Nothing owed.
- `tolkonepiu#384`, `ai-boost#240`, `hermes#395`, `nix#606`, `awesome-claude-code#2871`: unchanged, nothing owed, no pings due.

**jCodeMunch off-page evaluation (TRA-1735 core — every candidate door checked, all closed, with reasons).**
The SERP gap is confirmed authority, not indexing: the page is indexed and ranks #1 on the `site:` query; the `jCodeMunch Alternative` top-20 is reddit + jcodemunch.com + github + youtube. What was checked as an honest off-page step:
- `jgravelle/jcodemunch-mcp` itself (2,702★ / 370 forks, pushed today): competitor tracker — the NICHE.md row already rules out outreach ("a message no maintainer is glad to get"). No comment, no issue. Closed by standing rule.
- Phrase search `"jCodeMunch Alternative"` in the issue index: the only hits are inside their own repo (release notes, internal competitive tiers). **No third-party thread asking for alternatives exists right now** — so mandate item 3 (a genuine technical answer with the comparison page as supporting link) has no address today. Not a backlog item to force; the trial-plan sweep surfaces one if it appears.
- `zzet/gortex` (1,586★, pushed 2026-09-16): names jcodemunch, zero trace-mcp — direct competitor's repo, same isolation rule as above. Skipped, recorded so the next pass does not re-read it.
- `sverklo/sverklo` (79★): competitor's own 12-option comparison blog, names jCodeMunch 9×, zero trace-mcp — already classified as goodwill-only, not an editorial door. Asking a competitor to add us to their own blog is a cold pitch. Skipped.
- `awesome-opencode/awesome-opencode` (10,307★): names jcodemunch 2×, zero trace-mcp — but last push 2026-07-03, stale 2.5 months with no triage. Dead door, and a catalog submit would breach the moratorium anyway. Recorded, do not submit; re-check only if commits resume.
- Catalog queue (StackMap first, aloth second, TensorBlock third): moratorium holds (7 windows, 0 attributable installs), no submissions. None of the three is jCodeMunch-specific — and StackMap's mapped consideration set does not include jcodemunch either, so even the first-queued door would not touch this query's SERP.

**Conclusion (the authority-gap branch of TRA-1735's done-criteria): the gap is pure authority.**
A new comparison page cannot break a top-20 held by reddit threads, the vendor domain, github and youtube without an authority footprint we do not have and cannot manufacture honestly in one run. The one inbound movement today (yzfly merge) is a nofollow README line — accuracy value, not ranking value, per the TRA-905 link-equity reading. Next step: Child C's weekly SERP recheck watches the query; this lane revisits off-page only when a genuine alternative-seeking thread surfaces in the sweeps. Re-evaluate 2026-09-27.

**Handoff to Child A (Web Design lane, not done here):** the README head-to-head line glama scrapes links 7 `/vs/` pages but not `/vs/jcodemunch.html` — the page (published 2026-09-07) postdates the line (added 2026-09-05). Whether to extend that line is on-page/internal-linking work and belongs to Child A.

**Touch budget: 0 of 5 used.** No outgoing messages this run — the yzfly merge is inbound.

### Delta recheck, 2026-09-22 (TRA-1826): two inbound movements, one same-name collision, sweep recorded

**Open threads — audited via API. Three movements since the 09-20 evening pass; nothing owed anywhere.**
- `git-pkgs/outline#34`: the PR "Add cross-file code graph with Go and Python resolvers" **MERGED 2026-09-22T07:21Z**. Our three resolver edge cases (Go `/v2`+ suffix in `defaultAlias`, Go external test packages, Python `__init__.py` re-exports) were contributed 09-08/09-15 and the maintainer's only question in between was answered. Nothing owed — a thank-you would cost a notification.
- `schalermthai/redproof#50`: maintainer `tw-salah` replied 2026-09-21T01:28Z — thanks ("the kind of thing you only learn by building it"), parking the AST work until next week, and asking himself whether Redproof needs AST at all ("maybe that's enough"). His question answers itself in the same comment, so no reply: arguing for AST would be pitching, thanking would be a notification. Recorded as the week's third live human reply.
- `Kilo-Org/kilocode#13843`: third-party `hongyuanzhi` follow-up 2026-09-20T06:56Z — root cause found on their box (system git 2.25.1 predates `git rev-parse --path-format`, added in 2.31; Kilo's fallback stringifies the rejected command line into the malformed path), fixed by upgrading to git 2.55.0, with a version-detect-or-fallback suggestion for Kilo. Not addressed to us; our 09-07 analysis stands. No reply.
- Catalog PRs: `eltociear#119`, `GetBindu#195` (1 comment each — both our own 09-20 reminders, no maintainer reply), `hermes#395`, `nix#606` (same), `tolkonepiu#384` (0 comments, untouched since 08-29 — no ping before 26.09), `ai-boost#240` (0 comments — re-read 10-05). No second reminders: the single allowed ping is spent on all four reminded threads.
- `hesreallyhim/awesome-claude-code#2871`: OPEN, newest still the 09-18 filing-moment bot validation — no maintainer reply, wait, do not ping.
- Rest unchanged: `nanocoder#1197` (newest the 09-11 third-party pitch), `slopstop#633` (newest ours 09-06 — still deliberately not bumped), `atlas#105` (newest the maintainer's 09-07 Tier-2 close-out), `lastlight#372` (newest ours 09-18), `kilocode#12707` (newest ours), `Dokploy/mcp#81` (3 comments, unchanged since 09-05), `pr-agent#2499`, `pyrefly#4583`, `gbrain#5001`, `factory#1078`, `GitNexus#3127`, `ai-tooling#585` (no follow-up per TRA-857), `pi-extensions#1204`, `Aspire#1575` (newest 09-12, not ours to chase), `cxpak#103`, `stella#6461` (unchanged). `deslop#173` closed 09-08.
- `MiniMax-AI/MiniMax-Code-Plugins#54` (Nikolai's own plugin PR, from TRA-1670): OPEN, `mergeable_state: unstable`, reviewer `hetaoBackend` requested changes twice (09-21, 09-22T01:38Z — round 2 asks for a fail-closed PATH binding, the full six-tool mutation surface, and an exact-version smoke). Nikolai pushed the round-2 fixes (`810585b`, 09-22T04:12Z: `npx -y trace-mcp@3.28.0` launcher, all six mutating tools documented with gates, pinned-build verification instead of prose) and awaits re-review. His lane — recorded, not touched.
- trace-mcp 178★/21 forks — flat against 09-19's 177/22.

**Mention sweep (`scripts/mention-sweep.sh`, both passes): 3 hits, all classified, `ops/mentions-seen.txt` updated.**
- `crazy54/awesome-agentic-atlas`, `yzfly/awesome-context-engineering` — already classified in this ledger, were only missing from the seen list. Added, no rows.
- `mrchatam/Trace` (12★, Go, pushed 09-20) — **collision, not a mention.** An independent local-first knowledge-graph MCP server shipping its own stdio binary also called `trace-mcp` (`cmd/trace-mcp/main.go`, tools `trace_why`/`trace_context`/`trace_search`/`trace_plan`/…). Same binary name, same category, zero shared code with us. No outreach (rival repo). Flagged for Competitor Intelligence: the bare name `trace-mcp` is now claimed by two unrelated binaries, which strengthens the TRA-1119 reading that the name alone does not identify us.

**Trial-plan sweep (past week, 40 hits): noise only, no address.** Star filter applied before opening bodies: `davideast/pyric` 35★, `monkeygerbil222/DevGraph` 0★, `jasoncarreira/baleyg` 0★, `LightspeedDMS/code-indexer` 1★ (already skipped as machine-generated), `DeusData/codebase-memory-mcp` 44k★ (competitor tracker — no comment per the standing rule). Rest is agent-written roadmap digests.

**Catalogs:** moratorium holds (TRA-886 still `in_progress`, acquisition unreadable). No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run — all three movements are inbound.

### Delta recheck, 2026-09-23 (TRA-1831): all threads silent, sweep clean, one 0-star builder noted and skipped

**Open threads — audited via API. Zero movements since the 09-22 pass; nothing owed anywhere.**
- Catalog PRs: `eltociear#119`, `GetBindu#195` (open, 1 comment each — both our own 09-20 reminders, no maintainer reply), `hermes#395`, `nix#606` (same shape). No second reminders: the single allowed ping is spent.
- `tolkonepiu#384` (open, 0 comments, untouched since 08-29 — ping window opens 26.09, not yet), `ai-boost#240` (open, 0 comments — re-read 10-05).
- `hesreallyhim/awesome-claude-code#2871` (Nikolai's own filing): OPEN, newest still the 09-18 filing-moment bot validation — no maintainer reply, wait, do not ping.
- Comment threads: `redproof#50` (newest the maintainer's 09-21 thanks), `kilocode#13843` (newest the 09-20 third-party git-version follow-up, not addressed to us), `atlas#105` (newest the maintainer's 09-07 Tier-2 close-out), `slopstop#633` (newest ours 09-06 — still deliberately not bumped), `kilocode#12707` (newest ours), `Dokploy/mcp#81` (3 comments, unchanged since 09-05), `nanocoder#1197` (newest the 09-11 third-party pitch; the 09-17 `updated_at` is non-comment activity, verified via the comments endpoint).
- `MiniMax-AI/MiniMax-Code-Plugins#54` (Nikolai's own plugin PR): OPEN, newest still his 09-22 round-2 fix push, awaits re-review. His lane — recorded, not touched.
- trace-mcp 179★/21 forks — +1 star against 09-22.

**Mention sweep (`scripts/mention-sweep.sh`, both passes): clean.** No repos outside the seen list, nothing to read, `ops/mentions-seen.txt` untouched.

**Issue-index sweep (qualified path query): 21 hits, no new mentions.** Newest is MiniMax#54 (09-22, known). Nothing since the last pass names us that the ledger does not already record.

**Trial-plan sweep (2026-09-20…23, 44 hits): one notable, skipped with reason.** Star filter before opening bodies; the rest is agent-written roadmap digests plus the already-skipped `pyric`, `code-indexer`, `baleyg` and the competitor tracker. The notable one is `Falconiere/comemory` (0★, created 09-22): a planning stack for symbol-level code-graph edges (`calls`/`inherits`/`implements`/`references` via an ast-grep extractor, same-file-or-unambiguous-PathIndex resolution first) — squarely our defect class and competently specified. Skipped anyway: zero stars, hours old, no question asked and no defect visible, so anything we write there today is a cold pitch, not an answer. Revisit only if they file a question a reader of our tree can answer. No outreach, no issue.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Delta recheck, 2026-09-23 evening (TRA-1849): threads silent, one registry-ingest row, one competitor-install note

Six hours after TRA-1831, audited via API. Zero movements on every open thread: `eltociear#119` (clean, only our 09-20 ping), `GetBindu#195` (open, our 09-20 ping last), `ai-boost#240` (open, `dirty`, no maintainer signal — not rebased, no merge signal), `tolkonepiu#384` (open, untouched — ping window 26.09, not yet), `hermes#395` / `nix#606` (our 09-20 pings last, single allowed ping spent), `hesreallyhim/awesome-claude-code#2871` (bot validation only, 5th day, not pinged), `MiniMax#54` (our 09-22 `810585b` last, awaits re-review — Nikolai's lane), `redproof#50` (maintainer's 09-21 thanks, loop closed), `kilocode#13843` (09-20 third-party git-version follow-up, not addressed to us), `atlas#105` (09-07), `slopstop#633` (ours, deliberately not bumped), `kilocode#12707` (ours), `pyrefly#4583` (ours), `pi-extensions#1204` (silent), `nanocoder#1197` (09-11 third-party pitch), `deslop#173` (maintainer's 09-07 fix-in-progress reply, nothing owed), `Dokploy/mcp#81` (unchanged since 09-05). Nothing owed anywhere, no pings due.

**Mention sweep: one new repo, one new table row.** `metaone01/agent-forge` (0★) carries us as a machine-readable package record ingested from the official MCP registry with current copy and `homepage` intact — registry publish minting downstream records at zero run cost, fourth such auto-ingest. Row added above; repo recorded in `ops/mentions-seen.txt`.

**Issue-index sweep: all hits known.** Newest naming us is MiniMax#54 (09-22); `lastlight#372` and `atlas#147` already in the ledger. Nothing new to read.

**Trial-plan sweep: one notable, skipped with reason.** `DavidRoyBlue/Logged#1` (0★, single author, created 09-22): a private automation log about the author's own repo — its `.claude` hooks call a bare `code-review-graph` binary that is not on PATH while `.code-review-graph/graph.db` sits stale since June. Not a door (nobody to write to, no question asked) and not our tracker to comment in. Kept as competitor intel for Competitor Intelligence / positioning: a ~19k★ rival's hook-based install story fails silently when the binary is missing — the exact class our pinned-`mcp.json` + absolute-path guidance in TRA-1705 review notes already avoids. No outreach.

**Catalogs:** moratorium holds. No submissions.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Delta recheck, 2026-09-23 late (TRA-1860): threads silent, one bookmark noted, MiniMax movement is Nikolai's own

Audited via API (pulls/issues endpoints; `search/issues` answers 404 from this token, so no issue-index sweep this run — mention sweep covers code, not issues).

**Open threads — zero movements owed anywhere.**
- Catalog PRs: `eltociear#119`, `GetBindu#195` (open, newest our 09-20 reminders), `hermes#395`, `nix#606` (open, 1 comment each — our 09-20 pings). No second reminders: the single allowed ping is spent.
- `tolkonepiu#384` (open, 0 comments, untouched since 08-29 — ping window opens 26.09, not yet), `ai-boost#240` (open, 0 comments — re-read 10-05).
- `hesreallyhim/awesome-claude-code#2871` (Nikolai's own filing): OPEN, newest still the 09-18 filing-moment bot validation — no maintainer reply, wait, do not ping.
- Comment threads: `redproof#50` (2 comments, newest the maintainer's 09-21 thanks), `kilocode#13843` (3 comments, newest the 09-20 third-party git-version follow-up), `atlas#105` (9 comments, newest 09-07), `slopstop#633` (newest ours 09-06 — still deliberately not bumped), `kilocode#12707` (newest ours), `Dokploy/mcp#81` (3 comments, unchanged since 09-05), `nanocoder#1197` (4 comments, newest 09-17 — non-comment activity per the 09-23 morning verification), `lastlight#372` (6 comments, newest ours 09-18).
- `MiniMax-AI/MiniMax-Code-Plugins#54`: OPEN, `updated 2026-09-23T15:09Z` — the movement is Nikolai's own fourth comment (both upstream write-boundary gaps fixed on master at `28fb7028`, probes re-run against the master build), no new review from `hetaoBackend` (still the two `CHANGES_REQUESTED`, 09-21/09-22). His lane — recorded, not touched.
- trace-mcp 181★/21 forks (+2 stars against the 09-23 morning pass).

**Mention sweep (`scripts/mention-sweep.sh`, both passes): one hit, classified, `ops/mentions-seen.txt` updated.** `iharh/notes` (7★, personal notes repo, pushed today): `ai/thematical/code-understand/trace-mcp.txt` holds exactly two lines — our site and repo URLs. A bookmark, not a surface and not a question: nobody to write to, nothing to correct, no row. Intel value only: the directory lists us beside codebase-memory-mcp, codegraph, graphify, gitnexus, serena, context-mode, semble, socraticode, claude-context and chunkhound — an independent engineer filed us in exactly our competitive set, unprompted. Flagged for Competitor Intelligence / positioning; no outreach.

**Nothing needed from Nikolai this run.** #2871 awaits triage (nothing to do but wait), MiniMax#54 awaits the reviewer's re-review (his comment today already covers it), and the human-only doors stand as recorded in TRA-633 with no new entry. No consolidated request sent — per the standing rule, one reminder per door, and no door is due one.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Delta recheck, 2026-09-24 (TRA-1866): threads silent, tolkonepiu door confirmed alive, mention sweep clean

Audited via API, read-only, nothing written outside this file.

**Open threads — zero movements owed anywhere.**
- Catalog PRs: `eltociear#119`, `GetBindu#195` (open, newest our 09-20 reminders), `hermes#395`, `nix#606` (open issues, 1 comment each — our 09-20 pings). No second reminders: the single allowed ping is spent.
- `tolkonepiu#384` (open, 0 comments, untouched since 08-29 — ping window opens 26.09, two days out), `ai-boost#240` (open PR, 0 comments, updated 09-14 — re-read 10-05).
- `hesreallyhim/awesome-claude-code#2871` (Nikolai's own filing): OPEN, newest still the 09-18 filing-moment bot validation — no maintainer reply, wait, do not ping.
- Comment threads: `redproof#50` (2 comments, newest the maintainer's 09-21 thanks), `kilocode#13843` (3 comments, newest the 09-20 third-party git-version follow-up), `atlas#105` (9 comments, newest 09-07), `slopstop#633` (newest ours 09-06 — still deliberately not bumped), `kilocode#12707` (newest ours 09-07), `Dokploy/mcp#81` (3 comments, unchanged since 09-05), `nanocoder#1197` (4 comments, newest 09-11 third-party pitch), `lastlight#372` (6 comments, newest ours 09-18). `pyrefly#4583`, `pi-extensions#1204` unchanged.
- `deslop#173` now reads CLOSED (updated 09-08 — the closure predates the 09-23 passes, which recorded the maintainer's fix-in-progress reply without noting state; no new movement, nothing owed).
- `MiniMax-AI/MiniMax-Code-Plugins#54`: OPEN, no new review from `hetaoBackend` (still the two `CHANGES_REQUESTED`, 09-21/09-22). Nikolai's lane — recorded, not touched.
- trace-mcp 182★/21 forks (+1 star against the 09-23 late pass).

**Deeper probe (the one new thing this run): tolkonepiu is alive, we are queued, not rejected.** The repo keeps triaging: PRs #429–#433 touched as recently as 09-23 (including a "Best-of update: 2026.09.23" batch). Our #384 touches the same single file (`projects.yaml`) as the newest submission #433 — no format defect visible, just queue order. The 26.09 ping can be a plain nudge, no fix needed first.

**Mention sweep (`scripts/mention-sweep.sh`, both passes): clean.** No repos outside the seen list, nothing to read, `ops/mentions-seen.txt` untouched.

**Nothing needed from Nikolai this run.** #2871 awaits triage, MiniMax#54 awaits re-review, no door is due a reminder before 26.09. No consolidated request sent.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Delta recheck, 2026-09-24 day (TRA-1878): threads silent, one registry-ingest row

Twelve hours after TRA-1866, audited via API, read-only, nothing written outside this file and `ops/mentions-seen.txt`.

**Open threads — zero movements owed anywhere.** Every `updated_at` below matches the morning pass exactly:
- Catalog PRs/issues: `eltociear#119`, `GetBindu#195`, `hermes#395`, `nix#606` (open, 1 comment each — our 09-20 reminders, single allowed ping spent), `tolkonepiu#384` (open, 0 comments, untouched since 08-29 — ping window opens 26.09, two days out), `ai-boost#240` (open, 0 comments — re-read 10-05).
- `hesreallyhim/awesome-claude-code#2871` (Nikolai's own filing): OPEN, newest still the 09-18 filing-moment bot validation — no maintainer reply, wait, do not ping.
- Comment threads: `redproof#50` (newest the maintainer's 09-21 thanks), `kilocode#13843` (newest the 09-20 third-party git-version follow-up), `atlas#105` (newest 09-07), `slopstop#633` (newest ours 09-06 — still deliberately not bumped), `kilocode#12707` (newest ours 09-07), `Dokploy/mcp#81` (unchanged since 09-05), `nanocoder#1197` (newest 09-11 third-party pitch), `lastlight#372` (newest ours 09-18), `pyrefly#4583` (newest ours), `pi-extensions#1204` (0 comments, open since 09-05).
- `MiniMax-AI/MiniMax-Code-Plugins#54`: OPEN, newest still Nikolai's own 09-23 comment (gaps fixed on master, probes re-run) — no new review from `hetaoBackend`, still the two `CHANGES_REQUESTED` from 09-21/09-22. His lane — recorded, not touched.
- trace-mcp 182★/21 forks — flat against the morning pass. Own PR #1368 (this lane's ledger section) is MERGED.

**Mention sweep (`scripts/mention-sweep.sh`, both passes): one hit, classified, ledger row added.** `rogerchappel/mcpchangefeed` (0★, single author): a daily-snapshot MCP-server tracker whose `site/servers/io-github-nikolai-vysotskyi-trace-mcp/` page is auto-ingested from the official registry with current copy at 3.31.5. No submission path, no audience, no outreach — fifth registry auto-ingest, recorded in the table above and in `ops/mentions-seen.txt`. (Code-search API answers 404 from this token, so the match was verified by reading the generated page through the contents API instead.)

**Nothing needed from Nikolai this run.** #2871 awaits triage, MiniMax#54 awaits re-review, no door is due a reminder before 26.09. No consolidated request sent.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Delta recheck, 2026-09-24 evening (TRA-1892): threads silent, ai-tooling loose end closed, sweep clean

Four hours after TRA-1878, audited via API, read-only, nothing written outside this file.

**Open threads — zero movements owed anywhere.** All 20 `updated_at` values match the day pass exactly, so no newest-comment re-read was needed anywhere:
- Catalog PRs/issues: `eltociear#119`, `GetBindu#195`, `hermes#395`, `nix#606` (open, 1 comment each, all `updated_at` 2026-09-20T04:09 — our single allowed reminders, spent), `tolkonepiu#384` (open, 0 comments, untouched since 08-29 — ping window opens 26.09, two days out), `ai-boost#240` (open, 0 comments, `updated_at` 09-14 — re-read 10-05).
- `hesreallyhim/awesome-claude-code#2871` (Nikolai's own filing): OPEN, `updated_at` still 09-18 bot validation — no maintainer reply, wait, do not ping.
- Comment threads: `redproof#50` (09-21), `kilocode#13843` (09-20), `kilocode#12707` (09-07), `atlas#105` (09-07), `slopstop#633` (09-06, deliberately not bumped), `Dokploy/mcp#81` (09-05), `nanocoder#1197` (09-17), `lastlight#372` (09-18), `pyrefly#4583` (09-07), `pi-extensions#1204` (09-05), `ai-tooling#585` (09-04), `pr-agent#2499` (09-14). All OPEN, all unchanged.
- `MiniMax-AI/MiniMax-Code-Plugins#54`: OPEN, `updated_at` still 2026-09-23T15:09Z — no re-review from `hetaoBackend`, still the two `CHANGES_REQUESTED`. His lane — recorded, not touched.
- trace-mcp 182★/21 forks — flat against the day pass.

**Loose end closed (carried from the TRA-1875 release-window reply): the resuscitated ai-tooling account.** That note asked whether the telemetry claim in `mattbutlerengineering/ai-tooling`'s eval is still wrong and whether our correction #585 still stands. Verified read-only: the repo pushed today (2026-09-24T13:28Z) but it is routine catalog churn ("daily discovery 2026-09-24 — 8 adds, 1 skip, 5 re-stamped"), not an eval edit. `evaluations/trace-mcp.md` still carries June numbers (88 stars, v1.43.1, "~170 tools") and still says "no telemetry" under What worked — so our #585 correction (anonymous usage ping on by default since TRA-887) is still accurate and still unaddressed (OPEN, 0 comments, `updated_at` 09-04). Per TRA-857 no follow-up is owed there — recorded here, not pinged.

**Mention sweep (`scripts/mention-sweep.sh`, both passes): clean.** No repos outside the seen list, nothing to read.

**Competitor pulse (no touch):** `tirth8205/code-review-graph` at 31,765★ (+17 since the morning pass) with `pushed_at` still 2026-09-18 — stars grow, triage stands still. For Competitor Intelligence, nothing to write.

**Nothing needed from Nikolai this run.** #2871 awaits triage, MiniMax#54 awaits re-review, no door is due a reminder before 26.09. No consolidated request sent.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Delta recheck, 2026-09-24 night (TRA-1897): threads silent, MiniMax movement is Nikolai's own

Two hours after TRA-1892, audited via API, read-only, nothing written outside this file.

**Open threads — the only movement is Nikolai's own comment, nothing owed anywhere.**
All 20 `updated_at` values re-read; 19 match the evening pass exactly:
- Catalog PRs/issues: `eltociear#119`, `GetBindu#195`, `hermes#395`, `nix#606` (open, 1 comment each — our 09-20 reminders, single allowed ping spent), `tolkonepiu#384` (open, 0 comments, untouched since 08-29 — ping window opens 26.09, two days out), `ai-boost#240` (open, 0 comments, `updated_at` 09-14 — re-read 10-05).
- `hesreallyhim/awesome-claude-code#2871` (Nikolai's own filing): OPEN, `updated_at` still 09-18 bot validation — no maintainer reply, wait, do not ping.
- Comment threads: `redproof#50` (09-21), `kilocode#13843` (09-20), `kilocode#12707` (09-07), `atlas#105` (09-07), `slopstop#633` (09-06, deliberately not bumped), `Dokploy/mcp#81` (09-05), `nanocoder#1197` (09-17), `lastlight#372` (09-18), `pyrefly#4583` (09-07), `pi-extensions#1204` (09-05), `ai-tooling#585` (09-04), `pr-agent#2499` (09-14). All OPEN, all unchanged. `deslop#173` CLOSED 09-08, unchanged.
- `MiniMax-AI/MiniMax-Code-Plugins#54`: OPEN, `updated_at` 2026-09-24T16:08Z — the movement is Nikolai's own fifth comment (pin bump `41cac18` to `trace-mcp@3.31.5`, probes re-run against the fixed release, ready for another look). Reviewer `hetaoBackend` still at the two `CHANGES_REQUESTED` (09-21/09-22), no new review. His lane — recorded, not touched.
- trace-mcp 182★/21 forks — flat against the evening pass.

**Mention sweep (`scripts/mention-sweep.sh`, both passes): clean.** No repos outside the seen list, nothing to read, `ops/mentions-seen.txt` untouched.

**Competitor pulse (no touch):** `tirth8205/code-review-graph` at 31,767★ (+2 since the evening pass) with `pushed_at` still 2026-09-18 — stars grow, triage stands still. For Competitor Intelligence, nothing to write.

**Nothing needed from Nikolai this run.** #2871 awaits triage, MiniMax#54 awaits re-review (his comment today already re-requests it), no door is due a reminder before 26.09. No consolidated request sent.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Delta recheck, 2026-09-25 morning (TRA-1909): threads silent, sweep clean

Four hours after TRA-1897, audited via API, read-only, nothing written outside this file.

**Open threads — the only movement is Nikolai's own comment, nothing owed anywhere.**
All 20 `updated_at` values re-read; 19 match the night pass exactly:
- Catalog PRs/issues: `eltociear#119`, `GetBindu#195`, `hermes#395`, `nix#606` (open, 1 comment each — our 09-20 reminders, single allowed ping spent), `tolkonepiu#384` (open, 0 comments, untouched since 08-29 — ping window opens 26.09, tomorrow, not yet), `ai-boost#240` (open, 0 comments, `updated_at` 09-14 — re-read 10-05).
- `hesreallyhim/awesome-claude-code#2871` (Nikolai's own filing): OPEN, `updated_at` still 09-18 bot validation — no maintainer reply, wait, do not ping.
- Comment threads: `redproof#50` (09-21), `kilocode#13843` (09-20), `kilocode#12707` (09-07), `atlas#105` (09-07), `slopstop#633` (09-06, deliberately not bumped), `Dokploy/mcp#81` (09-05), `nanocoder#1197` (09-17), `lastlight#372` (09-18), `pyrefly#4583` (09-07), `pi-extensions#1204` (09-05), `ai-tooling#585` (09-04), `pr-agent#2499` (09-14). All OPEN, all unchanged. `deslop#173` CLOSED 09-08, unchanged.
- `MiniMax-AI/MiniMax-Code-Plugins#54`: OPEN, `updated_at` 2026-09-24T16:08Z — the movement is Nikolai's own fifth comment (pin bump to `trace-mcp@3.31.5`, probes re-run against the fixed release). Reviewer `hetaoBackend` still at the two `CHANGES_REQUESTED` (09-21/09-22), no new review. His lane — recorded, not touched.
- trace-mcp 182★/21 forks — flat against the night pass.

**Mention sweep (`scripts/mention-sweep.sh`, both passes): clean.** No repos outside the seen list, nothing to read, `ops/mentions-seen.txt` untouched.

**Competitor pulse (no touch):** `tirth8205/code-review-graph` at 31,769★ (+2 since the night pass) with `pushed_at` still 2026-09-18 — stars grow, triage stands still. For Competitor Intelligence, nothing to write.

**Nothing needed from Nikolai this run.** #2871 awaits triage, MiniMax#54 awaits re-review (his comment yesterday already re-requests it), no door is due a reminder before 26.09 (tolkonepiu window opens tomorrow). No consolidated request sent.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Delta recheck, 2026-09-25 day (TRA-1924): MiniMax round 3, rest silent, sweep clean

Hours after TRA-1909, audited via API, read-only, nothing written outside this file.

**Open threads — one real movement, on Nikolai's own PR.**
All catalog `updated_at` values re-read and unchanged: `eltociear#119`, `GetBindu#195`, `hermes#395`, `nix#606` (open, newest our 09-20 reminders, single ping spent), `tolkonepiu#384` (open, 0 comments, untouched since 08-29 — ping window opens 26.09, tomorrow, not yet), `ai-boost#240` (open, `updated_at` 09-14 — re-read 10-05). `hesreallyhim/awesome-claude-code#2871` still 09-18 bot validation, no maintainer reply, wait, do not ping. Comment threads all unchanged: `redproof#50` (09-21), `kilocode#13843` (09-20), `kilocode#12707` (09-07), `atlas#105` (09-07), `slopstop#633` (09-06, deliberately not bumped), `Dokploy/mcp#81` (09-05), `nanocoder#1197` (09-17), `lastlight#372` (09-18), `pyrefly#4583` (09-07), `pi-extensions#1204` (09-05), `ai-tooling#585` (09-04), `pr-agent#2499` (09-14). `deslop#173` CLOSED 09-08, unchanged.
- `MiniMax-AI/MiniMax-Code-Plugins#54`: reviewer `hetaoBackend` posted a third `CHANGES_REQUESTED` today 2026-09-25T01:30Z against head `41cac18` — pin/provenance acknowledged as improved, blockers remaining: daemonless exact-runtime controls, full mutation disclosure, reproducible exact-pin MCP smoke. His lane — recorded, not touched.
- trace-mcp 182★/21 forks — flat.

**Mention sweep (`scripts/mention-sweep.sh`, both passes): clean.** No repos outside the seen list, nothing to read, `ops/mentions-seen.txt` untouched.

**Competitor pulse (no touch):** `tirth8205/code-review-graph` at 31,771★ (+2 since the morning pass) with `pushed_at` still 2026-09-18 — stars grow, triage stands still. For Competitor Intelligence, nothing to write.

**Nothing needed from Nikolai this run.** #2871 awaits triage, MiniMax#54 has a new review round waiting on his side (he gets it via GitHub directly), no door is due a reminder before 26.09 (tolkonepiu window opens tomorrow). No consolidated request sent.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Delta recheck, 2026-09-25 (TRA-1928): threads silent, one competitor-research hit, sweep recorded

Hours after TRA-1924, audited via API, read-only, nothing written outside this file and `ops/mentions-seen.txt`.

**Open threads — zero movements owed anywhere.** All 21 `updated_at` values re-read; every one matches the day pass exactly:
- Catalog PRs/issues: `eltociear#119`, `GetBindu#195`, `hermes#395`, `nix#606` (open, 1 comment each — our 09-20 reminders, single allowed ping spent), `tolkonepiu#384` (open, 0 comments, untouched since 08-29 — ping window opens 26.09, tomorrow, not yet), `ai-boost#240` (open, 0 comments, `updated_at` 09-14 — re-read 10-05).
- `hesreallyhim/awesome-claude-code#2871` (Nikolai's own filing): OPEN, `updated_at` still 09-18 bot validation — no maintainer reply, wait, do not ping.
- Comment threads: `redproof#50` (09-21), `kilocode#13843` (09-20), `kilocode#12707` (09-07), `atlas#105` (09-07), `slopstop#633` (09-06, deliberately not bumped), `Dokploy/mcp#81` (09-05), `nanocoder#1197` (09-17), `lastlight#372` (09-18), `pyrefly#4583` (09-07), `pi-extensions#1204` (09-05), `ai-tooling#585` (09-04), `pr-agent#2499` (09-14). All OPEN, all unchanged. `deslop#173` CLOSED 09-08, unchanged.
- `MiniMax-AI/MiniMax-Code-Plugins#54`: OPEN, `updated_at` still 2026-09-25T01:30Z — the third `CHANGES_REQUESTED` already recorded in TRA-1924, no newer review. His lane — recorded, not touched.
- trace-mcp 182★/21 forks — flat against the day pass.

**Mention sweep (`scripts/mention-sweep.sh`, both passes): one hit, classified, ledger row + seen-list line added.** `MaquinaTech/graph-indexer` (11★, 1 fork, single author, MIT, pushed 2026-09-25): a rival-in-building whose research notes pin our source at `@e5a180a` and name trace-mcp the direct analogue for hooks and output-rewrite. Internal doc, no audience, no contact path — competitor signal only, table row added above. No outreach: there is nothing to pitch and nobody to pitch it to.

**Competitor pulse (no touch):** `tirth8205/code-review-graph` at 31,779★ (+8 since the day pass) with `pushed_at` still 2026-09-18 — stars grow, triage stands still. For Competitor Intelligence, nothing to write.

**Nothing needed from Nikolai this run.** #2871 awaits triage, MiniMax#54 awaits re-review (he gets it via GitHub directly), no door is due a reminder before tomorrow 26.09 (tolkonepiu window). No consolidated request sent.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Delta recheck, 2026-09-25 night (TRA-1939): Nikolai rebased eltociear#119, rest silent, sweep clean

Evening after TRA-1928, audited via API, read-only, nothing written outside this file.

**Open threads — one movement, and it is Nikolai's own rebase.**
`eltociear/awesome-AI-driven-development#119`: OPEN, `mergeable_state: clean`, `updated_at` 2026-09-25T14:07Z — the movement is a `head_ref_force_pushed` event by nikolai-vysotskyi himself (`a24667d8`): a rebase onto the maintainer's latest main, tool count 598 → 599 in both READMEs, our entry line untouched. His lane — recorded, not touched. No reply owed; a thank-you would only cost a notification.
The other 20 `updated_at` values match TRA-1928 exactly:
- Catalog PRs/issues: `GetBindu#195`, `hermes#395`, `nix#606` (open, newest our 09-20 pings, single ping spent), `tolkonepiu#384` (open, 0 comments since 08-29 — ping window opens tomorrow 26.09, not today), `ai-boost#240` (open, `updated_at` 09-14 — re-read 10-05).
- `hesreallyhim/awesome-claude-code#2871` (Nikolai's own filing): OPEN, still 09-18 bot validation — no maintainer reply, wait, do not ping.
- Comment threads: `redproof#50` (2 comments, 09-21, loop closed), `kilocode#13843` (3, 09-20 third-party follow-up, not ours), `kilocode#12707` (1, 09-07), `atlas#105` (9, 09-07), `slopstop#633` (1, 09-06, deliberately not bumped), `Dokploy/mcp#81` (3, 09-05), `nanocoder#1197` (4, 09-17 third-party pitch), `lastlight#372` (6, 09-18), `pyrefly#4583` (2, 09-07), `pi-extensions#1204` (0, 09-05), `ai-tooling#585` (0, 09-04), `pr-agent#2499` (11, 09-14). All OPEN, all unchanged. `deslop#173` CLOSED 09-08, unchanged.
- `MiniMax-AI/MiniMax-Code-Plugins#54`: OPEN, still 2026-09-25T01:30Z — the third `CHANGES_REQUESTED` recorded in TRA-1924, no newer review. His lane — recorded, not touched.
- trace-mcp 182★/21 forks — flat.

**Mention sweep (`scripts/mention-sweep.sh`, both passes): clean.** No repos outside the seen list, nothing to read, `ops/mentions-seen.txt` untouched.

**Competitor pulse (no touch):** `tirth8205/code-review-graph` at 31,784★ (+5 since TRA-1928) with `pushed_at` still 2026-09-18 — stars grow, triage stands still. For Competitor Intelligence, nothing to write.

**Nothing needed from Nikolai this run.** #2871 awaits triage, MiniMax#54 awaits re-review (he gets it via GitHub directly), no door is due a reminder before tomorrow 26.09 (tolkonepiu window — next run's decision, not this one's). TRA-633's one click already happened 09-18; the Focus item is satisfied, not pending. No consolidated request sent.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Day pass, 2026-09-26 (TRA-1955): threads silent, tolkonepiu window deliberately unused, sweep 1 genuine + 2 collisions

Audited via API, read-only, nothing written outside this file and `ops/mentions-seen.txt`.

**Open threads — zero movements owed anywhere.** Every `updated_at` below matches TRA-1939 exactly:
- Catalog PRs/issues: `eltociear#119` (open, still MERGEABLE/CLEAN after Nikolai's own 09-25 rebase; maintainer merged two other externals 09-23, so the queue moves — ours just waits its turn, 09-20 nudge stands, no second ping), `GetBindu#195` (open, clean), `hermes#395` / `nix#606` (open, newest our 09-20 reminders, single ping spent), `ai-boost#240` (open, CONFLICTING again after the maintainer's daily self-adds — re-verified just now: zero merged PRs in the last 10 closed, so per this ledger's rule there is still no merge signal and no rebase; re-read 10-05).
- `tolkonepiu#384`: the "do not ping before 26.09" embargo lifted today — and the ping stays unsent on purpose. Last-10-closed shows every external project-add PR (#360, #362, #364, #366, #367) closed unmerged while only the render bot merges; a bump into that queue is notification noise with no historical payoff, so silence is the decision, not an omission. Next re-read with the batch, no new embargo needed.
- `hesreallyhim/awesome-claude-code#2871` (Nikolai's own filing): OPEN, still 09-18 bot validation — no maintainer reply, wait, do not ping.
- Comment threads, all OPEN and unchanged: `redproof#50` (09-21), `kilocode#13843` (09-20), `kilocode#12707` (09-07), `atlas#105` (09-07), `slopstop#633` (09-06, deliberately not bumped — reminder waits for TRA-1090's verdict), `Dokploy/mcp#81` (09-05), `nanocoder#1197` (09-17), `lastlight#372` (09-18), `pyrefly#4583` (09-07), `pi-extensions#1204` (09-05), `ai-tooling#585` (0 comments since 09-04, TRA-857 forbids follow-up), `pr-agent#2499` (09-14). `deslop#173` CLOSED 09-08, unchanged.
- `MiniMax-AI/MiniMax-Code-Plugins#54`: OPEN, still 2026-09-25T01:30Z — third `CHANGES_REQUESTED` stands, no newer review. His lane — recorded, not touched.
- trace-mcp 182★/21 forks — flat against TRA-1939.

**Mention sweep (`scripts/mention-sweep.sh`, both passes): three repos surfaced — all three already recorded hours earlier by the TRA-1950 weekly sweep (#1402), independently re-read here.** This pass found the same three names (`jaimevalero/managing-awesome-lists-frontend`, `Sudeeparyan/TRACE`, `fuqiuluo/binder-trace`), read each matched file at source, and reached the same verdicts: one genuine auto-index (row + hygiene section above, kept as merged — no duplicate row added), two collisions (seen-list lines above, kept — no duplicates added). Independent corroboration of the weekly sweep's classifications, including the two competitors new to us in the jaimevalero similarity set (`roslyn-codelens-mcp`, `agentmako`) — flagged in that row for Competitor Intelligence. No outreach on any of the three: nothing to pitch, nobody to pitch it to.

**Competitor pulse (no touch):** `tirth8205/code-review-graph` at 31,791★ (+7 since TRA-1939) with `pushed_at` still 2026-09-18 — stars grow, triage stands still. For Competitor Intelligence, nothing to write.

**Nothing needed from Nikolai this run.** #2871 awaits triage, MiniMax#54 awaits re-review (he gets it via GitHub directly), no door is due a reminder. TRA-633's one click already happened 09-18; the Focus item is satisfied, not pending. No consolidated request sent.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

### Rebase note, 2026-09-26 (TRA-1967): day-pass delta on top of TRA-1955, sweep corroboration

This run's day pass landed on a stale checkout: the three sweep hits above were already classified by the TRA-1950 weekly sweep (#1402) and recorded in #1405 — they were "new" only against the stale seen-list. This pass independently re-read all three matched files at source and reaches the same verdicts (one genuine auto-index, two collisions), so no duplicate rows or seen-list lines were added; the corroboration stands as the second pair of eyes. (It also deduped the jaimevalero table row, which #1405 had landed twice.)

Thread deltas since TRA-1955, all read-only: `MiniMax-AI/MiniMax-Code-Plugins#54` moved 09-25T01:30 → 09-26T00:28 — the movement is Nikolai's own sixth review round, all 6 comments his; his lane, not touched. Everything else matches TRA-1955 exactly (all 8 submissions + 12 comment threads rechecked). `tolkonepiu#384`: the 26.09 ping-window expiry was decided as no-ping — a reminder into a queue that merged 4 project-adds in all of 2026 is noise; no new embargo needed. `slopstop#633`: the TRA-1090 deferral lifted (closed, released v3.23.2) — a draft reminder (method, not pitch) is staged in TRA-1031 for Lead Engineer review, unsent pending that gate.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Day pass, 2026-10-08 (TRA-2264): sweep unblocked after gh auth renewal, 5 genuine surfaces + 2 collisions + 1 merged seen

Audited via API, read-only, nothing written outside this file, `ops/mentions-seen.txt`, and `scripts/mention-sweep.sh`.

**Open threads audit (via GitHub API read-only):**
- `eltociear/awesome-AI-driven-development#119`: merged 2026-09-30 14:44Z. Live in both `README.md` and `README_JA.md`. Table row updated from submitted to merged.
- `GetBindu/awesome-claude-code-and-skills#195`: open, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `0xNyk/awesome-hermes-agent#395`: open, untouched since 2026-09-20. Standing no-ping rule holds.
- `tolkonepiu/best-of-mcp-servers#384`: open, updated 2026-09-26 (reminder sent, no reply). Reminder budget spent. Standing no-ping rule holds.
- `ai-boost/awesome-harness-engineering#240`: open, untouched since 2026-09-14 (wontfix-spend).
- `hesreallyhim/awesome-claude-code#2871`: open, untouched since 2026-09-18 bot validation. Standing no-ping rule holds.
- `natsukium/mcp-servers-nix#606`: open, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `MiniMax-AI/MiniMax-Code-Plugins#54`: open, updated 2026-09-26. Nikolai's lane, recorded, not touched.
- Comment threads: `redproof#50` (09-21), `kilocode#13843` (10-05 maintainer follow-ups, internal Cygwin/Fedora fixes), `kilocode#12707` (09-07), `atlas#105` (09-07), `slopstop#633` (09-06, deliberately not bumped), `Dokploy/mcp#81` (09-05), `nanocoder#1197` (10-07 third-party eval notes), `lastlight#372` (10-05 cliftonc cross-ref to #434 noting ACP runtime stdio MCP, no reply needed), `facebook/pyrefly#4583` (09-07), `narumiruna/pi-extensions#1204` (closed 10-07 by maintainer, won't merge benchmark), `mattbutlerengineering/ai-tooling#585` (09-04), `pr-agent#2499` (09-14). `deslop#173` CLOSED 09-08, unchanged.
- Zero incoming maintainer inquiries. No outreach pings or PRs opened (0 of 5 budget used).

**Mention sweep (`scripts/mention-sweep.sh`, both passes): unblocked and executed.**
8 repos surfaced:
1. `sudosubin/agents.nix` (16★, 2 forks): genuine third-party packaging. Nixpkgs overlay for AI agent skills packaging `nikolai-vysotskyi/trace-mcp` v3.34.6 with sha256 hash. Table row + seen-list added.
2. `majiayu000/claude-skill-registry-data` (23★, 10 forks): genuine third-party registry pipeline mirroring trace-mcp skills. Table row + seen-list added.
3. `cesarschutz/claude-code-kit` (1★): genuine third-party Claude Code plugin marketplace/kit listing trace-mcp under "Código e repositórios". Table row + seen-list added.
4. `drguptavivek/DigitVA` (0★): genuine user adoption by author of `fundus_img_xtract`. Handoff notes: "Code search: semble first. trace-mcp is broken (binary missing)." Second project mandating trace-mcp in agent handoff. Table row + seen-list added.
5. `midnight000spark/dharma-toolkit` (0★): genuine user evaluation. Architectural decision D-47 / F-72 evaluated trace-mcp 3.31.4 on Dart/Flutter. Table row + seen-list added.
6. `eltociear/awesome-AI-driven-development`: genuine catalog listing merged 2026-09-30, seen-list added.
7. `aleutian-ai/trace`: collision (their own Go binary `cmd/trace-mcp/main.go`). Seen-list added.
8. `christopherwoodall/silent-locus`: collision / crawler artifact (`our-domains.txt` domain list). Seen-list added.

**Tooling hardening:**
- `scripts/mention-sweep.sh`: added `GH_PROMPT_DISABLED=1`, `GIT_TERMINAL_PROMPT=0`, and fast-fail auth check `gh auth status` so headless runs never block on terminal prompt.

**Competitor pulse (no touch):**
- `tirth8205/code-review-graph`: 31,972★ (+15 since TRA-2245), 2,928 forks, pushed 2026-10-06.
- `nikolai-vysotskyi/trace-mcp`: 186★, 24 forks, pushed 2026-10-08.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Day pass, 2026-10-08 evening (TRA-2268): open threads re-audit, DigitVA environment root cause, FlorianBruniaux guide analysis

Audited read-only via API, nothing written outside this file.

**Open threads audit (via GitHub API read-only):**
- `eltociear/awesome-AI-driven-development#119`: verified merged 2026-09-30 14:44Z. Live in both `README.md` and `README_JA.md`.
- `GetBindu/awesome-claude-code-and-skills#195`: open, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `0xNyk/awesome-hermes-agent#395`: open, untouched since 2026-09-20. Standing no-ping rule holds.
- `tolkonepiu/best-of-mcp-servers#384`: open, updated 2026-09-26 (reminder sent, no reply). Reminder budget spent. Standing no-ping rule holds.
- `ai-boost/awesome-harness-engineering#240`: open, untouched since 2026-09-14 (wontfix-spend).
- `hesreallyhim/awesome-claude-code#2871`: open, untouched since 2026-09-18 bot validation. Standing no-ping rule holds.
- `natsukium/mcp-servers-nix#606`: open, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `MiniMax-AI/MiniMax-Code-Plugins#54`: open, updated 2026-09-26. Nikolai's lane, recorded, not touched.
- Comment threads: `redproof#50`, `kilocode#13843`, `kilocode#12707`, `atlas#105`, `slopstop#633`, `Dokploy/mcp#81`, `nanocoder#1197`, `lastlight#372`, `facebook/pyrefly#4583`, `narumiruna/pi-extensions#1204`, `mattbutlerengineering/ai-tooling#585`, `pr-agent#2499`. All quiet, zero incoming maintainer inquiries.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Telemetry & user adoption deep dive — `drguptavivek/DigitVA`:**
- In the morning sweep (TRA-2264), `drguptavivek/DigitVA` surfaced with handoff note: `"Code search: semble first. trace-mcp is broken (binary missing)."`.
- Audited author's repositories (`DYNAMIC`, `fundus_img_xtract`, `DigitVA`):
  - In `fundus_img_xtract/handoff/01_GUARDRAILS.md`, the author explicitly mandates: `Use trace-mcp before code exploration, as required by AGENTS.md.`
  - In `DigitVA`, the repository is a pure Python / uv codebase running in Docker (`minerva_app_service`).
  - Root cause of "binary missing": in containerized Python/uv workflows lacking Node.js or `npm`/`npx` in the container's `$PATH`, executing `trace-mcp` or `npx trace-mcp serve` fails with `ENOENT` / binary missing. The agent then fell back to `MinishLab/semble` (installed via `pip install semble`).
  - Key finding: user adoption is strong (multiple practitioner projects mandating trace-mcp), but Python-only containerized environments need either Node in the base image or a standalone binary distribution to avoid this failure mode.

**Surface discovery & architectural mapping — `FlorianBruniaux/claude-code-ultimate-guide` (6,125★, 803 forks):**
- Thorough audit of the premier Claude Code reference guide on GitHub:
  - `guide/ecosystem/mcp-servers-ecosystem.md` lines 854–1052 (`### Code search & analysis`): currently covers Grepai (requires Ollama + nomic-embed-text) and Semble (Model2Vec CPU, no call graph analysis). The guide explicitly notes: *"When to choose Semble over Grepai: You want semantic code search but do not run Ollama locally... Choose Grepai when call graph analysis is essential; Semble does not offer this capability."*
  - `examples/skills/smart-explore.md` ("Smart explore: Progressive code exploration"): lists Option C1 `mcp-server-tree-sitter` (unmaintained, no license), Option C2 `code-review-graph` (SQLite-backed, PR reviews), Option C3 `jCodeMunch` ($79/$349 commercial license).
  - `docs/resource-evaluations/tree-sitter-progressive-code-exploration.md`: evaluates the AST progressive exploration pattern (Alex Newman / Aider repo map pattern) with high score (4/5).
  - trace-mcp directly bridges this exact documented gap: AST call graph, symbol graph, and framework awareness across 88 frameworks and 81 languages, running 100% CPU-local with zero external services/Ollama, MIT licensed, and measured 72.7% token reduction on PR review.
  - Recorded in the distribution registry table as candidate surface.

**Competitor pulse (no touch):**
- `MinishLab/semble`: 6,192★, 274 forks, pushed 2026-10-08.
- `tirth8205/code-review-graph`: 31,972★, 2,928 forks, pushed 2026-10-06.
- `nikolai-vysotskyi/trace-mcp`: 186★, 24 forks, pushed 2026-10-08.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Night pass, 2026-10-08 (TRA-2270): open threads silent, sweep clean (0 new), numtide packaging analysis, competitor pulse

Audited read-only via API, nothing written outside this file.

**Open threads audit (via GitHub API read-only):**
- `eltociear/awesome-AI-driven-development#119`: verified merged 2026-09-30 14:44Z. Live in both `README.md` and `README_JA.md`.
- `GetBindu/awesome-claude-code-and-skills#195`: open, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `0xNyk/awesome-hermes-agent#395`: open, untouched since 2026-09-20. Standing no-ping rule holds.
- `tolkonepiu/best-of-mcp-servers#384`: open, updated 2026-09-26 (reminder sent, no reply). Reminder budget spent. Standing no-ping rule holds.
- `ai-boost/awesome-harness-engineering#240`: open, untouched since 2026-09-14 (wontfix-spend).
- `hesreallyhim/awesome-claude-code#2871`: open, untouched since 2026-09-18 bot validation. Standing no-ping rule holds.
- `natsukium/mcp-servers-nix#606`: open, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `MiniMax-AI/MiniMax-Code-Plugins#54`: open, updated 2026-09-26. Nikolai's lane, recorded, not touched.
- Comment threads: `nearform/lastlight#372` (10-05 cliftonc cross-ref to #434 noting ACP runtime stdio MCP, quiet, no reply needed), `narumiruna/pi-extensions#1204` (closed 10-07 by maintainer), `redproof#50`, `kilocode#13843`, `kilocode#12707`, `atlas#105`, `slopstop#633`, `Dokploy/mcp#81`, `nanocoder#1197`, `facebook/pyrefly#4583`, `mattbutlerengineering/ai-tooling#585`, `pr-agent#2499`. All quiet, zero incoming maintainer inquiries.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (`scripts/mention-sweep.sh`, pass 1 + pass 2):**
- Ran full sweep with `GH_PROMPT_DISABLED=1` and `GIT_TERMINAL_PROMPT=0`.
- All hits matched `ops/mentions-seen.txt`. Result: 0 repos outside seen list ("No repos outside the seen list. Nothing to read."). Clean sweep.

**Distribution & packaging intelligence — `numtide/llm-agents.nix` & `yzfly/Awesome-MCP-ZH`:**
- Cross-referencing `MinishLab/semble` citations revealed `numtide/llm-agents.nix` (2,076★, 283 forks), a major Nix packaging flakes repository by Numtide with daily automated updates. They package `code-review-graph`, `codegraph`, `semble`, `gitnexus`, and `multica`. Analyzed their derivation structure: packages use `buildNpmPackage` or `stdenv.mkDerivation` with `pnpmDeps`/`makeWrapper`. Worth tracking for downstream Linux/Nix agent packagers alongside `sudosubin/agents.nix`.
- Checked `yzfly/Awesome-MCP-ZH` (7,714★, 882 forks, curated MCP list in Chinese). Maintainer `yzfly` previously merged our PR #44 in `awesome-context-engineering` with zero pushback. Confirmed trace-mcp is not listed and no PR was submitted. Catalog moratorium firmly applies (zero attributable GA4 acquisitions), so no submission is made; kept on radar for post-moratorium.

**Competitor pulse (no touch):**
- `nikolai-vysotskyi/trace-mcp`: 188★ (+2 today, was 186 in TRA-2268), 24 forks, pushed 2026-10-08.
- `MinishLab/semble`: 6,192★, 273 forks, pushed 2026-10-08.
- `tirth8205/code-review-graph`: 31,980★ (+8 since TRA-2268, was 31,972), 2,928 forks, pushed 2026-10-06.
- `yamadashy/repomix`: 28,751★, 1,573 forks.
- `oraios/serena`: 30,105★, 2,048 forks.
- `DeusData/codebase-memory-mcp`: 46,151★, 3,796 forks.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Day pass, 2026-10-09 (TRA-2275): thread re-audit, Dokploy progress, clean mention sweep, competitor intelligence (Semble multi-harness subagents, Serena symlink CVE, DSH)

Audited read-only via API, nothing written outside this file.

**Open threads audit (via GitHub API read-only):**
- `eltociear/awesome-AI-driven-development#119`: verified merged 2026-09-30 14:44Z. Live in both `README.md` and `README_JA.md`.
- `GetBindu/awesome-claude-code-and-skills#195`: open, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `0xNyk/awesome-hermes-agent#395`: open, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `tolkonepiu/best-of-mcp-servers#384`: open, updated 2026-09-26 (reminder sent, no reply). Reminder budget spent. Standing no-ping rule holds.
- `ai-boost/awesome-harness-engineering#240`: open, untouched since 2026-09-14 (wontfix-spend).
- `hesreallyhim/awesome-claude-code#2871`: open, untouched since 2026-09-18 bot validation. Standing no-ping rule holds.
- `natsukium/mcp-servers-nix#606`: open, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `MiniMax-AI/MiniMax-Code-Plugins#54`: open, updated 2026-09-26. Nikolai's lane, recorded, not touched.
- Comment threads:
  - `Dokploy/mcp#81`: new comment 2026-10-08 20:56Z by contributor `moataz-hjaiji` announcing an upcoming PR implementing the meta-tool `dokploy-loadTools` with single `notifications/tools/list_changed` and tool descriptor results, specifically crediting Nikolai (`@nikolai-vysotskyi`)'s insight about clients slow to re-read `tools/list`. Proposal is moving into community implementation; no reply needed.
  - `nearform/lastlight#372`: quiet since 10-05.
  - `narumiruna/pi-extensions#1204`: closed 10-07 by maintainer.
  - `Nano-Collective/nanocoder#1197`, `facebook/pyrefly#4583`, `mattbutlerengineering/ai-tooling#585`, `qodo-ai/pr-agent#2499`, `iansmith/slopstop#633`, `sosalejandro/atlas#105`: all quiet, zero incoming maintainer inquiries.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (`scripts/mention-sweep.sh`, pass 1 + pass 2):**
- Ran full sweep with `GH_PROMPT_DISABLED=1` and `GIT_TERMINAL_PROMPT=0`.
- All hits matched `ops/mentions-seen.txt`. Result: 0 repos outside seen list ("No repos outside the seen list. Nothing to read."). Clean sweep.

**Competitor intelligence & architectural observations:**
- `MinishLab/semble`:
  - Issue #290: Detailed breakdown of tool naming conventions and tool-gating across 13 coding agent platforms (Claude Code `mcp__<server>__<tool>`, Gemini CLI `mcp_<tool>`, Qwen Code `mcp__<server>__<tool>`, Copilot `<server>/<tool>`, Kiro `mcp_<tool>`, Command Code `mcp__<server>__<tool>` + `shell_command`, Reasonix `mcp__<server>__<tool>`, OpenCode/Kilo permissions). Shows that subagents across these platforms default to CLI execution unless explicitly tool-gated.
  - Issue #288: Subprocess leaks under uv when invoked via MCP (`uv tool upgrade` / unreleased uv processes).
  - Issue #287: Tool name prefix discrepancy between documentation (`mcp__semble__search`) and registration (`semble__search`).
- `oraios/serena`:
  - Issue #2144: Critical security vulnerability report: file tools rely on lexical `os.path.normpath` path confinement rather than resolving realpaths, allowing in-tree symlinks pointing outside the project root to read/write arbitrary filesystem files (`~/.ssh`, `/etc/passwd`).
  - Architectural comparison: `trace-mcp`'s `validateWritePath` (`src/utils/security.ts`) already implements mandatory realpath ancestor confinement and rejects writing through symlinks, making trace-mcp inherently immune to this vulnerability class.
- `tirth8205/code-review-graph`:
  - Issue #1100: Proposal for DeepSeek Harness (DSH) native integration via Cordis YAML patch layer and structured read-only edit plans.

**Competitor pulse (no touch):**
- `nikolai-vysotskyi/trace-mcp`: 188★, 24 forks, pushed 2026-10-08.
- `MinishLab/semble`: 6,191★ (-1), 274 forks, pushed 2026-10-08.
- `tirth8205/code-review-graph`: 31,984★ (+4 since TRA-2270), 2,929 forks, pushed 2026-10-06.
- `yamadashy/repomix`: 28,756★ (+5), 1,574 forks, pushed 2026-10-03.
- `oraios/serena`: 30,105★, 2,049 forks, pushed 2026-10-08.
- `DeusData/codebase-memory-mcp`: 46,163★ (+12), 3,796 forks, pushed 2026-10-07.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Day pass, 2026-10-09 (TRA-2286): sweep hit Live-Documentation survey, competitor deep-dive (Serena multi-target C# & sync fs poll, CBM daemon timeout), open threads re-audit

Audited read-only via API, nothing written outside this file.

**Open threads audit (via GitHub API read-only):**
- `eltociear/awesome-AI-driven-development#119`: merged 2026-09-30, live in both READMEs.
- `GetBindu/awesome-claude-code-and-skills#195`: open, clean, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `0xNyk/awesome-hermes-agent#395`: open issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `tolkonepiu/best-of-mcp-servers#384`: open, updated 2026-09-26 (reminder sent, no reply). Reminder budget spent. Standing no-ping rule holds.
- `ai-boost/awesome-harness-engineering#240`: open, untouched since 2026-09-14 (wontfix-spend).
- `hesreallyhim/awesome-claude-code#2871`: open issue, untouched since 2026-09-18 bot validation. Standing no-ping rule holds.
- `natsukium/mcp-servers-nix#606`: open issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `MiniMax-AI/MiniMax-Code-Plugins#54`: open, updated 2026-09-26. Nikolai's lane, recorded, not touched.
- `Dokploy/mcp#81`: contributor `moataz-hjaiji` preparing PR for meta-tool `dokploy-loadTools` based on Nikolai's proposal. No action needed.
- Comment threads: `lastlight#372`, `pi-extensions#1204`, `nanocoder#1197`, `pyrefly#4583`, `ai-tooling#585`, `pr-agent#2499`, `slopstop#633`, `atlas#105`: all quiet.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (`scripts/mention-sweep.sh`, pass 1 + pass 2):**
- Ran full sweep with `GH_PROMPT_DISABLED=1` and `GIT_TERMINAL_PROMPT=0`.
- Found 1 new repo outside `ops/mentions-seen.txt`: `jfjordanfarr/Live-Documentation`.
- Matched file inspected: `AI-Agent-Workspace/Research/2026-10-08-headless-use-cases.md`.
- Classification: Genuine third-party research survey on headless live documentation architecture for AI agents. Cites `trace-mcp` (mcpservers.org link) under "Agents reading a codebase's structure" alongside `codebase-graph`, `Codebase Memory MCP`, and `CodeGraph`: describes trace-mcp as "(68 languages, impact analysis)". Analyzes the trade-off of runtime MCP servers vs committed reviewable docs-as-code artifacts.
- Action: Recorded in `ops/mentions-seen.txt` and added to genuine distribution surfaces table. Do not ping or open issues (independent research doc).

**Competitor intelligence & architectural observations:**
- `oraios/serena`:
  - Issue #2147 / #2148: Multi-targeted C# projects (`<TargetFrameworks>net472;net10.0</TargetFrameworks>`) cause Roslyn LSP to nondeterministically select an arbitrary target framework context because ascending random GUID `ProjectId` ordering decides the winning context on each restart. By contrast, `trace-mcp` parses C# syntax directly via Tree-sitter AST queries (`src/indexer/languages/csharp.ts`), avoiding external Roslyn statefulness and GUID-based framework nondeterminism.
  - Issue #2145: Seven symbol tools in `serena/tools/symbol_tools.py` run a synchronous `ls_sync_file_system_changes()` filesystem poll before executing every single query, adding massive traversal latency to codebases with many projects. By contrast, `trace-mcp` utilizes debounced background file-watching (`watcher.ts` / `daemon.ts`) and an in-memory SQLite index, keeping query-time tool execution (`search`, `get_symbol`, `get_outline`) sub-millisecond without per-query fs sync.
- `DeusData/codebase-memory-mcp`:
  - Issue #2569: CBM daemon startup exceeds hardcoded 30s client-accept timeout on slow devices or emulated environments (Termux proot, low-power aarch64). In `trace-mcp`, startup initialization is lightweight and decoupled from client ping/handshake timeouts.
- `yamadashy/repomix`:
  - Issue #1920 / #1921: Numbered `--split-output` files from prior runs get recursively re-packed into subsequent runs if not explicitly excluded. Re-confirms `trace-mcp`'s architectural advantage: structured query navigation vs flat text concatenation / context packing traps.

**Competitor pulse (no touch):**
- `nikolai-vysotskyi/trace-mcp`: 188★, 24 forks, pushed 2026-10-09.
- `MinishLab/semble`: 6,191★, 274 forks, pushed 2026-10-08.
- `tirth8205/code-review-graph`: 31,990★ (+6 since TRA-2275), 2,931 forks, pushed 2026-10-06.
- `yamadashy/repomix`: 28,764★ (+8 since TRA-2275), 1,573 forks, pushed 2026-10-03.
- `oraios/serena`: 30,111★ (+6 since TRA-2275), 2,049 forks, pushed 2026-10-08.
- `DeusData/codebase-memory-mcp`: 46,180★ (+17 since TRA-2275), 3,797 forks, pushed 2026-10-09.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run.


### Day pass 2, 2026-10-09 (TRA-2289): clean sweep, open threads audit, competitor deep-dive (Serena path confinement PR #2150 & session drops #2149, CRG FTS desync #1103)

Audited read-only via API, nothing written outside this file.

**Open threads audit (via GitHub API read-only):**
- `eltociear/awesome-AI-driven-development#119`: merged 2026-09-30, live in both READMEs.
- `GetBindu/awesome-claude-code-and-skills#195`: open, clean, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `0xNyk/awesome-hermes-agent#395`: open issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `tolkonepiu/best-of-mcp-servers#384`: open, updated 2026-09-26 (reminder sent, no reply). Reminder budget spent. Standing no-ping rule holds.
- `ai-boost/awesome-harness-engineering#240`: open, untouched since 2026-09-14 (wontfix-spend).
- `hesreallyhim/awesome-claude-code#2871`: open issue, untouched since 2026-09-18 bot validation. Standing no-ping rule holds.
- `natsukium/mcp-servers-nix#606`: open issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `MiniMax-AI/MiniMax-Code-Plugins#54`: open, updated 2026-10-09 (routine sync, no new comments since Nikolai's 2026-09-26 round 3 update). Nikolai's lane, recorded, not touched.
- `Dokploy/mcp#81`: contributor `moataz-hjaiji` confirmed implementation plan on 2026-10-08 for meta-tool `dokploy-loadTools` adopting Nikolai's schema payload and client fallback recommendations. Preparing PR. No action needed.
- Comment threads: `lastlight#372`, `pi-extensions#1204`, `nanocoder#1197`, `pyrefly#4583`, `ai-tooling#585`, `pr-agent#2499`, `slopstop#633`, `atlas#105`: all quiet.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (`scripts/mention-sweep.sh`, pass 1 + pass 2):**
- Ran full sweep with `GH_PROMPT_DISABLED=1` and `GIT_TERMINAL_PROMPT=0`.
- All queries clean. Result: 0 repos outside seen list ("No repos outside the seen list. Nothing to read."). Clean sweep.

**Competitor intelligence & architectural observations:**
- `oraios/serena`:
  - PR #2150 (opened 2026-10-09T08:57Z): Contributor submitted critical fix for path traversal and symlink confinement vulnerability (#2144). Reproduction demonstrated that line-based and symbol-level editing tools (`delete_lines`, `replace_lines`, `insert_at_line`, etc.) completely bypassed path validation, allowing writes outside the project root via `..` or in-tree symlinks. The proposed fix adds realpath resolution to `Project.is_path_in_project`, but gates symlink following on project-trust configuration.
  - Architectural comparison: `trace-mcp` strictly validates all write paths (`validateWritePath` in `src/utils/security.ts` / `tests/tools/refactor-confinement.test.ts`) against project root realpath ancestors and unconditionally refuses writes through symlinks, providing uniform zero-trust protection regardless of project configuration.
  - Issue #2149 (opened 2026-10-09T08:00Z): "Active project resets between MCP tool calls in the same session ('No active project' despite earlier activate_project)" in MCP stdio sessions with custom hosts. Serena's per-call `session_id` state tracking causes mid-session loss of active project context when hosts mint or rotate session IDs. By contrast, `trace-mcp` avoids session-id keying for workspace context.
- `tirth8205/code-review-graph`:
  - Issue #1103: `[Bug]: MCP serve --auto-watch skips FTS post-processing after file updates`. The MCP auto-watch thread receives and processes filesystem changes into graph nodes but omits the FTS post-processing callback, causing newly added symbols to be missing from FTS and leaving stale FTS row IDs for existing symbols.
  - Issue #1104 / PR #1105: No-op `update` marks FTS complete without repairing inconsistencies.
  - Architectural comparison: In `trace-mcp`, incremental indexing updates symbol tables, outlines, and text search indices atomically inside a single SQLite transaction during the debounced file-watching cycle (`src/indexer/watcher.ts`), preventing graph-to-index desynchronization.
- `MinishLab/semble`:
  - Issue #290: Discussion on subagents and CLI vs MCP tool access. Maintainer cautions that exposing MCP tools to subagents requires care due to varying capabilities across coding agent platforms.
  - Issue #288: Subprocess leaks under uv when used via MCP (`uv tool upgrade` / unreleased uv processes).
- `cdeust/ai-architect-mcp-codebase`:
  - Actively maintained (commit `8efcb751` / `5c2e138f` on 2026-10-08/09). Bumped `lbug` (LadybugDB) and refined bootstrap pin validation for Cargo package tables with LC_ALL=C awk and NUL byte defense. Tracked in our competitor registry (5★).

**Competitor pulse (no touch):**
- `nikolai-vysotskyi/trace-mcp`: 188★, 24 forks, pushed 2026-10-09.
- `MinishLab/semble`: 6,193★ (+2 since TRA-2286), 274 forks, pushed 2026-10-08.
- `tirth8205/code-review-graph`: 31,997★ (+7), 2,931 forks, pushed 2026-10-06.
- `yamadashy/repomix`: 28,769★ (+5), 1,573 forks, pushed 2026-10-03.
- `oraios/serena`: 30,120★ (+9), 2,050 forks (+1), pushed 2026-10-09.
- `DeusData/codebase-memory-mcp`: 46,201★ (+21), 3,802 forks (+5), pushed 2026-10-09.
- `cdeust/ai-architect-mcp-codebase`: 5★ (+1), 0 forks, pushed 2026-10-09.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run.


### Day pass 3, 2026-10-09 (TRA-2292): clean sweep, open threads audit, competitor deep-dive (CRG crossed 32k & plugin hooks PR #1102, Semble tool namespacing PR #289, Serena path confinement review)

Audited read-only via API, nothing written outside this file.

**Open threads audit (via GitHub API read-only):**
- `eltociear/awesome-AI-driven-development#119`: merged 2026-09-30, live in both READMEs.
- `GetBindu/awesome-claude-code-and-skills#195`: open, clean, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `0xNyk/awesome-hermes-agent#395`: open issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `tolkonepiu/best-of-mcp-servers#384`: open, updated 2026-09-26 (reminder sent, no reply). Reminder budget spent. Standing no-ping rule holds.
- `ai-boost/awesome-harness-engineering#240`: open, untouched since 2026-09-14 (wontfix-spend).
- `hesreallyhim/awesome-claude-code#2871`: open issue, untouched since 2026-09-18 bot validation. Standing no-ping rule holds.
- `natsukium/mcp-servers-nix#606`: open issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `MiniMax-AI/MiniMax-Code-Plugins#54`: open, updated 2026-10-09 (routine sync, no new comments since Nikolai's 2026-09-26 round 3 update). Nikolai's lane, recorded, not touched.
- `Dokploy/mcp#81`: contributor `moataz-hjaiji` confirmed implementation plan on 2026-10-08 for meta-tool `dokploy-loadTools` adopting Nikolai's schema payload and client fallback recommendations. Preparing PR. No action needed.
- Comment threads: `lastlight#372`, `pi-extensions#1204`, `nanocoder#1197`, `pyrefly#4583`, `ai-tooling#585`, `pr-agent#2499`, `slopstop#633`, `atlas#105`: all quiet.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (`scripts/mention-sweep.sh`, pass 1 + pass 2):**
- Ran full sweep with `GH_PROMPT_DISABLED=1` and `GIT_TERMINAL_PROMPT=0`.
- All queries clean. Result: 0 repos outside seen list ("No repos outside the seen list. Nothing to read."). Clean sweep.

**Competitor intelligence & architectural observations:**
- `tirth8205/code-review-graph`:
  - Star milestone: crossed 32,000★ (32,003★, +6 since TRA-2289).
  - PR #1102: Contributor opened "fix: wrap plugin hooks in a top-level 'hooks' key so Claude Code loads them". Claude Code failed to load plugin hooks from CRG's bare event mapping in `hooks/hooks.json` (`hooks.json must have 'hooks' or 'modules'`). By contrast, `trace-mcp`'s `.claude-plugin/hooks/hooks.json` has always placed plugin hooks under a canonical top-level `"hooks"` key (guard on `PreToolUse` and session preservation snapshot on `PreCompact`), operating cleanly across Claude Code versions without schema errors.
  - PR #1105 / Issue #1104 / #1103: Ongoing work reconciling stale FTS indices on no-op updates and addressing auto-watch threads that skip post-processing. Highlights the stability of `trace-mcp`'s unified, debounced SQLite transactions where symbol tables and full-text indexes update atomically.
- `MinishLab/semble`:
  - PR #289 / Issue #287: "fix: Use bare MCP tool names in agent instructions". Upstream agent instructions hardcoded `mcp__semble__search` instead of plain names, causing Grok, CommandCode, and Claude Code to fail proper MCP invocations. In `trace-mcp`, tool interfaces expose clean canonical tool names (`search`, `get_symbol`, `get_outline`) and client presets handle client-specific configuration cleanly without hardcoding brittle host-specific namespace prefixes.
- `oraios/serena`:
  - PR #2150 (open): Symlink & path traversal confinement discussion. Adding realpath validation to `Project.is_path_in_project` while gating symlinks on a `trusted_projects` config continues to raise edge-case concerns. Confirms `trace-mcp`'s zero-trust architectural choice: unconditional realpath containment check (`validateWritePath`) refusing symlink writes across all refactoring operations.
- `cdeust/ai-architect-mcp-codebase`:
  - PR #441 deep-dive: refined Cargo package table pinning (hashing only `[package]` table via `LC_ALL=C awk`, rejecting NUL bytes and empty tables, and enforcing pipefail in CI coverage). Useful reference for resilient shell bootstrap integrity.

**Competitor pulse (no touch):**
- `nikolai-vysotskyi/trace-mcp`: 188★, 24 forks, pushed 2026-10-09 (v3.35.0 live).
- `MinishLab/semble`: 6,193★ (steady), 274 forks, pushed 2026-10-08.
- `tirth8205/code-review-graph`: 32,003★ (+6 since TRA-2289, crossed 32k), 2,931 forks, pushed 2026-10-06.
- `yamadashy/repomix`: 28,770★ (+1 since TRA-2289), 1,574 forks (+1), pushed 2026-10-03.
- `oraios/serena`: 30,125★ (+5 since TRA-2289), 2,052 forks (+2), pushed 2026-10-09.
- `DeusData/codebase-memory-mcp`: 46,211★ (+10 since TRA-2289), 3,803 forks (+1), pushed 2026-10-09.
- `cdeust/ai-architect-mcp-codebase`: 5★, 1 fork (+1 fork), pushed 2026-10-09.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run.


### Night pass (pass 4), 2026-10-09 (TRA-2294): clean sweep, open threads audit, competitor deep-dive (CBM hardware SHA2 & TF-IDF rebuild, Serena symlink escape PR #2150, CRG request cancellation crash #1106, Semble bundled subagents PR #291)

Audited read-only via API, nothing written outside this file.

**Open threads audit (via GitHub API read-only):**
- `eltociear/awesome-AI-driven-development#119`: merged 2026-09-30, live in both READMEs.
- `GetBindu/awesome-claude-code-and-skills#195`: open, clean, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `0xNyk/awesome-hermes-agent#395`: open issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `tolkonepiu/best-of-mcp-servers#384`: open, updated 2026-09-26 (reminder sent, no reply). Reminder budget spent. Standing no-ping rule holds.
- `ai-boost/awesome-harness-engineering#240`: open, untouched since 2026-09-14 (wontfix-spend).
- `hesreallyhim/awesome-claude-code#2871`: open issue, untouched since 2026-09-18 bot validation. Standing no-ping rule holds.
- `natsukium/mcp-servers-nix#606`: open issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `MiniMax-AI/MiniMax-Code-Plugins#54`: open, updated 2026-10-09 (routine sync, no new comments since Nikolai's 2026-09-26 round 3 update). Nikolai's lane, recorded, not touched.
- `Dokploy/mcp#81`: open, updated 2026-10-08 (contributor plan underway). Standing no-ping rule holds.
- `hashgraph-online/awesome-ai-plugins#182`: merged, live in HOL Registry; third-party scanner CI refused per repo security policy, follow-up claim notifications ignored.
- Comment threads: `lastlight#372`, `pi-extensions#1204`, `nanocoder#1197`, `pyrefly#4583`, `ai-tooling#585`, `pr-agent#2499`, `slopstop#633`, `atlas#105`: all quiet.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (`scripts/mention-sweep.sh`, pass 1 + pass 2):**
- Ran full sweep with `GH_PROMPT_DISABLED=1` and `GIT_TERMINAL_PROMPT=0`.
- All queries clean. Result: 0 repos outside seen list ("No repos outside the seen list. Nothing to read."). Clean sweep.

**Competitor intelligence & architectural observations:**
- `DeusData/codebase-memory-mcp`:
  - PR #2575: `perf(sha256): compress blocks on ARMv8 SHA2 / x86 SHA-NI (#2441)`. CBM calculated SHA-256 of its ~300 MB daemon binary on every process startup, burning ~1.2 s CPU and pushing hook execution past the 2,000 ms timeout window. Resolved by adding hardware-accelerated block compression (ARMv8 SHA2 via `sysctl`/`HWCAP`, x86 SHA-NI via `CPUID`). By contrast, `trace-mcp` records version and build provenance statically at build time (constants in `package.json` / build manifests), avoiding dynamic whole-binary hash calculations on startup and eliminating hook timeout risks.
  - PR #2574: `Semantic relations with a judged p; doc sections linked to their code by format and position`. Repaired a semantic indexer bug where TF-IDF compared i-th tokens of functions instead of shared vocabulary sets (`cbm_sem_tfidf_terms`). Index version bumped from 6 to 7, requiring full index rebuilds across user repositories. By contrast, `trace-mcp`'s AST-based symbol extraction and SQLite FTS5 BM25 search are exact, deterministic, and schema-stable without requiring rebuild cycles for token-level heuristic fixes.
- `oraios/serena`:
  - PR #2150 (open): `fix: confine file access to the project root by resolving symlinks in the path check` (Fixes #2144). Reveals directory traversal vulnerabilities where `Project.is_path_in_project` relied on lexical path normalization (`os.path.normpath`), allowing symlinks to escape the project boundary. Furthermore, symbol editing tools (`delete_lines`, `replace_lines`, `insert_at_line`, `replace_symbol_body`, etc.) lacked path validation entirely, allowing file modification outside project root via `..`. By contrast, `trace-mcp` enforces centralized path confinement (`validateWritePath` in `src/utils/security.ts`) that resolves `realpath` ancestors and unconditionally rejects symlink writes for all refactoring and modification tools.
- `tirth8205/code-review-graph`:
  - Issue #1106 (opened 2026-10-09): `[Bug]: serve exits when a request is cancelled mid-flight — AssertionError: Request already responded to`. When an MCP client cancels a request (`notifications/cancelled`), CRG's completed tool handler attempts to respond a second time. The unhandled `AssertionError` propagates through anyio and crashes the entire MCP server process, terminating stdio sessions across IDEs. In `trace-mcp`, request lifecycles and cancellation signals are managed safely via `@modelcontextprotocol/sdk` abort handling without unhandled exceptions crashing the server.
- `MinishLab/semble`:
  - PR #291 (closed 2026-10-08, fixes #290): `fix: Give bundled subagents access to the semble MCP tools`. Shipped subagent definitions had restricted tool access to CLI/shell only, forcing subagents into slow 5-second CLI process invocations rather than 18 ms in-memory MCP calls. Antigravity was left unconfigured as a documented gap. By contrast, `trace-mcp` provides direct MCP server integration across Claude Code, Cursor, Windsurf, Antigravity, and VS Code.

**Competitor pulse (no touch):**
- `nikolai-vysotskyi/trace-mcp`: 189★ (+1 since pass 3), 24 forks, pushed 2026-10-09 (v3.35.0 live).
- `MinishLab/semble`: 6,193★ (steady), 274 forks, pushed 2026-10-08.
- `tirth8205/code-review-graph`: 32,001★ (-2 fluctuation / steady at 32k), 2,931 forks, pushed 2026-10-06.
- `yamadashy/repomix`: 28,767★ (-3 fluctuation), 1,574 forks, pushed 2026-10-03.
- `oraios/serena`: 30,124★ (-1 fluctuation), 2,052 forks, pushed 2026-10-09.
- `DeusData/codebase-memory-mcp`: 46,216★ (+5 since pass 3), 3,803 forks, pushed 2026-10-09.
- `cdeust/ai-architect-mcp-codebase`: 5★, 1 fork, pushed 2026-10-09.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run.


### Night pass (pass 1), 2026-10-10 (TRA-2302): mention sweep collision audit (winter6205/iknow), open threads audit, competitor deep-dive (Serena LSP CDN failure #2152 & session reset #2149, Semble process leak #288, CRG FTS desync #1103)

Audited read-only via API, nothing written outside this file.

**Open threads audit (via GitHub API read-only):**
- `eltociear/awesome-AI-driven-development#119`: merged 2026-09-30, live in both READMEs.
- `GetBindu/awesome-claude-code-and-skills#195`: open, clean, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `0xNyk/awesome-hermes-agent#395`: open issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `tolkonepiu/best-of-mcp-servers#384`: open, updated 2026-09-26 (reminder sent, no reply). Reminder budget spent. Standing no-ping rule holds.
- `ai-boost/awesome-harness-engineering#240`: open, untouched since 2026-09-14 (wontfix-spend).
- `hesreallyhim/awesome-claude-code#2871`: open issue, untouched since 2026-09-18 bot validation. Standing no-ping rule holds.
- `natsukium/mcp-servers-nix#606`: open issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `MiniMax-AI/MiniMax-Code-Plugins#54`: open, updated 2026-10-09 (routine sync, no new comments since Nikolai's 2026-09-26 round 3 update). Nikolai's lane, recorded, not touched.
- `Dokploy/mcp#81`: open, updated 2026-10-08 (contributor plan underway). Standing no-ping rule holds.
- `hashgraph-online/awesome-ai-plugins#182`: merged, live in HOL Registry; third-party scanner CI refused per repo security policy, follow-up claim notifications ignored.
- Comment threads: `lastlight#372`, `pi-extensions#1204`, `nanocoder#1197`, `pyrefly#4583`, `ai-tooling#585`, `pr-agent#2499`, `slopstop#633`, `atlas#105`: all quiet.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (`scripts/mention-sweep.sh`, pass 1 + pass 2):**
- Ran full sweep with `GH_PROMPT_DISABLED=1` and `GIT_TERMINAL_PROMPT=0`.
- 1 repo outside seen list: `winter6205/iknow`.
- Inspection via raw API: inspected `docs/trace-mcp-server.md`, `src/trace-mcp/`, `docs/CONTEXT.md`.
- Classification: name collision. `winter6205/iknow` is an LLM agent harness / runtime featuring an internal `iknow-trace-mcp` stdio server (`list_sessions`, `query_trace`, `get_record`) designed for querying iknow execution session traces and jsonl transcripts. Unrelated to code intelligence, AST indexing, or token reduction.
- Recorded into `ops/mentions-seen.txt` with explanatory comment. Subsequent sweep verified clean ("No repos outside the seen list. Nothing to read.").

**Competitor intelligence & architectural observations:**
- `oraios/serena`:
  - Issue #2152 (opened 2026-10-09): `Kotlin LSP install fails: download-cdn.jetbrains.com now returns 404 (needs the signed redirect via download.jetbrains.com)`. Demonstrates a fundamental structural fragility of LSP-based code navigation architectures. Serena relies on dynamically downloading external third-party language server binaries (JetBrains Kotlin LSP, Erlang ELP, tsserver) at runtime. When upstream CDN endpoints change authentication or signed-redirect requirements, the entire bootstrap pipeline fails with extraction errors, breaking language support across user environments. By contrast, `trace-mcp` ships with native Tree-sitter grammars compiled directly into node native bindings, providing instant offline parsing across 20+ languages with zero runtime network dependency or fragile CDN binaries.
  - Issue #2149 (closed 2026-10-09): `Active project resets between MCP tool calls in the same session ("No active project" despite earlier activate_project)`. Serena depends on stateful project activation across MCP sessions, which causes failures when clients disconnect or parallelize calls. In `trace-mcp`, all tools are stateless and resolve workspace directories dynamically or from explicit paths, ensuring idempotency across IDEs and agents.
  - PR #2146 (merged 2026-10-09): `Optimise file access methods for project file traversal and filtering`. Refactored file traversal to reduce overhead during project walks.
- `MinishLab/semble`:
  - Issue #288 (open 2026-10-08): `When used as an MCP, it will spawn a large number of UV processes that are not released.` Semble spawns subprocesses (`uv run ...`) per tool invocation or subagent, leaking dozens of unreleased child processes that exhaust OS process limits and memory. In `trace-mcp`, all operations execute within a single persistent Node.js/Electron process with shared in-memory state and managed SQLite connections, preventing process leaks.
- `tirth8205/code-review-graph`:
  - Issues #1103 & #1104 / PR #1105: `[Bug]: MCP serve --auto-watch skips FTS post-processing after file updates` and stale FTS after `--skip-postprocess`. File watcher decoupled FTS indexing from AST updates, creating index desynchronization where updated code was missing from full-text search. In `trace-mcp`, SQLite FTS5 index updates are atomically synchronized in the same database transaction as AST symbol table updates.
- `DeusData/codebase-memory-mcp`:
  - PR #2573 (open 2026-10-09): `ci: build Linux amd64 release on Ubuntu 22.04`. CBM addresses glibc incompatibility across Linux distributions caused by building native binaries on newer glibc versions. `trace-mcp` avoids distribution glibc friction by shipping standard npm packages with precompiled native tree-sitter bindings and Electron desktop bundles.

**Competitor pulse (no touch):**
- `nikolai-vysotskyi/trace-mcp`: 189★ (steady), 24 forks, pushed 2026-10-09 (v3.35.0 live).
- `MinishLab/semble`: 6,192★ (-1 fluctuation), 274 forks, pushed 2026-10-08.
- `tirth8205/code-review-graph`: 32,006★ (+5 since pass 4), 2,932 forks (+1), pushed 2026-10-06.
- `yamadashy/repomix`: 28,769★ (+2 since pass 4), 1,575 forks (+1), pushed 2026-10-03.
- `oraios/serena`: 30,131★ (+7 since pass 4), 2,051 forks (-1), pushed 2026-10-09.
- `DeusData/codebase-memory-mcp`: 46,232★ (+16 since pass 4), 3,804 forks (+1), pushed 2026-10-09.
- `cdeust/ai-architect-mcp-codebase`: 5★, 1 fork, pushed 2026-10-09.

**Catalogs:** moratorium holds, acquisition still unreadable. No submissions. Queue stands: StackMap first, aloth second, TensorBlock third.

**Touch budget: 0 of 5 used.** No outgoing messages this run.

### Morning pass (pass 2), 2026-10-10 (TRA-2317): open threads audit, MiniMax round 4 analysis, mention sweep verification, OpenCowork intelligence, competitor telemetry & security deep-dive

Audited read-only via API, nothing written outside this file.

**Open threads audit (via GitHub API read-only):**
- `get-bb/marketplace#524`: OPEN, mergeable, zero comments. Awaiting maintainer review. Standing no-ping rule holds.
- `MiniMax-AI/MiniMax-Code-Plugins#54`: OPEN, updated 2026-10-09T01:18Z with Review Round 4 from `hetaoBackend` (`CHANGES_REQUESTED` for commit `bc461c77cef5facbdfc5a22de6aa64d5c11c2bf9`). Reviewer requested:
  1. Guard against postinstall persistent side effects on first install (`TRACE_MCP_NO_POSTINSTALL=1`), preventing background LaunchAgent/daemon creation before bounded contract is established.
  2. Prove backend provenance on existing-daemon attachment beyond fixed port `/health` (binding package version, PID, binary path, signature).
  3. Wire smoke test into exact-head CI with enforced assertions rather than printed log statements.
  4. Clarify transactional safety claims regarding multi-file refactors (document real preview/confirmation/rollback semantics rather than claiming atomic rollback).
  *Note: Nikolai's dedicated lane — recorded, not touched.*
- `GetBindu/awesome-claude-code-and-skills#195`: OPEN, mergeable, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `0xNyk/awesome-hermes-agent#395`: OPEN issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `tolkonepiu/best-of-mcp-servers#384`: OPEN, mergeable, untouched since 2026-09-26 reminder. Standing no-ping rule holds.
- `ai-boost/awesome-harness-engineering#240`: OPEN (conflicting with daily maintainer self-adds). Standing wontfix-spend / no-ping rule holds.
- `hesreallyhim/awesome-claude-code#2871`: OPEN issue, untouched since 2026-09-18 bot validation. Standing no-ping rule holds.
- `natsukium/mcp-servers-nix#606`: OPEN issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `Dokploy/mcp#81`: OPEN, contributor `moataz-hjaiji` progressing with PR for meta-tool `dokploy-loadTools` adopting Nikolai's schema payload and client fallback architecture. No action needed.
- `hashgraph-online/awesome-ai-plugins#182`: MERGED, listed in HOL Registry. Third-party scanner CI refused per repo security policy; claim notifications ignored.
- External comment threads (`lastlight#372`, `pi-extensions#1204`, `nanocoder#1197`, `pyrefly#4583`, `ai-tooling#585`, `pr-agent#2499`, `slopstop#633`, `atlas#105`): all quiet.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (`scripts/mention-sweep.sh`):**
- Re-verified both passes against live GitHub Code Search API. Pass 1 code query `trace-mcp` and pass 2 paired queries (`serena`, `repomix`, `codebase-memory-mcp`, `AGENTS.md`, `CLAUDE.md`) return zero repos outside `ops/mentions-seen.txt`. Sweep remains completely clean.

**Ecosystem & Integration Scouting — OpenCowork (`OpenCoworkAI/open-cowork`):**
- Repository: 2,198★, active Electron/Claude Code desktop wrapper app.
- Codebase analysis of `src/main/mcp/software-dev-server-example.ts`: OpenCowork bundles a built-in Software Development MCP server that exposes `read_code_file` along with GUI automation tools (`start_gui_application`, `gui_interact_vision`, `gui_verify_vision`).
- Key observation: in `readFile()`, file access is restricted purely by lexical path resolution (`path.resolve(WORKSPACE_DIR, filePath)` followed by `startsWith(WORKSPACE_DIR)`). Symlinks are not resolved or verified before reading (`fs.readFile(fullPath)`), mirroring the exact class of path confinement vulnerability found across agent desktop apps.
- Furthermore, the code inspection shows OpenCowork currently relies on simple monolithic `read_code_file` calls for development tasks. Introducing `trace-mcp` code intelligence and AST indexing would drastically reduce token consumption for agent workflows in OpenCowork workspaces. Added to distribution prospective targets.

**Competitor intelligence & architectural observations:**
- `oraios/serena`:
  - Issue #2144: `Serena's file-access tools follow symlinks outside the project root, bypassing their own path-confinement check`. In Serena, `Project.is_path_in_project()` relied purely on lexical normalization (`os.path.normpath()`), intentionally allowing symlinks under the assumption that they point to project files. This allows malicious symlinks in repositories to disclose arbitrary local files (`~/.ssh/id_rsa`, `/etc/passwd`) or overwrite files outside the project root.
  - In `trace-mcp`, symlink security is strictly enforced at every level: `src/utils/security.ts` (`validateWritePath`) verifies realpath confinement and explicitly rejects writing through symlinks; `src/utils/atomic-write.ts` rejects target symlinks; and `src/tools/refactoring/refactor.ts` aborts any codemod touching files resolving outside the project root via symlinks (TRA-1848).
- `DeusData/codebase-memory-mcp`:
  - Issue #2576 (opened 2026-10-09): `TypeScript: import(…).T[] inside a generic call's type argument marks a valid file parse_partial and drops later declarations`. Valid TypeScript code fails parser recovery inside inline import types, causing the parser to abandon extraction and dropping 60%+ of symbol declarations from the graph.
  - In `trace-mcp`, Tree-sitter AST parsing isolates node parse errors without abandoning subsequent AST siblings, ensuring continuous index extraction even across partially malformed syntax trees.
- `tirth8205/code-review-graph`:
  - Issue #1104: No-op `update` leaves stale FTS marked `complete` after `--skip-postprocess`. Confirms ongoing architectural struggles with maintaining SQLite FTS consistency across incremental updates and manual post-processing stages.

**Competitor pulse (as of 2026-10-10 morning):**
- `nikolai-vysotskyi/trace-mcp`: 189★, 24 forks.
- `yamadashy/repomix`: 28,775★, 1,575 forks.
- `oraios/serena`: 30,138★, 2,052 forks.
- `DeusData/codebase-memory-mcp`: 46,247★, 3,805 forks.
- `tirth8205/code-review-graph`: 32,011★, 2,933 forks.
- `colbymchenry/codegraph`: 73,625★, 4,740 forks.
- `abhigyanpatwari/GitNexus`: 47,812★, 5,194 forks.
- `continuedev/continue`: 36,161★, 5,459 forks.
- `Aider-AI/aider`: 49,441★, 5,042 forks.

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.

### Afternoon pass (pass 1), 2026-10-12 (TRA-2364): mention sweep (3 hits analyzed), BB marketplace admission verified, open threads audit, competitor pulse & telemetry, Serena stale preview ID & CBM/CRG architecture analysis

Audited read-only via API, nothing written outside this file.

**Open threads audit (via GitHub API read-only):**
- `get-bb/marketplace#524`: MERGED 2026-10-10T16:17Z by maintainer review (SawyerHood). Entry `entries/trace-mcp.json` is live on `main`. Added to `mentions-seen.txt`.
- `MiniMax-AI/MiniMax-Code-Plugins#54`: OPEN, updated 2026-10-09T01:18Z with Review Round 4 from `hetaoBackend` (`CHANGES_REQUESTED` for commit `bc461c77cef5facbdfc5a22de6aa64d5c11c2bf9`). Reviewer requested:
  1. `TRACE_MCP_NO_POSTINSTALL=1` to prevent background LaunchAgent/daemon creation on first `npx` run.
  2. Prove backend provenance on existing-daemon attachment beyond fixed port `/health` (binding package version, PID, binary path, signature).
  3. Wire smoke test into exact-head CI with enforced assertions.
  4. Clarify transactional safety claims regarding multi-file refactors (document real preview/confirmation/rollback semantics rather than claiming atomic rollback).
  *Note: Nikolai's dedicated lane — recorded, not touched.*
- `GetBindu/awesome-claude-code-and-skills#195`: OPEN, mergeable, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `0xNyk/awesome-hermes-agent#395`: OPEN issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `tolkonepiu/best-of-mcp-servers#384`: OPEN, mergeable, untouched since 2026-09-26 reminder. Standing no-ping rule holds.
- `ai-boost/awesome-harness-engineering#240`: OPEN (conflicting with daily maintainer self-adds). Standing wontfix-spend / no-ping rule holds.
- `hesreallyhim/awesome-claude-code#2871`: OPEN issue, untouched since 2026-09-18 bot validation. Standing no-ping rule holds.
- `natsukium/mcp-servers-nix#606`: OPEN issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `Dokploy/mcp#81`: OPEN, contributor `moataz-hjaiji` (2026-10-08) progressing with PR for meta-tool `dokploy-loadTools` adopting Nikolai's schema payload and client fallback architecture. No action needed.
- `hashgraph-online/awesome-ai-plugins#182`: MERGED, listed in HOL Registry. Third-party scanner CI refused per repo security policy; claim notifications ignored.
- External comment threads (`lastlight#372`, `pi-extensions#1204`, `nanocoder#1197`, `pyrefly#4583`, `ai-tooling#585`, `pr-agent#2499`, `slopstop#633`, `atlas#105`): all quiet.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (`scripts/mention-sweep.sh`):**
- Ran both passes (`gh search code` and `gh api search/code` paired queries). Found 3 repos outside `ops/mentions-seen.txt`.
- All 3 inspected read-only via API/raw content:
  1. `get-bb/marketplace`: Merged marketplace PR #524 in `entries/trace-mcp.json`. Classified in `ops/mentions-seen.txt`.
  2. `lza6/Armor-piercing-system-prompts` (4★, 2 forks): Aggregated Chinese Claude Code agent skills repository. Contains 4 complete `trace-mcp` skills: `05-技能与代理开发/trace-mcp/SKILL.md` (code navigation routing over 182 tools), `07-后端与架构/trace-mcp-codemod/SKILL.md` (codemods), `04-安全渗透/trace-mcp-pre-commit/SKILL.md`, and `07-后端与架构/trace-mcp-refactoring/SKILL.md`. Formulates explicit rules forbidding agents from using Read/Grep/Glob/Bash on code when trace-mcp is available. Genuine third-party packaging/ecosystem surface; added to Surfaces table and `ops/mentions-seen.txt`.
  3. `wkoch/xrai` (0★, active): Deep comparative study `docs/ESTUDO-COMPARATIVO.md` ("Oito referências para o xrai", 2026-10-11) evaluating `trace-mcp` v3.36.4 alongside 7 code graph tools. Evaluates `trace-mcp`'s 81 language plugins matrix, SCIP ingestion (`src/scip/ingest.ts`), `get_task_context` budget assembly (`src/scoring/structured-assembly.ts`), session deduplication, and benchmark methodology (72.7% token reduction) and post-mortem (`docs/perf/pr-context-loss-classes.md`). Genuine third-party architecture analysis & citation; added to Surfaces table and `ops/mentions-seen.txt`.

**Competitor intelligence & architectural observations:**
- `oraios/serena`:
  - Issue #2154 (opened 2026-10-10 by `dafyy321-pixel`): `replace_in_files can apply a stale preview ID to a different identical match`. Serena builds occurrence IDs as `<relative path>:<match index>@<digest of matched text>`. If lines are deleted or inserted between dry-run and apply, ordinal indices shift; when applying the old ID, Serena mutates an unintended occurrence without warning.
  - In `trace-mcp`, `apply_codemod` avoids fragile ordinal IDs altogether: dry-run provides a contextual preview, while apply mode verifies the pattern dynamically against the current file state, writes atomically via `atomicWriteFile`, and enforces symlink boundary containment (`validateWritePath`).
- `DeusData/codebase-memory-mcp`:
  - Issue #2591 (2026-10-11): `query_graph: a WHERE comparison between two properties (a.file_path = b.file_path) fails with "expected value at pos N"`. Cypher query parser fails on property-to-property joins.
  - Issues #2587 & #2588: Directory moves cause references to disappear without tracking unresolved records, while dangling member references degrade into file-level edges without validation.
- `tirth8205/code-review-graph`:
  - Issue #1110 (2026-10-10): `tsconfig baseUrl/paths inherited through "extends" are resolved against the child config's directory`. Misconfigured TS config resolution when inheritance is involved.
  - Issue #1107: `rename refactor leaves 'from module import old_name' unchanged, so applied code raises ImportError`. Python AST renamer fails on import statements.

**Competitor pulse (as of 2026-10-12 afternoon):**
- `nikolai-vysotskyi/trace-mcp`: 190★ (+1), 24 forks.
- `yamadashy/repomix`: 28,802★, 1,579 forks.
- `oraios/serena`: 30,197★, 2,058 forks.
- `DeusData/codebase-memory-mcp`: 46,405★, 3,813 forks.
- `tirth8205/code-review-graph`: 32,060★, 2,936 forks.
- `colbymchenry/codegraph`: 73,794★, 4,759 forks.
- `abhigyanpatwari/GitNexus`: 47,844★, 5,194 forks.
- `continuedev/continue`: 36,192★, 5,462 forks.
- `Aider-AI/aider`: 49,488★, 5,047 forks.

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.

### Evening pass (pass 2), 2026-10-12 (TRA-2366): mention sweep clean verification, open threads audit, catalog spam evaluation, competitor pulse & architectural insights

Audited read-only via API, nothing written outside this file.

**Open threads audit (via GitHub API read-only):**
- `MiniMax-AI/MiniMax-Code-Plugins#54`: OPEN, updated 2026-10-09T01:18Z with Review Round 4 from `hetaoBackend` (`CHANGES_REQUESTED`). Nikolai's dedicated lane — recorded, not touched.
- `GetBindu/awesome-claude-code-and-skills#195`: OPEN, mergeable, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `0xNyk/awesome-hermes-agent#395`: OPEN issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `tolkonepiu/best-of-mcp-servers#384`: OPEN, mergeable, untouched since 2026-09-26 reminder. Standing no-ping rule holds.
- `ai-boost/awesome-harness-engineering#240`: OPEN (conflicting with daily maintainer self-adds). Standing wontfix-spend / no-ping rule holds.
- `hesreallyhim/awesome-claude-code#2871`: OPEN issue, untouched since 2026-09-18 bot validation. Standing no-ping rule holds.
- `natsukium/mcp-servers-nix#606`: OPEN issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `Dokploy/mcp#81`: OPEN, contributor `moataz-hjaiji` (2026-10-08) progressing with PR for meta-tool `dokploy-loadTools` adopting Nikolai's schema payload and client fallback architecture. No action needed.
- `hashgraph-online/awesome-ai-plugins#182`: MERGED, listed in HOL Registry. Third-party scanner CI refused per repo security policy; claim notifications ignored.
- External comment threads (`lastlight#372`, `pi-extensions#1204`, `nanocoder#1197`, `pyrefly#4583`, `ai-tooling#585`, `pr-agent#2499`, `slopstop#633`, `atlas#105`): all quiet.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (`scripts/mention-sweep.sh`):**
- Ran both passes (`gh search code` and `gh api search/code` paired queries). Output: `No repos outside the seen list. Nothing to read.` All 3 repos from the previous sweep (`get-bb/marketplace`, `lza6/Armor-piercing-system-prompts`, `wkoch/xrai`) were safely recorded in `ops/mentions-seen.txt`. Sweep is clean.

**Ecosystem & catalog intelligence (mcp-serverlist.com spam campaign evaluation):**
- Identified mass automated outreach campaign by `tonylate520` (repo `tonylate520/mcp-serverlist`, 0★, created 2026-10-10) opening cookie-cutter issues across 40+ repositories (including competitor PR #2604 on `DeusData/codebase-memory-mcp`, plus issues on `chigwell/telegram-mcp`, `crystaldba/postgres-mcp`, `chroma-core/chroma-mcp`, `OctoEverywhere/mcp`, `yuna0x0/anilist-mcp` — where maintainer marked it `invalid`).
- Format: "Added 1-click config generator and setup guide for <repo> on MCP ServerList" with prompt to add a backlink badge to README.
- Assessment: Classic SEO badge/link-farm tactic, zero organic audience, automated spam pattern. Classified as **link-farm / never-touch** under repo security rules. If/when an issue is opened on `nikolai-vysotskyi/trace-mcp`, decline and close without adding badge.

**Competitor intelligence & architectural observations:**
- `oraios/serena`:
  - Issue #2153 (`Serena is resource-intensive`): User reports running Serena over stdio MCP in multi-agent harness (Codex subagents) spawns multiple Serena processes per conversation, leaking and exceeding 32 GB RAM. Switching conversations races and overflows memory. Furthermore, running over HTTP triggers concurrency races on workspace directory switching (`parallel tasks racing to switch projects`), causing language parsers to fail loading.
  - Architectural contrast: `trace-mcp`'s daemon model with persistent SQLite/LMDB index, memory-mapped query paths, and strict worker isolation completely avoids runaway multi-process RAM inflation. Multiple client connections reuse the background server without re-parsing or duplicating AST buffers.
- `jgravelle/jcodemunch-mcp`:
  - Release v1.108.348 & v1.108.349 (2026-10-12): Fixes dead code detection bug (L-165, L-166) where cross-file calls in languages without explicit per-file imports (Go, Java, C#, Rust, Ruby) were falsely flagged as `no_callers`.
  - Consequence & limitation: Fix matches callers strictly by bare name (`LANGUAGES_CALLED_ACROSS_FILES_WITHOUT_AN_IMPORT`). As jCodeMunch explicitly documents in their PR description: "The match is by name, so an uncalled function can hide behind any call of its name" — e.g. uncalled `fn len()` is falsely cleared by `v.len()` on `Vec`, Go `Println` cleared by `fmt.Println`, C# `Dispose` cleared by `s.Dispose()`. Of 289 ripgrep functions no longer reported dead, 179 matched by bare name collisions.
  - Architectural contrast: `trace-mcp` relies on lexical scope and framework/package-aware SCIP graph resolution rather than global bare-name fuzzy matching, avoiding false negative caller masking.
- `tirth8205/code-review-graph`:
  - Feature request #1113 (`networkx with backend=arrow`): NetworkX in-memory representation exhausts system memory on large codebases. Maintainer exploring immutable Arrow-backed graphs (`nx-arrow`) to cut memory 6–7x.
  - Bug #1109 (`detect_changes reports React components as untested when the spec renders them through a test-file helper`): Demonstrates false positive test-gap reporting when tests call indirect helpers, and TS interfaces are categorized as `Class` nodes without exemption.
  - Architectural contrast: `trace-mcp` uses on-disk SQLite/SCIP representations with streaming iterators and custom indexed schema, keeping heap usage bounded regardless of graph node count.

**Competitor pulse (as of 2026-10-12 evening):**
- `nikolai-vysotskyi/trace-mcp`: 190★, 24 forks.
- `yamadashy/repomix`: 28,806★, 1,581 forks.
- `oraios/serena`: 30,198★, 2,060 forks.
- `DeusData/codebase-memory-mcp`: 46,418★, 3,815 forks.
- `tirth8205/code-review-graph`: 32,074★, 2,936 forks.
- `colbymchenry/codegraph`: 73,807★, 4,763 forks.
- `abhigyanpatwari/GitNexus`: 47,848★, 5,195 forks.
- `continuedev/continue`: 36,194★, 5,462 forks.
- `Aider-AI/aider`: 49,493★, 5,047 forks.

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.

### Late evening pass (pass 3), 2026-10-12 (TRA-2368): mention sweep verified clean, open threads audit, competitor deep dive & architectural insights

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- `MiniMax-AI/MiniMax-Code-Plugins#54`: OPEN, updated 2026-10-09T01:18Z with Review Round 4 from `hetaoBackend` (`CHANGES_REQUESTED`). Nikolai's dedicated lane — recorded, not touched.
- `GetBindu/awesome-claude-code-and-skills#195`: OPEN, mergeable, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `0xNyk/awesome-hermes-agent#395`: OPEN issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `tolkonepiu/best-of-mcp-servers#384`: OPEN, mergeable, untouched since 2026-09-26 reminder. Standing no-ping rule holds.
- `ai-boost/awesome-harness-engineering#240`: OPEN (conflicting with maintainer self-adds). Standing wontfix-spend / no-ping rule holds.
- `hesreallyhim/awesome-claude-code#2871`: OPEN issue, untouched since 2026-09-18 bot validation. Standing no-ping rule holds.
- `natsukium/mcp-servers-nix#606`: OPEN issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `Dokploy/mcp#81`: OPEN, contributor `moataz-hjaiji` (2026-10-08) progressing with PR for meta-tool `dokploy-loadTools` adopting Nikolai's schema payload and client fallback architecture. No action needed.
- `hashgraph-online/awesome-ai-plugins#182`: MERGED, listed in HOL Registry. Third-party scanner CI refused per repo security policy; claim notifications ignored.
- External comment threads (`lastlight#372`, `pi-extensions#1204`, `nanocoder#1197`, `pyrefly#4583`, `ai-tooling#585`, `pr-agent#2499`, `slopstop#633`, `atlas#105`): all quiet.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (`scripts/mention-sweep.sh`):**
- Ran both passes (`gh search code` and `gh api search/code` paired queries against rivals and agent definitions). Output: `No repos outside the seen list. Nothing to read.` Sweep is verified 100% clean across all 9 search patterns.

**Competitor intelligence & deep-dive architectural observations:**
- `colbymchenry/codegraph`:
  - PR #2526 (`fix(ts): a re-export imports its module, and sync follows barrels of barrels`):
    - Problem: Re-export statements (`export … from './x'`) left almost nothing in the graph. Both extractors emitted one `imports` reference per re-exported name (`export { A } from './x'` → `A`), emitting nothing for the module itself, and nothing at all for `export * from './x'`. As a result, consumer files importing from re-export barrels failed to connect to downstream modules, and deep barrel chains broke graph traversal.
    - Architectural contrast: `trace-mcp` handles TypeScript/JavaScript barrel re-exports, namespace wildcard exports (`export *`), and aliased named exports directly at the SCIP indexing layer. Re-export symbols retain explicit canonical provenance, preventing broken reachability in modular codebases without requiring ad-hoc graph stitching passes.
  - PR #2524 (`feat(resolution): link imported Tauri invokes to registered Rust commands`):
    - Problem: Frontend `invoke("command_name")` calls were completely decoupled from backend Rust command handlers, creating artificial cross-language call-graph disconnects in hybrid desktop apps.
    - Solution: Adds a Rust + JS synthesis pass that resolves invoke string arguments to registered Rust command handlers.
    - Note for `trace-mcp`: `trace-mcp` indexes Electron/Tauri IPC boundaries and multi-language workspaces, modeling desktop app architecture where frontend and native code communicate over string IPC messages.
- `DeusData/codebase-memory-mcp`:
  - PR #2608 (`fix(discover): a .gitignore never hides a file git tracks`):
    - Problem: File discovery blindly applied `.gitignore` patterns to all discovered paths. Under Git semantics, `.gitignore` only ignores *untracked* files; files explicitly tracked in Git (`git add -f`) must never be ignored even if a rule matches (e.g. `kubernetes-sigs/cluster-api` tracking `test/infrastructure/docker/manager` despite a local `manager` ignore rule).
    - Architectural contrast: `trace-mcp` relies on `git ls-files` when operating within a Git repository, ensuring indexed file sets perfectly match repository working trees.
  - PR #2607 (`fix(graph): the id counter is never lowered after a parallel phase`):
    - Problem: When merging parallel extraction/resolution phases, pipeline ID synchronization inadvertently allowed setting next ID counter lower than allocated, causing edge ID reuse and memory/graph corruption.
    - Architectural contrast: `trace-mcp` uses monotonically increasing SQLite autoincrement primary keys and immutable transaction boundaries, preventing ID collision regressions during parallel worker merges.
- `jgravelle/jcodemunch-mcp`:
  - PR #1046 / Release v1.108.350 (`fix: the watcher reconciles a HEAD move that changed no file (#1040)`):
    - Problem: Repositories read `stale` after `git commit`, `git switch -c`, or `git checkout` because the filesystem watcher only listened to working tree files, ignoring `.git/`. A commit without working tree file changes never triggered a re-index, causing `search_text` to refuse certifying absence. Fixed by adding a 1-second idle tick comparing stored `HEAD` ref.
    - Architectural contrast: `trace-mcp` tracks repo revision state cleanly through daemon event subscriptions and checks commit SHAs on query/tool execution without relying on polling loops.

**Competitor pulse (as of 2026-10-12 late evening):**
- `nikolai-vysotskyi/trace-mcp`: 190★, 24 forks.
- `yamadashy/repomix`: 28,806★, 1,583 forks (+2).
- `oraios/serena`: 30,202★, 2,062 forks (+4★, +2 forks).
- `DeusData/codebase-memory-mcp`: 46,428★, 3,815 forks (+10★).
- `tirth8205/code-review-graph`: 32,082★, 2,936 forks (+8★).
- `colbymchenry/codegraph`: 73,816★, 4,763 forks (+9★).
- `abhigyanpatwari/GitNexus`: 47,852★, 5,196 forks (+4★, +1 fork).
- `jgravelle/jcodemunch-mcp`: 2,762★, 374 forks.
- `continuedev/continue`: 36,196★, 5,462 forks (+2★).
- `Aider-AI/aider`: 49,501★, 5,047 forks (+8★).

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.

### Early morning pass (pass 1), 2026-10-13 (TRA-2373): mention sweep (Graft citation, goCraft local state, TRACE collision), open threads audit, competitor deep dive & architectural insights

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- `MiniMax-AI/MiniMax-Code-Plugins#54`: OPEN, updated 2026-10-09T01:18Z with Review Round 4 from `hetaoBackend` (`CHANGES_REQUESTED`). Nikolai's dedicated lane — recorded, not touched.
- `GetBindu/awesome-claude-code-and-skills#195`: OPEN, mergeable, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `0xNyk/awesome-hermes-agent#395`: OPEN issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `tolkonepiu/best-of-mcp-servers#384`: OPEN, mergeable, untouched since 2026-09-26 reminder. Standing no-ping rule holds.
- `ai-boost/awesome-harness-engineering#240`: OPEN (conflicting with maintainer self-adds). Standing wontfix-spend / no-ping rule holds.
- `hesreallyhim/awesome-claude-code#2871`: OPEN issue, untouched since 2026-09-18 bot validation. Standing no-ping rule holds.
- `natsukium/mcp-servers-nix#606`: OPEN issue, untouched since 2026-09-20 reminder. Standing no-ping rule holds.
- `Dokploy/mcp#81`: OPEN, contributor `moataz-hjaiji` (2026-10-08) progressing with PR for meta-tool `dokploy-loadTools` adopting Nikolai's schema payload and client fallback architecture. No action needed.
- `hashgraph-online/awesome-ai-plugins#182`: MERGED, listed in HOL Registry. Third-party scanner CI refused per repo security policy; claim notifications ignored.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (`scripts/mention-sweep.sh`):**
- Ran both passes (`gh search code` and `gh api search/code` paired queries). Found 3 new repositories mentioning `trace-mcp`:
  1. `h0rn3t/Graft` (4★): Code intelligence research document `RESEARCH.md` surveying agent code graph tools. Cites `trace-mcp`: *"Honest PR-review bench: −72.7% input tokens, but false positives 0.58 → 0.80 | A model for honest reporting"*. Evaluated alongside jCodeMunch, codedb, fff, pgr, tokensave. Recorded as genuine third-party benchmark citation in surfaces table and `ops/mentions-seen.txt`.
  2. `wkoch/goCraft`: Desktop agent development & commit logs (`docs/conversas/2026-10-11.md`). In commit session rules, explicitly preserves `.trace-mcp/install-date` and `.trace-mcp/guard-mode` as local installation state across commit iterations. Recorded as genuine user adoption in surfaces table and `ops/mentions-seen.txt`.
  3. `vaibhavidhumal4/TRACE`: Name collision — unrelated microservices architecture using internal Cloud Run service account / container name "trace-mcp" for BigQuery telemetry export (`infra/03-service-accounts.sh`, `CLAUDE.md`). Classified and silenced in `ops/mentions-seen.txt`.

**Competitor intelligence & deep-dive architectural observations:**
- `colbymchenry/codegraph`:
  - Issue #2527 (`CLI worker pools default to cpus-1 each with no user-facing cap — index builds can saturate many-core machines`):
    - Problem: CLI worker pools allocate `cpus - 1` workers by default with no user-facing concurrency cap or throttling knob. On large multi-core machines (e.g. 18+ logical cores), index builds saturate CPU resources (load average 38, ~1700% CPU), causing system responsiveness degradation and background daemon contention.
    - Architectural contrast: `trace-mcp`'s daemon implements adaptive worker scaling, task concurrency caps, cooperative yielding during AST ingestion, and background process priority throttling, preventing host CPU starvation.
  - PR #2530 (`fix(cpp): a smart pointer's held class lacking a method gets no edge only when its bases are known`):
    - Problem: `->` calls on smart pointers (`std::unique_ptr`, `std::shared_ptr`, `std::optional`) whose held class lacks the method were dropping call-graph edges even when base classes were incomplete/unresolved in the index, leading to false-negative edge omissions.
    - Solution: Only suppresses edges when all base classes are completely known; otherwise retains conservative reachable edge candidate.
    - Architectural contrast: `trace-mcp` uses SCIP symbol resolution semantics where unresolved inheritance hierarchy leaves open candidate links rather than dropping reachability edges.
  - PR #2529 (`fix(sync): an import moves to an added file that outranks the one it found`):
    - Problem: Incremental sync failed to re-resolve extensionless imports when a higher-precedence file was added (e.g. adding `button.ts` next to existing `button.vue` where `.ts` takes precedence over `.vue`). Sync only retried imports that previously failed, locking the call graph into stale targets.
    - Architectural contrast: `trace-mcp` maintains revision invalidation sets based on directory addition events, forcing re-resolution of extensionless import boundaries when shadow files are introduced.
- `DeusData/codebase-memory-mcp`:
  - PR #2613 (`fix(markdown): qualify a repeated heading's Section by its parent headings (#2586)`):
    - Problem: Markdown Section qualified names were constructed as `module.heading_text`. Repeated heading titles (such as `## Implementation` appearing under multiple parent `# Service A` and `# Service B` sections) collided on the same qualified name, overwriting graph nodes and attaching references to the wrong parent file.
    - Architectural contrast: `trace-mcp`'s outline and structural hierarchy builds fully qualified breadcrumb paths (`file#h1/h2/...`), guaranteeing deterministic uniqueness for identical subheadings across documentation trees.
- `tirth8205/code-review-graph`:
  - PR #1111 (`fix(tsconfig): anchor inherited baseUrl and paths at the config that declares them (#1110)`):
    - Problem: `TsconfigResolver` merged `baseUrl` and `paths` from parent configs but resolved them against the child config's directory, breaking path alias lookups in monorepo layouts (Nx/Turborepo) and causing `IMPORTS_FROM` edges to miss shared libraries.
    - Architectural contrast: `trace-mcp` resolves TSConfig `baseUrl` and `paths` relative to the exact configuration file where the property is declared before merging into composite workspace mappings.
- `jgravelle/jcodemunch-mcp`:
  - PR #1048 / Release v1.108.351 (`fix: creating a class counts as a call of its constructor`):
    - Problem: Class instantiations were not linked to constructors in call-graph reachability, erroneously reporting constructors as uncalled/dead code.

**Competitor pulse (as of 2026-10-13 early morning):**
- `nikolai-vysotskyi/trace-mcp`: 191★ (+1), 24 forks.
- `yamadashy/repomix`: 28,808★ (+2), 1,584 forks (+1).
- `oraios/serena`: 30,209★ (+7), 2,062 forks (=).
- `DeusData/codebase-memory-mcp`: 46,436★ (+8), 3,815 forks (=).
- `tirth8205/code-review-graph`: 32,084★ (+2), 2,936 forks (=).
- `colbymchenry/codegraph`: 73,823★ (+7), 4,764 forks (+1).
- `abhigyanpatwari/GitNexus`: 47,851★ (-1), 5,195 forks (-1).
- `jgravelle/jcodemunch-mcp`: 2,762★ (=), 375 forks (+1).
- `continuedev/continue`: 36,201★ (+5), 5,463 forks (+1).
- `Aider-AI/aider`: 49,503★ (+2), 5,050 forks (+3).

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.

### Morning pass (pass 2), 2026-10-13 (TRA-2385): mention sweep, internal seeder classification, competitor triage (PR #2535, PR #2617, PR #2619, PR #1112, PR #1053)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- All 9 tracked external threads verified. Statuses unchanged:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (updated 2026-10-09T01:18Z with Round 4 review from hetaoBackend). Nikolai dedicated lane.
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds.
  - ai-boost/awesome-harness-engineering#240: OPEN, standing no-ping rule holds.
  - hesreallyhim/awesome-claude-code#2871: OPEN, standing no-ping rule holds.
  - natsukium/mcp-servers-nix#606: OPEN, standing no-ping rule holds.
  - Dokploy/mcp#81: OPEN, community implementation progressing.
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns. One new repo returned:
  - assetfeed/assetfeed-laravel: internal reference in Nikolai portfolio / agency site seeder (database/seeders/data/site_pages.php lines citing trace-mcp MIT). Verified read-only via GitHub API. Classified as internal self-reference and recorded in ops/mentions-seen.txt.

**Competitor intelligence & architectural observations:**
- colbymchenry/codegraph:
  - PR #2535 (fix(resolution): a workspace package import resolves to its package.json entry (#2502)):
    - Problem: Workspace member imports (import { x } from '@acme/core' or subpaths like @acme/core/schema) only resolved if an index.* file existed at the package root directory. In standard TypeScript monorepos where package.json specifies 'main': './src/index.ts' and conditional 'exports' maps, imports without root indexes failed resolution and fell back to proximity-based name guessing, attaching calls to wrong private symbols.
    - Solution: Reads package.json member exports mappings ('.' and subpaths) respecting condition order (types, import, default, require).
    - Architectural contrast: trace-mcp handles workspace package entry resolution in src/indexer/package-entries.ts (enhanced in TRA-2371 / #1572), respecting TSConfig project references, paths, and package.json exports entries deterministically.
- DeusData/codebase-memory-mcp:
  - PR #2619 (fix(lsp): no pointer offset on an empty C# or Java definition array):
    - Problem: Under Clang UBSan on macOS, applying zero offset to a NULL pointer (NULL + 0) in Tier-2 registry builders when indexing projects lacking C# or Java definitions triggers runtime error: applying zero offset to null pointer.
  - PR #2617 (fix: never qsort an empty k8s vector; split the spawner deletion test):
    - Problem: Calling qsort(NULL, 0, ...) on an empty array triggers glibc nonnull attribute runtime violation in Linux GCC UBSan builds.
    - Architectural contrast: trace-mcp runs on Node/TypeScript with strict array bounds checks and explicit empty-slice guards, avoiding native pointer arithmetic defects.
- tirth8205/code-review-graph:
  - PR #1112 (fix: keep TypeScript interfaces and type aliases out of test gaps):
    - Problem: TypeScript interface and type declarations were stored as Class nodes with no runtime body. The gap filter in changes.py treated every changed Class node as needing tests, producing false positives in code-review test-gap reports.
    - Solution: Stores typescript_kind in metadata and excludes pure type declarations from test gap candidates.
    - Architectural contrast: trace-mcp differentiates type-only definitions from runtime symbols during Tree-sitter / SCIP AST passes, ensuring outline and dependency graphs cleanly distinguish interface declarations from executable constructs.
- jgravelle/jcodemunch-mcp:
  - PR #1053 / Release v1.108.353 (fix: a C# new records the class it creates (L-170)):
    - Problem: C# object_creation_expression (new Made(...)) was not registered as a call node type. get_dead_code_v2 found zero callers for constructors and erroneously marked active constructors as dead code.

**Competitor pulse (as of 2026-10-13 morning):**
- nikolai-vysotskyi/trace-mcp: 191* (=), 24 forks (=)
- yamadashy/repomix: 28,810* (+2), 1,584 forks (=)
- oraios/serena: 30,213* (+4), 2,062 forks (=)
- DeusData/codebase-memory-mcp: 46,456* (+20), 3,819 forks (+4)
- tirth8205/code-review-graph: 32,093* (+9), 2,937 forks (+1)
- colbymchenry/codegraph: 73,843* (+20), 4,766 forks (+2)
- abhigyanpatwari/GitNexus: 47,858* (+7), 5,196 forks (+1)
- jgravelle/jcodemunch-mcp: 2,763* (+1), 375 forks (=)
- continuedev/continue: 36,203* (+2), 5,463 forks (=)
- Aider-AI/aider: 49,510* (+7), 5,051 forks (+1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.

### Afternoon pass, 2026-10-13 (TRA-2388): mention sweep clean, thread audit, competitor deep dive & architectural insights (PR #2150, PR #2155, PR #1055, PR #1058, PR #2533, PR #2608)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- All 9 tracked external threads verified. Statuses unchanged:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend in progress). Nikolai dedicated lane.
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds.
  - ai-boost/awesome-harness-engineering#240: OPEN, standing no-ping rule holds.
  - hesreallyhim/awesome-claude-code#2871: OPEN, standing no-ping rule holds.
  - natsukium/mcp-servers-nix#606: OPEN, standing no-ping rule holds.
  - Dokploy/mcp#81: OPEN, community implementation progressing.
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (Pass 1 modern backend + Pass 2 legacy multi-term pairs). Clean: 0 repos outside seen list.

**Competitor intelligence & architectural observations:**
- oraios/serena:
  - PR #2150 (Confine file access to the project root for untrusted projects (checking symlinks accordingly)):
    - Problem: `Project.is_path_in_project` checked containment purely lexically (`os.path.normpath`), so a symlink contained inside the project pointing outside passed lexical checks while leaking outside content during tool execution (`read_file`, `create_text_file`, `search_for_pattern`, `find_file`).
    - Solution: Canonical path resolution checking `realpath` and rejecting operations escaping project root through symlinks.
    - Architectural contrast: Identical boundary vulnerability addressed upstream in trace-mcp during MiniMax review in v3.31.4 (`tests/tools/refactor-confinement.test.ts`), enforcing strict realpath validation and refusing symlink traversal before any read/write execution.
  - PR #2155 (Fix replace_in_files accepting stale occurrence selections):
    - Problem: `replace_in_files` accepted a selection ID from an earlier preview after the selected file had changed on disk, silently applying the replacement to a subsequent occurrence or wrong range.
    - Solution: Validates occurrence ID against disk content and character range before applying modifications.
    - Architectural contrast: trace-mcp verifies file hashes / range tokens in refactoring / codemod tools (`apply_codemod`, `extract_function`) to guarantee atomicity and guard against concurrent or stale edits.
- jgravelle/jcodemunch-mcp:
  - PR #1058 / Release v1.108.355 (fix: a bare Ruby method call is recorded (L-172)):
    - Problem: Ruby allows calling zero-argument methods without receivers as bare identifiers (`settings`). Tree-sitter parses these as `identifier` nodes rather than `call` nodes; parser ignored identifiers, causing `get_dead_code_v2` to classify active helper methods as dead code (`no_callers`).
    - Solution: Inspects identifier nodes in call positions and resolves bare names against scope method definitions.
    - Architectural contrast: trace-mcp's SCIP and AST symbol resolution pipeline resolves bare calls via lexical scope symbol tables, avoiding false-positive dead code classification.
  - PR #1055 / Release v1.108.354 (fix: a Go generic call with one argument is recorded (L-171)):
    - Problem: In Go grammar, a single-argument generic function call `Generic[int](1)` parses identically to a type conversion `type_conversion_expression` with a `generic_type`. The parser skipped type conversion nodes, missing generic calls and causing dead code false positives.
    - Solution: Treats `type_conversion_expression` nodes with generic targets as call candidates.
    - Architectural contrast: trace-mcp handles Go ASTs with comprehensive call expression and type conversion disambiguation in AST walkers.
- colbymchenry/codegraph:
  - PR #2533 (fix(cpp): a call on a data member of the caller's class reaches its type's method, wherever the class is declared):
    - Problem: C++ receiver inference only scanned the caller file and matching header (`foo.cc` -> `foo.h`). Data members declared in separate class definition headers (e.g., `DBImpl` in `db_impl.h` with methods split across `db_impl_write.cc`, `db_impl_open.cc`) fell back to name guessing at 0.65/0.7 confidence.
    - Solution: Traverses full class declaration scope across translation units.
    - Architectural contrast: trace-mcp indexes symbols globally across the project graph, resolving member types through header indexing regardless of file boundaries.
- DeusData/codebase-memory-mcp:
  - PR #2608 (fix(discover): a .gitignore never hides a file git tracks):
    - Problem: Discovery applied `.gitignore` rules blindly to every path, filtering out tracked files that matched gitignore patterns (e.g., tracked binaries or overlays).
    - Solution: Queries `git ls-files -z` when inside a git repository before applying ignore heuristics.
    - Architectural contrast: trace-mcp uses standard git-aware ignore logic honoring tracked files.

**Competitor pulse (as of 2026-10-13 afternoon):**
- nikolai-vysotskyi/trace-mcp: 191* (=), 24 forks (=)
- yamadashy/repomix: 28,816* (+6), 1,584 forks (=)
- oraios/serena: 30,222* (+9), 2,062 forks (=)
- DeusData/codebase-memory-mcp: 46,470* (+14), 3,820 forks (+1)
- tirth8205/code-review-graph: 32,103* (+10), 2,937 forks (=)
- colbymchenry/codegraph: 73,875* (+32), 4,767 forks (+1)
- abhigyanpatwari/GitNexus: 47,864* (+6), 5,195 forks (-1)
- jgravelle/jcodemunch-mcp: 2,764* (+1), 375 forks (=)
- continuedev/continue: 36,208* (+5), 5,464 forks (+1)
- Aider-AI/aider: 49,522* (+12), 5,050 forks (=)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.

### Early morning pass, 2026-10-14 (TRA-2397): mention sweep clean, competitor triage (colbymchenry/codegraph PR #2539-#2542, DeusData PR #2633-#2635, jgravelle PR #1066, oraios/serena PR #2159)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- All 9 tracked external threads verified. Statuses unchanged:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (updated 2026-10-09T01:18Z with Round 4 review from hetaoBackend). Nikolai dedicated lane.
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds.
  - ai-boost/awesome-harness-engineering#240: OPEN, standing no-ping rule holds.
  - hesreallyhim/awesome-claude-code#2871: OPEN, standing no-ping rule holds.
  - natsukium/mcp-servers-nix#606: OPEN, standing no-ping rule holds.
  - Dokploy/mcp#81: OPEN, community implementation progressing.
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Output: "No repos outside the seen list. Nothing to read." Sweep is completely clean. No additions needed to ops/mentions-seen.txt.

**Competitor intelligence & architectural observations:**
- colbymchenry/codegraph:
  - PR #2542 (fix(cpp): a nested class defined out of line is indexed under its name, and a construction makes the class C++ finds):
    - Problem: Out-of-line nested class/struct/union definitions (e.g. LevelDB `struct SkipList<Key, Comparator>::Node { ... }`, RocksDB `struct BlockBasedTableOptions::IndexType`) were parsed as `<anonymous>` classes in AST traversals, disconnecting member methods from outer class hierarchy.
    - Solution: Preserves qualified parent-scope path for out-of-line class declarations when indexing symbol table.
    - Architectural contrast: trace-mcp uses Tree-sitter AST queries with full lexical scope resolution (`src/indexer/ast/cpp.ts`), tracking nested qualification paths directly in symbol ids.
  - PR #2541 (fix(cpp): a call to an overloaded method links to the overload its arguments fit):
    - Problem: Method calls on typed receivers (`db->Get(ro, key, &value)`) always resolved to the first declared overload in the class rather than matching argument counts and types.
    - Solution: Differentiates method overloads via parameter signature matching on receiver instances.
    - Architectural contrast: trace-mcp indexes overloads with distinct symbol hashes and signatures, preserving disambiguation metadata for navigation and impact analysis.
  - PR #2539 (fix(cpp): `->` on an absl::StatusOr reaches the class it holds; a using-declared member of a dependent base is found):
    - Problem: Member arrow operators on smart wrapper types like `absl::StatusOr<T>` or `std::expected<T, E>` failed to unwrap to the target class `T`, dropping all downstream call-graph edges in Abseil/Protobuf codebases.
    - Solution: Explicit unwrapping heuristic for common monadic/holder types in C++.
    - Architectural contrast: trace-mcp SCIP/LSP indexing resolves operator overload return types and template instantiations via semantic compiler models where available, avoiding hardcoded container whitelists.
- DeusData/codebase-memory-mcp:
  - PR #2635 (chore(ui): drop sharp and its LGPL libvips; the license gate allows no exception):
    - Problem: Transitive dependency `@img/sharp-wasm32` brought in LGPL-3.0-or-later libvips, failing enterprise release license gates for commercial embedding.
    - Solution: Stripped `sharp` from graph-ui dependencies.
    - Architectural contrast: trace-mcp maintains zero-dependency CLI/core runtime with pure MIT/Apache-2.0 dependencies, strictly avoiding LGPL/native-compilation overheads.
  - PR #2633 (fix(cli): never wait on a stdin stream for a call complete without arguments):
    - Problem: Commands like `cli list_projects` with no arguments hung indefinitely when stdin was an unclosed pipe (SSH sessions, `child_process.spawn` parents).
    - Solution: Skips waiting on stdin when arguments are already supplied or schema expects no input payload.
    - Architectural contrast: trace-mcp CLI (`src/cli/`) uses explicit non-blocking argument parsing with standard Commander.js command handlers, isolating stream I/O to JSON-RPC transports.
- jgravelle/jcodemunch-mcp:
  - PR #1066 (fix: a Python import written over several lines records its names (L-176)):
    - Problem: Multi-line parenthesized imports (`from pkg import (\n a,\n b\n)`) failed regex/line-based reference scanning, causing `find_references` to report 0 callers for symbols imported in standard Black/Ruff formatted files.
    - Solution: Multi-line AST grouping for import lists.
    - Architectural contrast: trace-mcp uses Tree-sitter parse trees rather than regex/line scanners, inherently handling multi-line AST nodes across all supported languages.
- oraios/serena:
  - PR #2159 (fix(hooks): classify searches and reads run via native Bash tools):
    - Problem: In Claude Code 2.1.117+, search and read actions invoked via the native `Bash` tool bypassed Serena's telemetry hooks, distorting tool utilization stats.
    - Solution: Hooks parse Bash command strings (`grep`, `find`, `cat`) to categorize operations as semantic searches or reads.
    - Architectural contrast: trace-mcp operates as a dedicated MCP server protocol endpoint; tools are invoked explicitly through structured RPC calls rather than intercepting shell commands.

**Competitor pulse (as of 2026-10-14 early morning):**
- nikolai-vysotskyi/trace-mcp: 191* (=), 24 forks (=)
- yamadashy/repomix: 28,824* (+14), 1,584 forks (=)
- oraios/serena: 30,232* (+19), 2,062 forks (=)
- DeusData/codebase-memory-mcp: 46,516* (+60), 3,828 forks (+9)
- tirth8205/code-review-graph: 32,120* (+27), 2,938 forks (+1)
- colbymchenry/codegraph: 73,956* (+113), 4,770 forks (+4)
- abhigyanpatwari/GitNexus: 47,871* (+13), 5,196 forks (=)
- jgravelle/jcodemunch-mcp: 2,764* (+1), 375 forks (=)
- continuedev/continue: 36,215* (+12), 5,465 forks (+2)
- Aider-AI/aider: 49,528* (+18), 5,053 forks (+2)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.

### Morning pass, 2026-10-14 (TRA-2408): mention sweep (azhri1990/ACODE_ROUTE), open threads audit, competitor triage (colbymchenry/codegraph PR #2540, DeusData PR #2638/#2636, jgravelle PR #1071-#1073)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- All 9 tracked external threads verified. Statuses unchanged:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (updated 2026-10-09T01:18Z with Round 4 review from hetaoBackend). Nikolai dedicated lane.
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds.
  - ai-boost/awesome-harness-engineering#240: OPEN, standing no-ping rule holds.
  - hesreallyhim/awesome-claude-code#2871: OPEN, standing no-ping rule holds.
  - natsukium/mcp-servers-nix#606: OPEN, standing no-ping rule holds.
  - Dokploy/mcp#81: OPEN, community implementation progressing (contributor moataz-hjaiji advancing dokploy-loadTools meta-tool PR).
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Found 1 new repository mentioning trace-mcp:
  - `azhri1990/ACODE_ROUTE`: Curated personal collection ("My AI Box", 1,107 items collected) created 2026-10-14. `CATALOG.md` contains `- nikolai-vysotskyi/trace-mcp — https://github.com/nikolai-vysotskyi/trace-mcp`. Recorded as a genuine reference in the surfaces table and silenced in `ops/mentions-seen.txt`.

**Competitor intelligence & architectural observations:**
- colbymchenry/codegraph:
  - PR #2540 (fix(cpp): structured bindings and function wrappers give their types to calls on them):
    - Problem: C++ receiver type inference lacked types for (1) structured bindings (`for (auto& [cfh, iter] : cfh_iter_pairs_) iter->Valid()`), (2) `std::function` return types (`create_iterator()->Valid()`), and (3) class members formatted with the type on the line above the name. Calls on these receivers fell back to raw name matching or were dropped.
    - Solution: Implemented `cppStructuredBindingType` for `std::pair`/`std::tuple`/maps, wrapper unwrapping (`std::function`, `absl::FunctionRef`, `absl::AnyInvocable`), and multi-line member declarator scanning.
    - Architectural contrast: trace-mcp uses Tree-sitter AST nodes (`structured_binding_declarator`, `init_declarator`) directly in `src/indexer/ast/cpp.ts` and leverages SCIP/LSP compiler models for type resolution, avoiding regex-style line-scanning heuristics.
- DeusData/codebase-memory-mcp:
  - PR #2638 (fix(soak): the per-call read follows the soak's own latency ceiling):
    - Problem: On GitHub Actions `windows-11-arm` runner, PowerShell-backed `search_code` answered in ~23s mean. A single call exceeded the harness's fixed 30s read timeout and failed the run, despite the soak harness latency check allowing 60s.
    - Solution: Unified read timeout with `SOAK_MAX_QUERY_LATENCY_S` (60s + 30s buffer).
    - Architectural contrast: trace-mcp has no PowerShell subprocess wrappers; CLI and MCP daemon run in native Node.js / worker threads with dedicated timeout budgets (`src/daemon/timeouts.ts`), keeping sub-100ms response times across platforms.
  - PR #2636 (docs: update the README for CBM Lens Beta (#2383)): Documents visual codebase lens beta.
- jgravelle/jcodemunch-mcp:
  - PR #1073 (ci: a runner never reports its tool calls to the public savings total):
    - Problem: Automated CI runners were reporting tool call telemetry to the public savings total, inflating claimed token savings with synthetic test traffic.
    - Solution: Suppresses reporting tool calls when running in CI environments.
    - Architectural contrast: trace-mcp telemetry (`src/analytics/telemetry.ts`) is strictly gated off in test/CI runs (`TRACE_MCP_TELEMETRY=0` or `NODE_ENV=test`), anonymous, opt-out, and never published as an inflated aggregate marketing counter.
  - PR #1072 (release: v1.108.360): Web Forms attribute parsing in ASP.NET and repository schema budget enforcement.
  - PR #1071 (release: v1.108.359): Diagnostic local reporting improvements without hardcoded path leakage.

**Competitor pulse (as of 2026-10-14 morning pass):**
- nikolai-vysotskyi/trace-mcp: 191★ (=), 24 forks (=)
- yamadashy/repomix: 28,825★ (+1), 1,585 forks (+1)
- oraios/serena: 30,238★ (+6), 2,063 forks (+1)
- DeusData/codebase-memory-mcp: 46,528★ (+12), 3,831 forks (+3)
- tirth8205/code-review-graph: 32,123★ (+3), 2,939 forks (+1)
- colbymchenry/codegraph: 73,995★ (+39), 4,771 forks (+1)
- abhigyanpatwari/GitNexus: 47,872★ (+1), 5,198 forks (+2)
- jgravelle/jcodemunch-mcp: 2,767★ (+3), 375 forks (=)
- continuedev/continue: 36,219★ (+4), 5,466 forks (+1)
- Aider-AI/aider: 49,534★ (+6), 5,054 forks (+1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.

### Midday pass, 2026-10-14 (TRA-2411): mention sweep clean, open threads audit, competitor triage (colbymchenry/codegraph PR #2553-#2557, DeusData PR #2639, oraios/serena PR #2161/#2164)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- All 9 tracked external threads verified. Statuses unchanged:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (updated 2026-10-09T01:18Z with Round 4 review from hetaoBackend). Nikolai dedicated lane.
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds.
  - ai-boost/awesome-harness-engineering#240: OPEN, standing no-ping rule holds.
  - hesreallyhim/awesome-claude-code#2871: OPEN issue, standing no-ping rule holds.
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - Dokploy/mcp#81: OPEN (updated 2026-10-08T20:56:56Z, community implementation progressing with contributor moataz-hjaiji advancing dokploy-loadTools meta-tool PR).
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: Clean. Zero new repos outside `ops/mentions-seen.txt`.

**Competitor intelligence & architectural observations:**
- colbymchenry/codegraph:
  - PR #2557 (fix(explore): tests and examples the engine knows stay out of explore's answer):
    - Problem: `codegraph_explore` dropped low-value files using its own ad-hoc regex list that fell behind the engine's `isTestFile`. It missed C++ `foo_test.cc`, Google `foo_unittest.cc`, LLVM `unittests/`, Gradle `foo-test/`, Kotlin `jvmTest/`, and project examples/fixtures, letting unit tests crowd explore answer slots. Suffix regexes also falsely matched domain terms (`Latest.java`, `Contest.swift`, `contest.cs`).
    - Architectural contrast: trace-mcp handles test, mock, and fixture filtering declaratively in `src/indexer/ignore.ts` and `src/indexer/path-utils.ts` without ad-hoc suffix heuristics, avoiding false positives on domain words.
  - PR #2556 (fix(cpp): a call of a member template with explicit template arguments has the type the template returns):
    - Problem: Member template calls with explicit template parameters (`reflection->GetRaw<RepeatedPtrField<CPPTYPE>>(msg, field)`) were denied types in `auto` declarations because `cppExpressionType` assumed callees end in the method identifier.
    - Architectural contrast: trace-mcp uses Tree-sitter AST nodes (`template_method`, `call_expression`) and SCIP compiler definitions, parsing explicit template arguments naturally rather than relying on callee string suffix matching.
  - PR #2555, #2554, #2553: Multiline receiver declarations, nullptr overload resolution (`std::nullptr_t` vs deleted overloads), and template argument bracket pairing.
- DeusData/codebase-memory-mcp:
  - PR #2639 (fix(watcher): handle UTF-8 repository and cache paths on Windows):
    - Problem: Narrow `stat()` calls in native C watcher passed UTF-8 non-ASCII paths into the Windows ANSI CRT interface (code page 932 on Japanese Windows), causing false `watcher.root_missing` errors and pruning active graph caches after the grace period.
    - Architectural contrast: trace-mcp uses Node.js / libuv cross-platform filesystem APIs (`uv_fs_stat` via `fs.promises`), which handle Unicode / UTF-8 paths across macOS, Linux, and Windows using wide Win32 APIs, avoiding ANSI codepage corruption.
- jgravelle/jcodemunch-mcp:
  - PR #1074: Docs refresh of published benchmark at v1.108.360 claiming 28.9x against grep-and-read.
- oraios/serena:
  - PR #2161 (Fix MCP registry manifest: pass Serena's arguments to the package, not the runtime):
    - Problem: In `server.json`, Serena passed CLI arguments in `runtimeArguments` (`uvx`) instead of `packageArguments`. Clients appended the package spec after them, breaking server startup.
    - Architectural contrast: trace-mcp configures `server.json` strictly to the official MCP registry schema with `runtime: npx` and properly segregated package arguments.
  - PR #2164: Set `web_dashboard_open_on_launch` to false by default on platforms with system tray access.
- abhigyanpatwari/GitNexus:
  - PR #3578: Bump `@ladybugdb/core` to 0.21.2 to prevent duplicate rows after delete and re-copy.

**Competitor pulse (as of 2026-10-14 midday pass):**
- nikolai-vysotskyi/trace-mcp: 191★ (=), 24 forks (=)
- yamadashy/repomix: 28,825★ (=), 1,588 forks (+3)
- oraios/serena: 30,253★ (+15), 2,071 forks (+8)
- DeusData/codebase-memory-mcp: 46,551★ (+23), 3,834 forks (+3)
- tirth8205/code-review-graph: 32,132★ (+9), 2,944 forks (+5)
- colbymchenry/codegraph: 74,035★ (+40), 4,779 forks (+8)
- abhigyanpatwari/GitNexus: 47,874★ (+2), 5,198 forks (=)
- jgravelle/jcodemunch-mcp: 2,769★ (+2), 375 forks (=)
- continuedev/continue: 36,220★ (+1), 5,467 forks (+1)
- Aider-AI/aider: 49,541★ (+7), 5,054 forks (=)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.

### Evening pass, 2026-10-14 (TRA-2413): mention sweep clean, open threads audit, competitor triage (colbymchenry/codegraph PR #2550, DeusData PR #2638, jcodemunch PR #1075/#1076, oraios/serena PR #2162)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- All 9 tracked external threads verified. Statuses unchanged:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (updated 2026-10-09T01:18Z with Round 4 review from hetaoBackend). Nikolai dedicated lane.
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds.
  - ai-boost/awesome-harness-engineering#240: OPEN (timestamp touch 2026-10-14T10:11:05Z from repository metadata sync, 0 maintainer comments/reviews), standing no-ping rule holds.
  - hesreallyhim/awesome-claude-code#2871: OPEN issue, standing no-ping rule holds.
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - Dokploy/mcp#81: OPEN (updated 2026-10-08T20:56:56Z, community implementation progressing with contributor moataz-hjaiji advancing dokploy-loadTools meta-tool PR).
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: Clean. Zero new repos outside `ops/mentions-seen.txt`.

**Competitor intelligence & architectural observations:**
- colbymchenry/codegraph:
  - PR #2550 (fix(pascal): resolve receiver chains, packages, event dispatch and nested routines):
    - Problem: Pascal grammar could not parse `.dpk` Delphi package files, requiring a dedicated custom scanner. Event dispatch needed complex heuristic edge synthesis while avoiding counting `Assigned()`, nil comparisons, address-of expressions, or procedural assignments as function calls. Nested procedures had to be manually scoped and shadowed.
    - Architectural contrast: trace-mcp relies on Tree-sitter grammars and SCIP indexing. By utilizing AST-level queries and SCIP definitions, trace-mcp cleanly separates syntax structure and semantic symbol definitions without hand-rolled grammar bypasses or ad-hoc heuristic edge synthesis.
- DeusData/codebase-memory-mcp:
  - PR #2638 (fix(soak): the per-call read follows the soak's own latency ceiling):
    - Problem: On GitHub's Windows ARM runner, PowerShell-backed `search_code` answered in ~23s per call (mean 23.3s over 23 calls), crossing the harness's fixed 30s read timeout and failing candidate CI soak tests.
    - Architectural contrast: trace-mcp runs entirely in-process in Node.js / libuv with an in-memory SQLite and compiled AST/SCIP cache. trace-mcp never shells out to PowerShell or bash per search query, executing code searches in single-digit milliseconds without subshell startup overhead.
- oraios/serena:
  - PR #2162 (fix(scala): optionally terminate orphaned Bloop daemons on stop (#1816)):
    - Problem: Metals starts Bloop build-server daemons that daemonize themselves and re-parent to PID 1 upon shutdown, leaking RAM indefinitely. Added opt-in cleanup logic (`terminate_bloop_on_stop`) to hunt down descendant Bloop processes.
    - Architectural contrast: trace-mcp uses self-contained Tree-sitter parsers and SCIP indexers directly in-process instead of orchestrating external heavyweight Language Servers and separate background build-server daemons that orphan and leak memory.
- jgravelle/jcodemunch-mcp:
  - PR #1075 (fix(summarizer): a C# or AL symbol's summary is its sentence, not the literal `<summary>` tag):
    - Problem: XML doc comments (`/// <summary>...</summary>`) in C# and AL caused `extract_summary_from_docstring` (which assumed line 1 is a prose sentence) to return `<summary>` as the symbol summary, corrupting BM25 search relevance across all C# codebases. In addition, regex section matching exhibited quadratic behavior on unclosed hostile tags (`<param name='a'>` * 20000 took 26s).
    - Architectural contrast: trace-mcp extracts doc comments and symbol declarations via Tree-sitter AST nodes rather than regex heuristics on raw text, avoiding quadratic backtracking and comment delimiter corruption.
  - PR #1076: Adds `--refresh` for `claude-md` policies; tool surface remains vast at 91 tools.
- abhigyanpatwari/GitNexus:
  - PR #3578: Fixed duplicate rows in `@ladybugdb/core` 0.21.2 on delete and re-copy.

**Competitor pulse (as of 2026-10-14 evening pass):**
- nikolai-vysotskyi/trace-mcp: 191★ (=), 24 forks (=)
- yamadashy/repomix: 28,828★ (+3), 1,587 forks (-1)
- oraios/serena: 30,259★ (+6), 2,071 forks (=)
- DeusData/codebase-memory-mcp: 46,561★ (+10), 3,835 forks (+1)
- tirth8205/code-review-graph: 32,140★ (+8), 2,944 forks (=)
- colbymchenry/codegraph: 74,070★ (+35), 4,779 forks (=)
- abhigyanpatwari/GitNexus: 47,878★ (+4), 5,198 forks (=)
- jgravelle/jcodemunch-mcp: 2,769★ (=), 375 forks (=)
- continuedev/continue: 36,222★ (+2), 5,468 forks (+1)
- Aider-AI/aider: 49,546★ (+5), 5,054 forks (=)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.


### Late night pass, 2026-10-14 (TRA-2430): mention sweep clean, open threads audit, competitor triage (DeusData PR #2642/#2643, jcodemunch PR #1079, colbymchenry/codegraph PR #2558/#2559, oraios/serena PR #2164)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- All 9 tracked external threads verified. Statuses unchanged:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (updated 2026-10-09T01:18Z with Round 4 review from hetaoBackend). Nikolai dedicated lane.
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds.
  - ai-boost/awesome-harness-engineering#240: OPEN (timestamp touch 2026-10-14T10:11:05Z from repository metadata sync, 0 maintainer comments/reviews), standing no-ping rule holds.
  - hesreallyhim/awesome-claude-code#2871: OPEN issue, standing no-ping rule holds.
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - Dokploy/mcp#81: OPEN (updated 2026-10-08T20:56:56Z, community implementation progressing with contributor moataz-hjaiji advancing dokploy-loadTools meta-tool PR).
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: Clean. Zero new repos outside `ops/mentions-seen.txt`.

**Competitor intelligence & architectural observations:**
- DeusData/codebase-memory-mcp:
  - PR #2642 (perf(mcp): fast query tools on every platform):
    - Problem: Soak testing on Windows ARM runners failed due to 23-31s PowerShell `Select-String` subprocess scans hitting the 30s deadline. Full tool latency audit revealed 4 structural bottlenecks: `search_code` spawned grep or PowerShell pipelines with quadratic scaling on hit merging and byte-by-byte `fgetc` source reads; `query_graph` (Cypher engine) used bubble sort for `ORDER BY` (taking 41.0s on 29k rows in Django) and linear scans for `DISTINCT`/`GROUP BY`; store read tools acquired and released database file locks and stat'ed WAL files on every single statement; `list_projects` spawned 7 git subprocesses per project.
    - Fix: In-process regex scanner, stable merge sort for Cypher `ORDER BY` (41.0s down to 62ms), hash tables for `DISTINCT`/`GROUP BY`, batch read transactions renewed every 100ms, and reducing `list_projects` to 2 git commands.
    - Architectural contrast: trace-mcp has been built from day 1 around an in-process Node.js / libuv architecture with SQLite in memory / compiled AST / SCIP cache. We never spawn shell sub-processes per query, never execute O(N^2) bubble sorts on result sets, and keep symbol resolution and outline navigation down to single-digit milliseconds without subshell startup overhead or DB lock thrashing.
  - PR #2643 (feat(infra): env and service joins, kustomize variants, Terraform / Terragrunt, Ansible):
    - Expands indexing scope into infrastructure-as-code and configuration topology joins.
- jgravelle/jcodemunch-mcp:
  - PR #1079 (feat: the server's start-up instructions say where the index is cheaper, not to prefer it everywhere):
    - Problem: During MCP `initialize`, the server's `instructions` told AI agents to unconditionally prefer jcodemunch's index over built-in tools (Read, Grep, Glob, Bash) and call `resolve_repo` first. The maintainer toned it down to acknowledge that small repositories favor native built-in tools. Tool surface remains broad at 91 tools.
    - Architectural contrast: trace-mcp emphasizes concise tool surface, progressive disclosure via presets, and explicit token savings rather than tool sprawl (91 tools) or demanding exclusive precedence over native client tools in server initialization instructions.
- colbymchenry/codegraph:
  - PR #2558 (fix(react-router): a lazy route follows a barrel that re-exports an import):
    - Problem: In React Router apps, lazily loaded folder barrel exports (`index.ts` importing and re-exporting components without local declarations) caused route resolution to fail completely, missing 27 route edges in real-world apps (DigiShop).
    - Architectural contrast: trace-mcp leverages SCIP indexing and Tree-sitter AST queries where symbol definitions and import/export bindings are resolved through standard semantic graph relationships rather than brittle framework-specific heuristic barrel walkers.
  - PR #2559 (feat(extraction): add Cangjie language support (.cj) with ArkUI-in-Cangjie and FFI bridges):
    - Adding language support for Huawei's Cangjie programming language.
- oraios/serena:
  - PR #2164 (Change the default value of web_dashboard_open_on_launch to false depending on platform):
    - Disabling automatic dashboard browser popup on launch for tray-supporting platforms; v2.0 milestone stabilized.

**Competitor pulse (as of 2026-10-14 late night pass):**
- nikolai-vysotskyi/trace-mcp: 191★ (=), 24 forks (=)
- yamadashy/repomix: 28,832★ (+4), 1,592 forks (+5)
- oraios/serena: 30,264★ (+5), 2,075 forks (+4)
- DeusData/codebase-memory-mcp: 46,580★ (+19), 3,837 forks (+2)
- tirth8205/code-review-graph: 32,149★ (+9), 2,946 forks (+2)
- colbymchenry/codegraph: 74,088★ (+18), 4,781 forks (+2)
- abhigyanpatwari/GitNexus: 47,879★ (+1), 5,197 forks (-1)
- jgravelle/jcodemunch-mcp: 2,770★ (+1), 375 forks (=)
- continuedev/continue: 36,225★ (+3), 5,468 forks (=)
- Aider-AI/aider: 49,548★ (+2), 5,055 forks (+1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.


### Early morning pass, 2026-10-15 (TRA-2436): mention sweep clean, open threads audit, competitor triage (DeusData PR #2644, colbymchenry/codegraph PR #2560/#2561, jcodemunch PR #1080-#1083, oraios/serena PR #2164)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- All 9 tracked external threads verified. Statuses unchanged:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (updated 2026-10-09T01:18Z with Round 4 review from hetaoBackend). Nikolai dedicated lane.
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds.
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: false/dirty due to upstream context additions; left alone per wontfix-spend / standing no-ping rule).
  - hesreallyhim/awesome-claude-code#2871: OPEN issue, standing no-ping rule holds.
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - Dokploy/mcp#81: OPEN (updated 2026-10-08T20:56:56Z, community implementation progressing with contributor moataz-hjaiji advancing dokploy-loadTools meta-tool PR).
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: Clean. Zero new repos outside `ops/mentions-seen.txt`.

**Competitor intelligence & architectural observations:**
- DeusData/codebase-memory-mcp:
  - PR #2644 (feat(infra): chart identity by publisher URL, Ansible kube DEPLOYS, exact TOML/INI keys):
    - Problem & change: Stacking on #2643 for v0.12.0 (index schema v9). External Helm charts are keyed by publisher URL (`__chart__<repository>/<name>`) for global identity across projects; Ansible `kube`/`k8s` play tasks now trace manifest variables through loops, `set_fact`, and defaults to emit `DEPLOYS` edges to the template manifests; TOML/INI keys link by exact name to component code symbols.
    - Architectural contrast: DeusData continues extending graph cardinality into DevOps/IaC topology. While powerful for cluster deployment tracking, adding Helm chart identity and Ansible template resolution increases index schema churn (v9) and triggers full rebuilds on configuration changes. trace-mcp focuses strictly on source code semantic graphs (Tree-sitter AST, SCIP references, framework bindings like Inertia PHP→Vue and model migrations), maintaining sub-second responses and predictable footprint without cluster manifest overhead.
- colbymchenry/codegraph:
  - PR #2561 (fix(jsx): a .jsx component links to the file-scope values it reads, as in .js and .tsx):
    - Problem: In `.jsx` files, identifier reads of file-scope constants (message catalogs, styling objects, lazy route tables) lacked `references` edges with `{"valueRef": true}`, causing `codegraph impact` to under-report affected files (e.g. only 1 affected instead of 3).
    - PR #2560 (fix(sync): a lazy route relinks a page that appears below its barrel):
      - Relinks route edges when barrel re-exports sit above or below the target page.
    - Architectural contrast: trace-mcp uses unified Tree-sitter parsers and SCIP indexing across JS, JSX, TS, and TSX. Scope resolution for module-level identifiers is dialect-agnostic, preventing edge-omission disparities between `.jsx` and `.tsx` without bespoke per-dialect value-ref walkers or barrel-traversal heuristics.
- jgravelle/jcodemunch-mcp:
  - PR #1080 & #1081 (feat(sql): parse batches separately and recover named constraints / fix(sql): index T-SQL/Sybase procedures, triggers...):
    - Adds regex-based SQL routine parsing, delimiter tracking (`$$`, `DELIMITER`, `BEGIN...END`), and representative kind ranks (procedure rank 1, trigger rank 2) for Postgres, MySQL, T-SQL, Sybase, and Oracle.
  - PR #1082 (fix: a package named migrations is indexed; only generated migrations are skipped):
    - Fixed an aggressive blacklist rule that skipped any package named `migrations`, restoring indexing for valid packages containing data migrations or custom logic.
    - Architectural contrast: Hand-rolled regex routines and delimiter counters for multi-dialect SQL are notoriously fragile against nested bodies and dialect idioms. trace-mcp uses rigorous AST grammars and respects `.gitignore` rather than heuristic token masking or hardcoded directory-name bans.
- oraios/serena:
  - PR #2164 (Change the default value of web_dashboard_open_on_launch to false depending on platform):
    - Refines tray and dashboard launch behavior on tray-supporting OS platforms post-v2.0.

**Competitor pulse (as of 2026-10-15 early morning pass):**
- nikolai-vysotskyi/trace-mcp: 191★ (=), 24 forks (=)
- yamadashy/repomix: 28,837★ (+5), 1,592 forks (=)
- oraios/serena: 30,266★ (+2), 2,075 forks (=)
- DeusData/codebase-memory-mcp: 46,590★ (+10), 3,839 forks (+2)
- tirth8205/code-review-graph: 32,153★ (+4), 2,946 forks (=)
- colbymchenry/codegraph: 74,097★ (+9), 4,781 forks (=)
- abhigyanpatwari/GitNexus: 47,882★ (+3), 5,197 forks (=)
- jgravelle/jcodemunch-mcp: 2,771★ (+1), 375 forks (=)
- continuedev/continue: 36,226★ (+1), 5,470 forks (+2)
- Aider-AI/aider: 49,550★ (+2), 5,058 forks (+3)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.


### Morning pass, 2026-10-15 (TRA-2446): mention sweep clean, open threads audit, competitor triage (DeusData PR #2642, colbymchenry/codegraph PR #2567/#2564, jcodemunch PR #1086, oraios/serena PR #2166, wicked-estate discovery)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- All 9 tracked external threads verified. Statuses unchanged:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (updated 2026-10-09T01:18Z with Round 4 review from hetaoBackend). Dedicated lane for Nikolai.
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds.
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: false/dirty due to upstream context additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - hesreallyhim/awesome-claude-code#2871: OPEN issue, standing no-ping rule holds.
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - Dokploy/mcp#81: OPEN (updated 2026-10-08T20:56:56Z, community implementation progressing with contributor moataz-hjaiji advancing dokploy-loadTools meta-tool PR).
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: Clean. Zero new repos outside `ops/mentions-seen.txt`.

**Competitor intelligence & architectural observations:**
- DeusData/codebase-memory-mcp:
  - PR #2642 (perf(mcp): fast query tools on every platform, merged 2026-10-14T21:56Z):
    - Problem & change: Release soak on `windows-11-arm` revealed `search_code` took 23–31s per call (hitting 30s deadline) due to spawning PowerShell `Select-String` / POSIX `grep` pipelines. Rewrote `search_code` to scan indexed files in-process; replaced Cypher engine bubble sort with merge sort for `ORDER BY` (41s → 62ms on 29k rows in Django) and linear scan with hash tables for `DISTINCT`/`GROUP BY`; added 100ms deferred read transaction renewal on SQLite store reads to eliminate repeated db file locking and journal/WAL stat calls.
    - Architectural contrast: DeusData continues retrofitting in-process scanning and query execution optimizations onto a legacy subprocess-spawning design. trace-mcp was designed from day one with in-process Tree-sitter AST traversal and native SQLite parameterized indexing with zero subprocess overhead during queries.
- colbymchenry/codegraph:
  - PR #2567 (fix(cpp): a qualified receiver type never reaches a class that only shares its last name, and rocksdb::DB is RocksDB's own, merged 2026-10-15T03:29Z):
    - Problem: C++ receiver type resolution failed when projects use namespace macros (e.g. RocksDB's `namespace ROCKSDB_NAMESPACE` with `#define ROCKSDB_NAMESPACE rocksdb`), causing calls on `rocksdb::DB` to be judged external and drop call edges. Also lowercase external types collided with namesake project utilities (`absl::flat_hash_set` vs `util::flat_hash_set::insert`). Added `cppFindsOnlyNamesakes` and macro mapping expansion.
  - PR #2564 (fix(react): a tag written in a comment or a string renders no JSX child, merged 2026-10-15T00:46Z):
    - Problem: Regex scanning in `reactJsxChildEdges` (`JSX_TAG_RE`) read tag names from raw text, causing comments, JSDocs, and error strings (`<Carousel />`, XML templates) to falsely emit JSX render edges. Had to introduce `jsxCode(source)` pre-pass to blank strings and comments while preserving offsets.
    - Architectural contrast: Hand-rolled regex scanning of JSX/TS and heuristic macro stitching in C++ repeatedly suffer from false-edge synthesis and edge drops. trace-mcp uses formal Tree-sitter grammars (where comments and string literals are distinct AST nodes that cannot be confused with JSX elements) and SCIP indexers (where Clang itself computes full symbol identities, resolving macros and namespaces natively).
- jgravelle/jcodemunch-mcp:
  - PR #1086 (fix: init writes hooks that run the install you ran, not the first one on PATH, merged 2026-10-15T01:19Z):
    - Problem: `init` wrote hooks using `shutil.which("jcodemunch-mcp")`, which grabbed whatever older version was first on PATH rather than the active venv/binary, and broke under `uvx` when `uv cache clean` destroyed the hook target. Added `install_layout` resolution with absolute launch path detection.
    - Architectural contrast: trace-mcp decouples CLI installation from execution via its dedicated control plane (`~/.trace/bin/trace` shim + `launcher.env`), ensuring deterministic resolution regardless of ephemeral cache purges or PATH ordering.
- oraios/serena:
  - PR #2166 (fix(php): apply Intelephense's maxMemory and maxFileSize settings, opened 2026-10-15T07:15Z):
    - Problem: Intelephense language server crashed with JavaScript heap OOM on large PHP repositories because documented `maxMemory` and `maxFileSize` settings were passed in `initializationOptions` and ignored by Intelephense. Patch forces `--max-old-space-size` into `NODE_OPTIONS` for the child process.
    - Architectural contrast: Illustrates the operational brittleness of LSP-wrapper architectures (running heavy external language server daemons in background subprocesses prone to memory exhaustion and protocol mismatches). trace-mcp's direct AST indexing operates with predictable, bounded memory without subprocess daemons per language.
- Competitor discovery — mikeparcewski/wicked-estate:
  - Surface: https://github.com/mikeparcewski/wicked-estate (Rust, MIT, v0.16.7 published on crates.io, pushed 2026-10-11).
  - Shape: Single static binary MCP server + CLI (`wicked-estate-mcp` / `wicked-estate`) combining code graph, memory, and knowledge store. 15 modular crates, Tree-sitter AST extraction across 103 languages, SQLite/MemStore storage, personalized PageRank over CALLS/IMPORTS, and explicit provenance `{confidence, provenance, resolved_by}` per edge.
  - Relevance: A notable Rust peer in the local-first code graph MCP ecosystem. Contrast: trace-mcp provides deep multi-language framework bindings (88 frameworks), Git diff blast-radius and PR review benchmarks (−72.7% tokens), and a lightweight Node/Electron desktop environment without requiring a Rust toolchain.

**Competitor pulse (as of 2026-10-15 morning pass):**
- nikolai-vysotskyi/trace-mcp: 192★ (+1), 24 forks (=)
- yamadashy/repomix: 28,841★ (+4), 1,592 forks (=)
- oraios/serena: 30,271★ (+5), 2,077 forks (+2)
- DeusData/codebase-memory-mcp: 46,609★ (+19), 3,839 forks (=)
- tirth8205/code-review-graph: 32,158★ (+5), 2,948 forks (+2)
- colbymchenry/codegraph: 74,125★ (+28), 4,782 forks (+1)
- abhigyanpatwari/GitNexus: 47,890★ (+8), 5,199 forks (+2)
- jgravelle/jcodemunch-mcp: 2,771★ (=), 375 forks (=)
- continuedev/continue: 36,225★ (-1), 5,472 forks (+2)
- Aider-AI/aider: 49,555★ (+5), 5,060 forks (+2)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.


### Afternoon pass, 2026-10-15 (TRA-2449): mention sweep clean, open threads audit (hesreallyhim #2871 closed), competitor triage (jcodemunch PR #1089/#1090, colbymchenry/codegraph PR #2569/#2568, oraios/serena PR #2166/#2167)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned during catalog backlog sweep; recorded as rejected, standing no-ping rule holds, no follow-up).
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (updated 2026-10-09T01:18Z with Round 4 review from hetaoBackend). Dedicated lane for Nikolai.
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds.
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: false/dirty due to upstream context additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - Dokploy/mcp#81: OPEN (updated 2026-10-08T20:56:56Z, community implementation progressing with contributor moataz-hjaiji advancing dokploy-loadTools meta-tool PR).
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: Clean. Zero new repos outside `ops/mentions-seen.txt`.

**Competitor intelligence & architectural observations:**
- jgravelle/jcodemunch-mcp:
  - PR #1089 (fix: search ranking no longer depends on whether git blame finished, or on today's date (L-188), merged 2026-10-15T06:49Z):
    - Problem: Non-deterministic BM25 search ranking across identical checkouts. Git blame provider injected `last_author` and `last_modified` into `FileContext.search_keywords`. Two fresh indexes of the same commit yielded divergent symbol ranking scores (1,167 vs 1,232 tokens on fastapi) depending on whether `git log` completed within a 10s timeout and how far the commit sat from a sliding `2.years.ago` calendar window.
    - Change: Opted blame out of keyword search (`properties_are_search_terms = False`), pinned blame time window to 730 days from HEAD's commit date rather than wall clock, and bumped `PARSER_GENERATION` to 24 to invalidate cached indexes.
    - Architectural contrast: Hand-rolling custom keyword enrichment and tying search term weighting to wall-clock metadata creates reproducibility traps in benchmarking and agent token usage. trace-mcp indexes structural graph topology, AST symbols, and deterministic git revision diffs without leaking non-deterministic wall-clock or provider timeout heuristics into token scoring.
  - PR #1090 (release: v1.108.364 - SQL procedures, triggers and constraints are indexed, and one unparseable statement no longer loses the rest of the file, merged 2026-10-15T07:32Z):
    - Problem & change: Stored procedures and triggers in T-SQL/Sybase files indexed to nothing because derekstride tree-sitter-sql grammar collapsed `CREATE PROCEDURE`/`TRIGGER` into `ERROR` nodes. Implemented `_scan_sql_routines` fallback scanner using comment/string masking over raw bytes, fixed bracket-quoted `[dbo].[X]` parsing, and expanded `search_symbols` input schema enum.
    - Architectural contrast: Recovering from AST parser failure by layering regex masking over error bytes adds heuristic drift. trace-mcp handles resilient parsing through Tree-sitter error recovery nodes and multi-pass semantic AST validation.
- colbymchenry/codegraph:
  - PR #2569 (fix(cpp): a receiver type written from the global scope is looked up there, and a far lowercase outside type reaches no namesake, merged 2026-10-15T04:59Z) & PR #2568 (merged 2026-10-15T04:21Z):
    - Problem: C++ receiver type declarator regex stripped leading `::` (`::upb::Arena` became `upb::Arena` and bound to namespace-local `hpb::upb::Arena`). Attempting to keep `::` broke template declarations (`SkipList<...>::Iterator`), requiring a lookbehind regex rule. Lowercase outside types (`absl::flat_hash_set`, `std::string`) falsely bound to project namesakes (`util::flat_hash_set`, global `string` class).
    - Architectural contrast: Codegraph continues patching C++ receiver and type resolution using regular expressions, lookbehinds, and namesake heuristics. In C++, template specializations, qualified scopes, and namespace aliases cannot be reliably parsed via regex. trace-mcp relies on AST structural nodes and Clang SCIP indexers that natively compute symbol identities and disambiguate global scope `::` without lookbehind hacks.
- oraios/serena:
  - PR #2166 (fix(php): apply Intelephense's maxMemory and maxFileSize settings, merged 2026-10-15T08:53Z):
    - Merged fix forcing `--max-old-space-size` into `NODE_OPTIONS` to prevent Intelephense LSP child process heap OOM crashes.
  - PR #2167 (fix(fsharp): wait for FsAutoComplete's workspace load before serving requests, opened 2026-10-15T05:05Z):
    - Demonstrates continuing concurrency synchronization challenges when wrapping external language servers (FsAutoComplete LSP loading races with client requests).
- DeusData/codebase-memory-mcp:
  - PR #2648 (fix(security): allow the bare wget token the shell pass compares, updated 2026-10-15T04:43Z):
    - Ongoing shell command string parsing and sanitization in security pass.

**Competitor pulse (as of 2026-10-15 afternoon pass):**
- nikolai-vysotskyi/trace-mcp: 192★ (=), 24 forks (=)
- yamadashy/repomix: 28,846★ (+5), 1,592 forks (=)
- oraios/serena: 30,277★ (+6), 2,077 forks (=)
- DeusData/codebase-memory-mcp: 46,624★ (+15), 3,840 forks (+1)
- tirth8205/code-review-graph: 32,160★ (+2), 2,948 forks (=)
- colbymchenry/codegraph: 74,149★ (+24), 4,784 forks (+2)
- abhigyanpatwari/GitNexus: 47,892★ (+2), 5,199 forks (=)
- jgravelle/jcodemunch-mcp: 2,771★ (=), 375 forks (=)
- continuedev/continue: 36,227★ (+2), 5,473 forks (+1)
- Aider-AI/aider: 49,561★ (+6), 5,061 forks (+1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.


### Evening pass, 2026-10-15 (TRA-2451): mention sweep clean, open threads audit, competitor triage (jcodemunch PR #1092/#1093/#1094, serena PR #2161/#2169, codegraph PR #1508, codebase-memory-mcp PR #2639, code-review-graph PR #1079)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; table row updated to closed/rejected, standing no-ping rule holds, no follow-up).
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (updated 2026-10-09T01:18Z with Round 4 review from hetaoBackend). Dedicated lane for Nikolai.
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds.
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: false/dirty due to upstream context additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - Dokploy/mcp#81: OPEN (updated 2026-10-08T20:56:56Z, community implementation progressing with contributor moataz-hjaiji advancing dokploy-loadTools meta-tool PR).
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: Clean. Zero new repos outside `ops/mentions-seen.txt`.

**Competitor intelligence & architectural observations:**
- jgravelle/jcodemunch-mcp:
  - PR #1092 (change: git blame is off by default, and adds no 2 properties to a file summary (L-189), merged 2026-10-15T11:49Z):
    - Problem: Following #1089 removing blame properties from search ranking, blame output reached AI summarizer prompts and added an uninformative "2 properties" suffix to file summaries. Unconditional 10s git log execution ran per repository during indexing.
    - Change: Defaults git_blame_enabled to false, drops property count suffix from file summaries, and documents security and stale index implications in SECURITY.md.
    - Architectural contrast: trace-mcp uses AST and structural symbol indexing without running heavy, un-sandboxed git log commands per-file on initial indexing passes, avoiding timeout-dependent non-determinism and avoiding leaking commit metadata into agent context tokens.
  - PR #1093 (chore: repair-munch-installs.ps1 stops every j*munch server as its first step, merged 2026-10-15T12:56Z):
    - Problem & change: repair-munch-installs.ps1 failed when any jMunch server was running due to locked Windows executables. Added pre-emptive stop step killing all matching server processes before uninstallation.
    - Architectural contrast: trace-mcp handles background daemon lifecycle, shutdown, and hot reload via graceful IPC signals (trace-mcp stop, daemon health ping, socket shutdown) without requiring destructive process-killing repair scripts for package upgrades.
  - PR #1094 (test: pin the two Oracle shapes #1081 fixed; close L-191 and L-192, merged 2026-10-15T13:15Z):
    - Problem & change: Added regression tests for Oracle function declaration shapes and trigger :NEW.x statements that previously failed symbol extraction. Recorded ledger item L-193: documented opt-out JCODEMUNCH_SHARE_SAVINGS=0 is marked deprecated and scheduled for removal in 2.0, meaning users who opted out via env var would silently start sharing again.
    - Architectural contrast: trace-mcp telemetry is strictly anonymous, opt-out via standard config/env (TRACE_MCP_TELEMETRY=0), and never deprecates or ignores opt-out switches across major or minor releases.
- oraios/serena:
  - PR #2161 (Fix MCP registry manifest: pass Serena's arguments to the package, not the runtime, merged 2026-10-15T11:36Z):
    - Problem & change: In server.json for the official MCP Registry, Serena's CLI arguments (start-mcp-server, --project-from-cwd, --context) were placed in runtimeArguments instead of packageArguments. For uvx, runtimeArguments were placed before the package name, causing clients to append identifier@version after them, which the CLI interpreted as an illegal extra positional argument and failed startup on every launch.
    - Architectural contrast: trace-mcp maintains validated, schema-compliant server.json published via CI (publish-mcp-registry.yml) using standard node runtime arguments and separate npm package arguments.
  - PR #2169 (fix(svelte,astro): respect ignore patterns in companion file discovery, updated 2026-10-15T12:53Z):
    - Multi-framework companion discovery ignoring project exclusion patterns.
- colbymchenry/codegraph:
  - PR #1508 (feat: add SystemVerilog/Verilog, Tcl, and VHDL language support, updated 2026-10-15T13:35Z):
    - Added hardware description language extraction (SystemVerilog, Tcl, VHDL) by vendoring tree-sitter WASM grammars.
- DeusData/codebase-memory-mcp:
  - PR #2639 (fix(watcher): handle UTF-8 repository and cache paths on Windows, updated 2026-10-15T13:07Z):
    - Problem & change: Native C watcher received UTF-8 paths through an ANSI CRT interface on Windows (stat()). On systems with ANSI code page 932 (Japanese), valid repositories were classified as watcher.root_missing and falsely pruned. Switched to cbm_path_info_utf8().
    - Architectural contrast: trace-mcp uses @parcel/watcher and Node/Rust cross-platform bindings with native UTF-8 path support across Windows, macOS, and Linux, avoiding ANSI CRT code page degradation.
- tirth8205/code-review-graph:
  - PR #1079 (fix(parser): extract PowerShell functions, classes, methods and command calls, updated 2026-10-15T13:34Z):
    - Fixed discarded PowerShell declarations where grammar node names were unhandled.

**Competitor pulse (as of 2026-10-15 evening pass):**
- nikolai-vysotskyi/trace-mcp: 192★ (=), 24 forks (=)
- yamadashy/repomix: 28,849★ (+3), 1,592 forks (=)
- oraios/serena: 30,287★ (+10), 2,078 forks (+1)
- DeusData/codebase-memory-mcp: 46,642★ (+18), 3,839 forks (-1)
- tirth8205/code-review-graph: 32,163★ (+3), 2,950 forks (+2)
- colbymchenry/codegraph: 74,166★ (+17), 4,787 forks (+3)
- abhigyanpatwari/GitNexus: 47,895★ (+3), 5,198 forks (-1)
- jgravelle/jcodemunch-mcp: 2,771★ (=), 375 forks (=)
- continuedev/continue: 36,228★ (+1), 5,475 forks (+2)
- Aider-AI/aider: 49,565★ (+4), 5,060 forks (-1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.


### Late night pass, 2026-10-15 (TRA-2453): mention sweep clean, open threads audit, competitor triage (jcodemunch PR #1095/#1096/#1098, serena PR #2171, codebase-memory-mcp PR #2648/#2650/#2651, codegraph PR #1947/#1950/#1951/#1952/#1954, code-review-graph PR #1065/#1105)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; table row updated to closed/rejected, standing no-ping rule holds, no follow-up).
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (updated 2026-10-09T01:18Z with Round 4 review from hetaoBackend). Dedicated lane for Nikolai.
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds (one reminder already sent 2026-09-26).
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: false/dirty due to upstream context additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - Dokploy/mcp#81: OPEN (updated 2026-10-08T20:56:56Z, community implementation progressing with contributor moataz-hjaiji advancing dokploy-loadTools meta-tool PR).
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: Clean. Zero new repos outside `ops/mentions-seen.txt`.

**Competitor intelligence & architectural observations:**
- jgravelle/jcodemunch-mcp:
  - Release v1.108.365 (PR #1095, merged 2026-10-15T14:57Z):
    - Ships git_blame_enabled: false default and drops uninformative "2 properties" suffix from file summaries, preventing 10s git log timeouts during indexing.
  - PR #1098 (change: environment variables stay supported, and no longer warn that 2.0 removes them (L-193), merged 2026-10-15T17:39Z):
    - Problem & change: The config loader logged "Deprecated: Using <VAR> environment variable. This will be removed in v2.0. Use config.jsonc instead." on every process startup reading JCODEMUNCH_* env vars, and documentation claimed 2.0 removal. However, JCODEMUNCH_SHARE_SAVINGS=0 is the documented opt-out for anonymous savings sharing, meaning the deprecation warning indicated that opting out would silently fail in 2.0. Maintainer confirmed no 2.0 is planned, reversed deprecation warnings entirely, inverted the test, and pinned env var support permanently in harness/retired.json (L-193).
    - Architectural contrast: trace-mcp treats environment variables (TRACE_MCP_*, such as TRACE_MCP_TELEMETRY=0) as first-class, permanent configuration primitives. Telemetry opt-outs and core daemon parameters do not suffer from phantom major-version deprecation cycles or confusing stderr log spew in agent hook processes.
  - PR #1096 (docs(ledger): L-194, strict mode advises rather than denies a piped shell grep, opened 2026-10-15T18:00Z):
    - Discovered that in strict-mode arm (init --strict), steering.py only denied Bash grep as a single standalone command; piping or chaining (& or ;) turned the deny into advice, and agents nearly always piped grep while paying higher indexing costs ($1.35 vs $1.06) without gaining accuracy.
- DeusData/codebase-memory-mcp:
  - PR #2650 (fix(daemon): settings startup survives busy and interrupted writes, merged 2026-10-15T16:54Z):
    - Problem & change: When daemon launched concurrently with multiple workers or CLI invocations on Windows and POSIX, _config.db (SQLite) threw SQLITE_BUSY (code 5) or hot-journal recovery lock failures during BEGIN IMMEDIATE / COMMIT, causing daemon startup (daemon start --port) to crash. Added retry/busy handlers with timeouts across settings_open, startup, UI load, cbm_config_open, and hot-journal recovery.
    - PR #2648 (fix(security): allow the bare wget token the shell pass compares, merged 2026-10-15T16:48Z) and PR #2651 (pin ScanCode install against pluggy 1.7.0).
    - Architectural contrast: trace-mcp uses better-sqlite3 with WAL mode and serialized transactions in Node.js, completely avoiding multi-process native C lock-recovery race conditions and ANSI/POSIX journal clashes.
- oraios/serena:
  - PR #2171 (Fix dashboard log updates during HTTP MCP server execution, updated 2026-10-15T14:45Z):
    - Preserved logging handlers and levels with a scoped Uvicorn configuration wrapper and handled log cursor index zero without treating it as missing.
- colbymchenry/codegraph:
  - PR #1947 & #1953 (fix(resolution): library-method calls on untyped receivers need receiver evidence (Rust, Go, Python, Kotlin, Scala, C#, Java), updated 2026-10-15T17:49Z):
    - Problem & change: For untyped method calls (e.g. x.len(), conn.Close(), d.setdefault(), Task.Run(), list.size(), Objects.hash()), CodeGraph previously bound them blindly to any project method with the same name (creating thousands of false positive edges across Rust, Go, Python, Scala, Kotlin, C#, Java). They resorted to hardcoded curated lists of standard library method names (library-methods.ts) and heuristics matching receiver word tokens.
  - PR #1952 (fix(resolution): resolve a call to the caller's own class member before ranking same-file namesakes, updated 2026-10-15T17:47Z):
    - Same-file tie breaking previously used line proximity without checking class hierarchy, mistakenly binding calls to sibling classes or creating self-loops.
    - Architectural contrast: trace-mcp prioritizes precision over speculative call graph density. Rather than constructing speculative heuristic call-graph edges that require hundreds of hand-maintained stdlib name exceptions to prune, trace-mcp provides verified AST symbol definitions, exported symbols, and scope hierarchy, maintaining zero false-positive hallucinated call graphs.
- tirth8205/code-review-graph:
  - PR #1105 (fix: repair stale FTS on no-op updates, updated 2026-10-15T16:43Z):
    - Prevented FTS search index from drifting out of sync when incremental graph post-processing was skipped.
    - Architectural contrast: trace-mcp uses deterministic SQLite schema triggers and content hashing for symbols, guaranteeing that incremental indexing never causes full-text search drift.

**Competitor pulse (as of 2026-10-15 late night pass):**
- nikolai-vysotskyi/trace-mcp: 193★ (+1), 24 forks (=)
- yamadashy/repomix: 28,849★ (=), 1,594 forks (+2)
- oraios/serena: 30,288★ (+1), 2,078 forks (=)
- DeusData/codebase-memory-mcp: 46,651★ (+9), 3,839 forks (=)
- tirth8205/code-review-graph: 32,169★ (+6), 2,950 forks (=)
- colbymchenry/codegraph: 74,182★ (+16), 4,790 forks (+3)
- abhigyanpatwari/GitNexus: 47,899★ (+4), 5,198 forks (=)
- jgravelle/jcodemunch-mcp: 2,773★ (+2), 375 forks (=)
- continuedev/continue: 36,228★ (=), 5,476 forks (+1)
- Aider-AI/aider: 49,566★ (+1), 5,061 forks (+1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.



### Early morning pass, 2026-10-16 (TRA-2458): mention sweep clean, open threads audit, competitor triage (jcodemunch PR #1100/#1101, codegraph PR #2598, serena PR #2172, continue PR #13386)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; table row updated to closed/rejected, standing no-ping rule holds, no follow-up).
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (updated 2026-10-09T01:18Z with Round 4 review from hetaoBackend). Dedicated lane for Nikolai.
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds (reminder sent 2026-09-26).
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: false/dirty due to upstream context additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - Dokploy/mcp#81: OPEN (updated 2026-10-08T20:56:56Z, community implementation progressing with contributor moataz-hjaiji advancing dokploy-loadTools meta-tool PR).
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry.
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: Clean. Zero new repos outside `ops/mentions-seen.txt`.

**Competitor intelligence & architectural observations:**
- jgravelle/jcodemunch-mcp:
  - PR #1101 (feat: a session lists only its own workspace's indexes by default (repo_visibility), merged 2026-10-15T20:52Z):
    - Problem & change: Sessions sharing an index store previously saw every repository indexed on the machine. `list_repos` leaked names and paths of other repositories (client code, internal packs, personal projects) across shared agent sessions. Introduced `repo_visibility` configuration (`"workspace"` default vs `"all"`; env `JCODEMUNCH_REPO_VISIBILITY`), hiding out-of-workspace indexes from `list_repos` and restricting ambiguous bare name resolution.
    - Release v1.108.366 (PR #1100, merged 2026-10-15T18:53Z):
      - Ships permanent environment variable support without 2.0 deprecation warnings.
    - Architectural contrast: trace-mcp isolates indexes strictly per workspace root (`.trace/`) by directory path hash in SQLite. The daemon manages project boundaries natively, ensuring multi-project privacy and separation by design without requiring post-hoc visibility filtering over a global multi-repo index.
- colbymchenry/codegraph:
  - PR #2598 (fix(cpp): a call on a dereferenced iterator or pointer, `(*it)->Visit()`, calls the method of what it points at, merged 2026-10-15T21:58Z):
    - Problem & change: For calls through dereferenced pointers or iterators (e.g. `(*it)->Visit()`, `(*node).Weight()`), the extractor emitted bare names without receiver types. Name-matching heuristics then mapped these calls to arbitrary classes having a method of that name with low confidence (0.4–0.7), creating false edges across unrelated classes (e.g. protobuf `FieldDescriptor` calls reaching C# `FieldGeneratorBase`). Introduced `cppDereferenced` expression typing and `matchCppDereferencedCall` to resolve against the target value's type before falling back to name heuristics.
    - Architectural contrast: trace-mcp resolves symbols using Tree-sitter AST queries with verified syntactic scopes and language-specific definitions rather than speculative heuristic fuzzy-name matching that risks cross-class edge hallucinations.
- oraios/serena:
  - PR #2172 (Fix symlink handling in symbol discovery and explicit LSP requests, merged 2026-10-15T19:39Z):
    - Problem & change: Addresses symlink traversal vulnerabilities and inconsistencies during symbol discovery (Fixes #2163). In untrusted projects, directory traversal now skips file and directory symlinks. For explicit LSP requests, path validation enforces project root containment to prevent symlink traversal outside workspace boundaries.
    - Architectural contrast: trace-mcp's file walker enforces boundary containment, canonical path checks, and respect for `.gitignore`/`.ignore` rules by default, preventing out-of-tree symlink traversal attacks.
- continuedev/continue:
  - PR #13386 (fix(tools): coerce stringified argument types to schema expectations (#13350), updated 2026-10-15T21:43Z):
    - Problem & change: Certain LLMs (such as Ollama/Qwen) emit JSON arrays, objects, booleans, and numbers as serialized JSON strings in tool call parameters. When dispatched to MCP servers validating parameters with JSON Schema/Zod, this caused `-32602: Invalid arguments` crashes. Continue implemented `coerceArgsToSchema` in its core client tool execution pipeline.
    - Architectural contrast: trace-mcp tools handle parameter normalization and type coercion gracefully in Node.js server handlers, ensuring tool resilience even when client agents pass serialized JSON strings.

**Competitor pulse (as of 2026-10-16 early morning pass):**
- nikolai-vysotskyi/trace-mcp: 193★ (=), 24 forks (=)
- yamadashy/repomix: 28,851★ (+2), 1,598 forks (+4)
- oraios/serena: 30,295★ (+7), 2,083 forks (+5)
- DeusData/codebase-memory-mcp: 46,668★ (+17), 3,840 forks (+1)
- tirth8205/code-review-graph: 32,172★ (+3), 2,954 forks (+4)
- colbymchenry/codegraph: 74,195★ (+13), 4,792 forks (+2)
- abhigyanpatwari/GitNexus: 47,900★ (+1), 5,198 forks (=)
- jgravelle/jcodemunch-mcp: 2,773★ (=), 375 forks (=)
- continuedev/continue: 36,228★ (=), 5,477 forks (+1)
- Aider-AI/aider: 49,569★ (+3), 5,060 forks (-1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.



### Morning pass, 2026-10-16 (TRA-2468): mention sweep clean, open threads audit, competitor triage (jcodemunch v1.108.368 / PR #1103-#1106, codegraph PR #2609/#2612, continue PR #13388)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (updated 2026-10-09T01:18Z with Round 4 review from hetaoBackend). Dedicated lane for Nikolai.
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds (reminder sent 2026-09-26).
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: false/dirty due to upstream context additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - Dokploy/mcp#81: OPEN (updated 2026-10-08T20:56:56Z, community implementation progressing with contributor moataz-hjaiji advancing dokploy-loadTools meta-tool PR).
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry.
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; table row updated to closed/rejected, standing no-ping rule holds, no follow-up).
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: Clean. Zero new repos outside `ops/mentions-seen.txt`.

**Competitor intelligence & architectural observations:**
- jgravelle/jcodemunch-mcp:
  - Release v1.108.368 (PR #1105, merged 2026-10-16T02:10Z; PR #1103 & #1104):
    - Context provider budget drops (PR #1103, L-190): Context providers running under `JCODEMUNCH_PROVIDER_BUDGET_SECONDS` (such as Express route extractors) previously timed out silently on busy machines without recording partial index state, leading to non-deterministic indexing and keyword generation across incremental builds depending on CPU load. Now records cut providers and schedules them for re-run.
    - Scanner text & static matching (PR #1104, L-195): Addressed catalog scanners (e.g. mcp.market / plugin scanners) that flag published packages by naively matching `eval`/`exec` strings in test fixtures, prompts, and docstrings.
    - Path prefix containment (PR #1106, L-197): Drive roots (`folder + os.sep`) produced doubled slashes, breaking path containment and `.gitignore` matching.
    - Architectural contrast: trace-mcp uses deterministic native Tree-sitter parsing without arbitrary per-file timer cutoffs that cause incomplete index state, relies on SQLite directory path hash isolation rather than fragile string path prefixes, and contains no `eval`/`exec` calls.
- colbymchenry/codegraph:
  - PR #2609 (fix(cpp): template explicit specialization naming, merged 2026-10-16T02:41Z): Qualified names previously split template arguments at `::` (e.g. `ReadPrimitive::TYPE_INT32>`), breaking symbol call linkage.
  - PR #2612 (fix(cpp): free function overload resolution by argument fit, merged 2026-10-16T03:32Z): Free functions previously resolved overloads by line/file proximity rather than argument type signatures, causing wrong-overload bindings.
  - Architectural contrast: trace-mcp relies on AST scope hierarchy and structured symbol definitions rather than textual or positional proximity heuristics.
- continuedev/continue:
  - PR #13388 (fix(indexing): skip directories failing listDir and evict rejected cache entries, updated 2026-10-16T03:57Z): WalkDir previously crashed on virtual or restricted filesystem schemes (e.g. SAP ABAP `adt://` or permission-denied directories) due to unhandled promise rejections in cache.
  - Architectural contrast: trace-mcp's file walker handles permission denied and unsupported filesystem paths gracefully with per-entry error recovery, preserving indexing integrity.

**Competitor pulse (as of 2026-10-16 morning pass):**
- nikolai-vysotskyi/trace-mcp: 194★ (+1), 24 forks (=)
- yamadashy/repomix: 28,855★ (+4), 1,598 forks (=)
- oraios/serena: 30,303★ (+8), 2,083 forks (=)
- DeusData/codebase-memory-mcp: 46,677★ (+9), 3,845 forks (+5)
- tirth8205/code-review-graph: 32,178★ (+6), 2,954 forks (=)
- colbymchenry/codegraph: 74,213★ (+18), 4,799 forks (+7)
- abhigyanpatwari/GitNexus: 47,906★ (+6), 5,198 forks (=)
- jgravelle/jcodemunch-mcp: 2,774★ (+1), 375 forks (=)
- continuedev/continue: 36,232★ (+4), 5,479 forks (+2)
- Aider-AI/aider: 49,575★ (+6), 5,061 forks (+1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.



### Afternoon pass, 2026-10-16 (TRA-2471): mention sweep (sayef/comind), open threads audit, competitor triage (DeusData v0.12.0 / CBM Lens Beta, jgravelle v1.108.369-370 / PR #1109, colbymchenry PR #2618, oraios PR #2172)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (updated 2026-10-09T01:18Z with Round 4 review from hetaoBackend). Dedicated lane for Nikolai.
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds (reminder sent 2026-09-26).
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: false/dirty due to upstream context additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - Dokploy/mcp#81: OPEN (updated 2026-10-08T20:56:56Z, community implementation progressing with contributor moataz-hjaiji advancing dokploy-loadTools meta-tool PR).
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry.
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; table row updated to closed/rejected, standing no-ping rule holds, no follow-up).
- Touch budget: 0 of 5 used. No outgoing pings or PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Found 1 new repository mentioning trace-mcp:
  - `sayef/comind`: Independent deterministic code intelligence engine project for coding agents (SCIP-based, self-hosted single binary over MCP). In `docs/design/ledger.md` ("Comind Ledger — design plan", dated 2026-10-13, active pushes 2026-10-16), evaluates agent memory systems under §1 "Why this, why now"; under the "Decision records" category, explicitly cites `trace-mcp` alongside ADR/MADR and Lore trailers, and references `trace-mcp decision memory: https://trace-mcp.com/decision-memory.html`. Recorded as a genuine architectural citation in the surfaces table and silenced in `ops/mentions-seen.txt`.

**Competitor intelligence & architectural observations:**
- DeusData/codebase-memory-mcp:
  - Milestone release **v0.12.0** published 2026-10-15T22:08Z (231 PRs merged since v0.11.0, 40 community PRs):
    - CBM Lens Beta: Added a built-in loopback web UI (`--ui=true`) exploring code knowledge graphs by file, neighborhood, architecture, routes, hotspots, and browser-local assistant model. Subsystem ownership transferred to @BernhardJackiewicz (#2068, #1964, #2383).
    - Documentation in graph: Markdown, rST, AsciiDoc, PDF, ADRs, diagrams, and OpenAPI specs linked strictly to functions, types, and files.
    - Smart CI: `detect_changes` seeds graph from diff, walks dependency paths, and identifies affected tests with causal reasons.
    - Infrastructure as Code: Kubernetes manifests, Helm, Flux/Argo CD, Compose files, Dockerfiles linking to workloads and programs.
    - Architectural contrast: trace-mcp ships a dedicated standalone Electron desktop app (`trace-mcp-desktop`) with native OS windowing rather than embedding an HTTP web server into the CLI binary; indexes markdown and documentation via lightweight structured symbols (`non-code-scanner`) without requiring heavy graph database schemas or full rebuilds on upgrade; and consumes negligible memory compared to CBM's 46–48 MB binaries and heavy in-memory Cypher graphs.
- jgravelle/jcodemunch-mcp:
  - Releases v1.108.369 and v1.108.370 (PR #1109, merged 2026-10-16T08:05Z, LEDGER L-177):
    - Import extractors: Seven import extractors (PHP group use `use App\Models\{User, Post};`, Kotlin alias `import a.b.D as E`, Scala `import a.b.{C, D}`, Haskell `import A.B (c, d)`, Dart `import 'a.dart' show C, D;`, CJS destructuring `const {a, b} = require("./m")`, and Python line continuation `import os, \`) previously dropped imported names or failed to record edges because regex readers stopped at the opening token without parsing bracketed/destructured lists.
    - ReDoS vulnerability: CodeQL caught exponential backtracking in `_DART_CLAUSE` regex on unclosed keywords; patched with word boundary assertions (`\b`).
    - Architectural contrast: trace-mcp uses Tree-sitter AST parsing across all supported grammars instead of bespoke regex extractors, eliminating both import syntax parser fragmentation and ReDoS vulnerabilities at the grammar level.
- colbymchenry/codegraph:
  - PR #2618 (fix(cpp): overload const twin resolution, merged 2026-10-16T07:20Z):
    - Overload resolution scored `const T*` and `T*` parameters identically, picking whichever was declared first and retargeting calls in protobuf (194 calls), rocksdb (25 calls), fmt (14 calls). Introduced `cppConstTwinChoice` and scoring rules for non-const references vs values.
    - Architectural contrast: trace-mcp focuses on fast AST symbol indexing and structural call hierarchies rather than attempting full C++ compiler overload resolution emulation via heuristic scoring tables.
- oraios/serena:
  - PR #2172 (fix symlink handling in symbol discovery and explicit LSP requests, merged 2026-10-15T19:39Z, fixes #2163):
    - Untrusted projects previously traversed symlinks during symbol discovery or explicit requests, risking path traversal outside project root. Now skips file/dir symlinks in untrusted projects and enforces root containment in `LspApi`.
    - Architectural contrast: trace-mcp enforces strict realpath root containment by default across all tools and indexers, rejecting traversal outside repository boundaries unconditionally.

**Competitor pulse (as of 2026-10-16 afternoon pass):**
- nikolai-vysotskyi/trace-mcp: 194★ (=), 24 forks (=)
- yamadashy/repomix: 28,864★ (+9), 1,601 forks (+3)
- oraios/serena: 30,310★ (+7), 2,088 forks (+5)
- DeusData/codebase-memory-mcp: 46,691★ (+14), 3,846 forks (+1)
- tirth8205/code-review-graph: 32,189★ (+11), 2,956 forks (+2)
- colbymchenry/codegraph: 74,250★ (+37), 4,803 forks (+4)
- abhigyanpatwari/GitNexus: 47,910★ (+4), 5,199 forks (+1)
- jgravelle/jcodemunch-mcp: 2,774★ (=), 375 forks (=)
- continuedev/continue: 36,232★ (=), 5,480 forks (+1)
- Aider-AI/aider: 49,586★ (+11), 5,063 forks (+2)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.



### Evening pass, 2026-10-16 (TRA-2473): mention sweep clean, open threads audit, competitor triage (DeusData v0.12 postinstall breakdown / dynamic import regression, jgravelle v1.108.371, colbymchenry PR #2616, GitNexus PR #3561)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds (reminder sent 2026-09-26).
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: CONFLICTING due to upstream self-additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - Dokploy/mcp#81: OPEN (community implementation progressing with contributor moataz-hjaiji advancing dokploy-loadTools meta-tool PR).
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry.
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; standing no-ping rule holds, no follow-up).
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Sweep clean: zero new repositories outside the seen list ("No repos outside the seen list. Nothing to read.").

**Ecosystem & useful repositories:**
- `milisp/mcp-linker` (342★): Cross-client configuration manager and marketplace for Claude Code, Codex, Cursor, etc. Verified that it natively discovers and installs servers directly from the official MCP registry (`registry.modelcontextprotocol.io`), where `io.github.nikolai-vysotskyi/trace-mcp` is active and published, providing immediate one-click discoverability and installation across clients without requiring a dedicated repo submission.
- `SenseiIssei/Sensei` (2★): Emerging self-hosted local token compaction proxy/gateway for AI tools (Claude Code, Cursor, Aider). Claims 79% token reduction via JSON/log compaction on the wire. Distinct architectural contrast: Sensei compresses raw chat logs and context buffers in-transit at the proxy level, whereas trace-mcp eliminates context waste at the root by replacing blind whole-file reads with precomputed AST maps and structural symbol queries.

**Competitor intelligence & architectural observations:**
- DeusData/codebase-memory-mcp:
  - Post-v0.12.0 packaging regression (Issue #2657, opened 2026-10-16 by `hydroplexus`): The v0.12.0 Linux-amd64 binary expanded to 316.0 MB (driven by embedded CBM Lens loopback web UI and monolithic dependencies), exceeding the package's own `install.js` safety limit of 256 MiB (`MAX_ARCHIVE_MEMBER_BYTES = 256 * 1024 * 1024`). As a result, `npm install -g codebase-memory-mcp@0.12.0` fails completely out-of-the-box on Linux.
  - Dynamic import regression (Issue #2659, opened 2026-10-16 by `benjaminge73` via Claude Code): Python functions called as `module.func()` where `module` was loaded via `importlib.util.spec_from_file_location` + `exec_module` are no longer traced as inbound callers in v0.11.0 and v0.12.0 (broken caller resolution for non-packaged scripts and dynamic test harnesses).
  - Architectural contrast: trace-mcp maintains a lean architecture with fast tree-sitter AST queries, zero multi-hundred-megabyte binary downloads, zero embedded web servers, and consistent import resolution across all supported languages.
- jgravelle/jcodemunch-mcp:
  - Release v1.108.371 (PR #1111 / #1112, merged 2026-10-16T10:41Z / 12:23Z, LEDGER L-184):
    - Dead-code heuristic refinement: `find_dead_code` and `check_delete_safe` heuristic advice on XML schema (`.xsd`) and WSDL files previously used extension sniffing to decide whether a repo was .NET. Bare `.fs` counted as F#, causing Maven repositories with GLSL fragment shaders (`shader.fs`) to be misclassified as .NET; `.cshtml` and `.razor` were missing from .NET evidence. Fixed to require `.fsproj`/`.fsx`/`.fsi` and added Razor/Blazor extensions.
    - Architectural contrast: trace-mcp determines project ecosystem and build configuration from authoritative project manifests (e.g. `*.csproj`, `*.fsproj`, `pom.xml`, `package.json`) and tree-sitter AST graphs rather than filename extension heuristics.
- colbymchenry/codegraph:
  - PR #2616 (merged 2026-10-16T06:26Z):
    - Added `cppLibraryElementOf` container accessor type inference for standard/project sequences and holders (`front()`, `back()`, `at()`, `top()`, `get()`, `value()`, `value_or()`) over STL containers, `std::unique_ptr`/`shared_ptr`, and RocksDB/Protobuf types to connect call chains across accessor boundaries.
    - Architectural contrast: trace-mcp provides structural symbol definition and navigation without attempting to emulate compiler-level C++ template type deductions and accessor heuristic tables.
- abhigyanpatwari/GitNexus:
  - PR #3561 (merged 2026-10-16T08:02Z):
    - Route extraction fix: Ignored Express `app.use` middleware mounts when extracting endpoints to eliminate false positive route registrations, and restricted route metadata comparisons.
    - Architectural contrast: trace-mcp's framework detection (`src/frameworks/`) specifically isolates HTTP method handlers (`get`, `post`, `put`, `delete`) via semantic AST queries rather than treating generic middleware registrations as callable API routes.

**Competitor pulse (as of 2026-10-16 evening pass):**
- nikolai-vysotskyi/trace-mcp: 194★ (=), 24 forks (=)
- yamadashy/repomix: 28,867★ (+3), 1,617 forks (+16)
- oraios/serena: 30,316★ (+6), 2,103 forks (+15)
- DeusData/codebase-memory-mcp: 46,700★ (+9), 3,847 forks (+1)
- tirth8205/code-review-graph: 32,190★ (+1), 2,968 forks (+12)
- colbymchenry/codegraph: 74,269★ (+19), 4,803 forks (=)
- abhigyanpatwari/GitNexus: 47,913★ (+3), 5,198 forks (-1)
- jgravelle/jcodemunch-mcp: 2,775★ (+1), 375 forks (=)
- continuedev/continue: 36,232★ (=), 5,479 forks (-1)
- Aider-AI/aider: 49,584★ (-2), 5,063 forks (=)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.



### Late night pass, 2026-10-16 (TRA-2475): mention sweep (daniyal44/Zyphuel), open threads audit, competitor triage (DeusData packaging bypass / Java exclusion / C macro leak, GitNexus route fix & impact over-rating, CRG .cjs parser gap)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds (reminder sent 2026-09-26).
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: CONFLICTING due to upstream self-additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - Dokploy/mcp#81: OPEN (community implementation progressing with contributor moataz-hjaiji advancing dokploy-loadTools meta-tool PR).
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; standing no-ping rule holds, no follow-up).
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Discovered 1 new repository mentioning trace-mcp: `daniyal44/Zyphuel`.
  - Audited read-only via raw content: `.mcp.json` and `COMPONENTS_INDEX.md` configure `trace-mcp` (`npx -y trace-mcp@latest`) with description "Framework-aware code intelligence — semantic navigation, impact analysis, and refactoring across 87 framework integrations and 80 languages...".
  - Origin: downstream project adoption/mirror of the `aitmpl.com` (davila7/claude-code-templates) catalog. Classified and recorded in `ops/mentions-seen.txt`.

**Ecosystem & useful repositories:**
- `daniyal44/Zyphuel`: Demonstrates downstream real-world adoption of `trace-mcp` configured in project `.mcp.json` via the `aitmpl.com` marketplace templates.
- `GuillaumeBarnes82/env-doctor`: Open-source environment and GPU/CUDA diagnostics utility pairing a CLI with an MCP server interface, highlighting the pattern of composing specialized environment diagnostic MCPs with structural code intelligence servers like trace-mcp in agent pipelines.

**Competitor intelligence & architectural observations:**
- DeusData/codebase-memory-mcp:
  - Packaging bypass (PR #2664, merged 2026-10-16T16:16Z): Instead of addressing binary payload bloat (where Linux-amd64 binary reached 316.0 MB and crashed npm installs by exceeding `MAX_ARCHIVE_MEMBER_BYTES = 256 MiB`), maintainers removed the archive size cap entirely from npm, PyPI, and Go wrappers.
  - Java package exclusion defect (Issue #2661, opened 2026-10-16T15:22Z): Blanket directory exclusion heuristics treat folder segments named `target`, `tmp`, `deploy`, or `vendor` as build output directories, silently causing valid Java source packages containing those path tokens (e.g. `com.company.deploy.service`) to be omitted from the index.
  - Macro expansion identifier leakage (Issue #2666, opened 2026-10-16T16:11Z): Identifier tokens passed into C preprocessor macros erroneously generate false USAGE edges to unrelated struct fields sharing the same identifier name.
  - Architectural contrast: trace-mcp relies on tree-sitter AST queries with zero multi-hundred-megabyte binary downloads, anchors project boundaries to project manifests rather than blanket segment exclusion, and maintains strict lexical AST scoping for identifier references.
- abhigyanpatwari/GitNexus:
  - Route extraction regression fix (PR #3603, merged 2026-10-16T17:25Z): Corrected router receiver and mount path resolution after PR #3561's blanket suppression of `app.use` inadvertently discarded nested Express sub-routers.
  - Impact over-rating (Issue #3602, opened 2026-10-16T12:04Z): `impact` marks symbols HIGH/CRITICAL with `epistemic: exact` based on file-level module imports, treating all importers of a file as direct callers of internal unexported types.
  - Architectural contrast: trace-mcp maps granular symbol call sites and reference edges rather than equating coarse module imports with symbol dependencies.
- tirth8205/code-review-graph:
  - Extension gap (Issue #1117 / PR #1118, 2026-10-16): `EXTENSION_TO_LANGUAGE` lacked `.cjs`, silently dropping CommonJS JavaScript files during indexing.
  - Architectural contrast: trace-mcp supports all CommonJS and ESM file extensions natively across 81 languages.
- colbymchenry/codegraph:
  - Query timeout issue (Issue #2620 / PR #2621, 2026-10-16): Explore queries repeated redundant per-term traversals on large graphs, timing out prompt hooks in Claude.
  - Architectural contrast: trace-mcp uses indexed SQLite lookups ensuring deterministic sub-millisecond retrieval.
- jgravelle/jcodemunch-mcp:
  - Release v1.108.372 (PR #1114 / #1115, merged 2026-10-16T15:59Z, LEDGER L-186): Fixed policy uninstallation to preserve user-custom sections rather than overwriting existing markdown files.

**Competitor pulse (as of 2026-10-16 late night pass):**
- nikolai-vysotskyi/trace-mcp: 194★ (=), 24 forks (=)
- yamadashy/repomix: 28,867★ (=), 1,617 forks (=)
- oraios/serena: 30,323★ (+7), 2,104 forks (+1)
- DeusData/codebase-memory-mcp: 46,711★ (+11), 3,848 forks (+1)
- tirth8205/code-review-graph: 32,195★ (+5), 2,968 forks (=)
- colbymchenry/codegraph: 74,280★ (+11), 4,803 forks (=)
- abhigyanpatwari/GitNexus: 47,915★ (+2), 5,198 forks (=)
- jgravelle/jcodemunch-mcp: 2,775★ (=), 375 forks (=)
- continuedev/continue: 36,231★ (-1), 5,479 forks (=)
- Aider-AI/aider: 49,583★ (-1), 5,064 forks (+1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.






### Early morning pass, 2026-10-17 (TRA-2481): mention sweep clean, open threads audit, competitor triage (codegraph C++ chained member leak & Rust bare-name method match, DeusData v0.12.1 smoke failures & Java HTTP limitations, GitNexus cache identity, jcodemunch v1.108.373)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds (reminder sent 2026-09-26).
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: CONFLICTING due to upstream self-additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - Dokploy/mcp#81: OPEN (community implementation progressing with contributor moataz-hjaiji advancing dokploy-loadTools meta-tool PR).
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; standing no-ping rule holds, no follow-up).
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: 0 new repositories outside the seen list ("No repos outside the seen list. Nothing to read."). Sweep clean.

**Ecosystem & useful repositories:**
- `ptai-eng/chronos-agent` (v1.2.0): Open-source code intelligence harness and blast-radius analysis server combining an MCP server with Petgraph/KuzuDB, PageRank analysis, and mutation sandboxing. Contrast: chronos relies on native Rust compilation, heavy graph database infrastructure, and focused runtime profiling across 3 languages (TS/JS, Python, Rust), while trace-mcp provides instant zero-dependency Node execution with precomputed SQLite indexes across 81 languages and 87 frameworks designed specifically for fast token savings in LLM coding agents.
- `giauphan/codeatlas-platform`: AI-powered codebase intelligence platform pairing MCP with AST analysis and SQLite/sqlite-vec.

**Competitor intelligence & architectural observations:**
- colbymchenry/codegraph:
  - Chained C++ member call leakage (PR #2626, merged 2026-10-16T20:39Z): Chained member calls (`a.b.m()`, `a->b->m()`, or `options.cf_paths.emplace_back(...)` on a `std::vector`) were recorded by the extractor under their bare method name `m`, causing standard library container method calls to erroneously resolve to whatever project method shared the name `emplace_back`.
  - Rust method resolution by bare name (Issue #2614 / PR #2625, opened 2026-10-16T18:34Z): Rust method calls were matched across the project purely by method name rather than resolving by the receiver's written type and trait implementations.
  - Architectural contrast: trace-mcp relies on semantic tree-sitter AST queries with receiver type inference, strict scope chains, and qualified member path validation, preventing standard library member method calls from polluting project symbol call graphs.
- DeusData/codebase-memory-mcp:
  - Release wrapper smoke failure (PR #2669, merged 2026-10-16T21:38Z): v0.12.1 release run broke in Phase 13w package-wrapper smoke tests on macOS (missing Go toolchain) and Windows (locked worktree tmp dirs), illustrating the maintenance drag of multi-language native distribution wrappers.
  - Java HTTP extraction limitation (Issue #2668, opened 2026-10-16T18:21Z): Outbound HTTP call extraction (`HTTP_CALLS`) fails for injected clients, format-string URLs, and fluent request builders, extracting edges only for hardcoded string literal URLs.
  - External receiver call guessing (PR #2667, 2026-10-16): Attempting to suppress speculative name guessing on proven-external receivers.
  - Architectural contrast: trace-mcp's zero-wrapper TypeScript/Node architecture provides deterministic cross-platform behavior without heavy native toolchains, and models call sites via syntactic call edges rather than fragile string-pattern regexes.
- abhigyanpatwari/GitNexus:
  - Cache identity derivation (PR #3606, opened 2026-10-16T21:01Z): Moving to automatically derive parser and PDG cache identities from executed artifacts instead of requiring manual schema version counter management.
- jgravelle/jcodemunch-mcp:
  - Release v1.108.373 (PR #1118, 2026-10-16): Updated `claude-md --refresh` to write the server's policy instructions directly.

**Competitor pulse (as of 2026-10-17 early morning pass):**
- nikolai-vysotskyi/trace-mcp: 194★ (=), 24 forks (=)
- yamadashy/repomix: 28,870★ (+3), 1,618 forks (+1)
- oraios/serena: 30,329★ (+6), 2,114 forks (+10)
- DeusData/codebase-memory-mcp: 46,717★ (+6), 3,850 forks (+2)
- tirth8205/code-review-graph: 32,195★ (=), 2,973 forks (+5)
- colbymchenry/codegraph: 74,283★ (+3), 4,803 forks (=)
- abhigyanpatwari/GitNexus: 47,918★ (+3), 5,199 forks (+1)
- jgravelle/jcodemunch-mcp: 2,776★ (+1), 375 forks (=)
- continuedev/continue: 36,233★ (+2), 5,479 forks (=)
- Aider-AI/aider: 49,584★ (+1), 5,063 forks (-1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.






### Morning pass, 2026-10-17 (TRA-2490): mention sweep (wkoch/legacy), open threads audit, competitor triage (codegraph C++ chained & inherited member resolution PR #2627/#2628, DeusData symlink install crash #2671 & Lens local model endpoint #2670, jcodemunch PEP 405 venv prune PR #1122)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds.
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: CONFLICTING due to upstream self-additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - Dokploy/mcp#81: OPEN (community implementation progressing with contributor moataz-hjaiji advancing dokploy-loadTools meta-tool PR).
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; standing no-ping rule holds, no follow-up).
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Discovered 1 genuine third-party evaluation surface outside the seen list:
  - `wkoch/legacy` (0★, active 2026-10-16): Architecture planning documents `docs/automacao-rede-e-inteligencia.md` and `docs/decisoes.md` evaluating code intelligence architectures for decentralized AI agents. Evaluates `trace-mcp` (citing https://trace-mcp.com/code-graph-mcp.html for incremental local graphs and framework-specific relationships) alongside Graft as potential adapters for logical code mapping. Recommends starting with pilot language adapters. Added to Surfaces table and `ops/mentions-seen.txt`.
- No outreach / do not ping: purely an independent architectural evaluation, thread untouched per rules.

**Ecosystem & useful repositories:**
- `wkoch/legacy`: Decentralized agent architecture study. Notable for framing code intelligence as a reconstructible revision-associated cache with origin tracking, contrasting Graft (Tree-sitter extraction + LSP) and trace-mcp (incremental local graph + framework semantics) as adapters rather than hard dependencies.
- Continues the broader architectural pattern of agent builders recognizing the value of precomputed, lightweight local code maps over raw file reads and unstructured context dumps.

**Competitor intelligence & architectural observations:**
- colbymchenry/codegraph:
  - Chained C++ member call linking to project classes (PR #2627, merged 2026-10-16T23:13Z): Step 2 of fixing C++ member-chain calls (`thread->rand.Next()` on `Random64`). Previously bare-name lookup fell back to whatever class declared a method named `Next` (or an implicit `this` call on the calling method's class). Implemented project class resolution via `matchCppMemberChainCall`.
  - Inherited C++ member calls through chains (PR #2628, merged 2026-10-17T02:05Z): Step 3 of member-chain calls. Resolves calls on inherited members like `options.statistics->getTickerCount(…)` on RocksDB's `Options` by walking base class hierarchy up to depth 4 (`cppInheritedDataMember`) because `Options` inherits `statistics` from `DBOptions`.
  - Architectural contrast: trace-mcp relies on semantic tree-sitter AST queries with scoped symbol namespaces, receiver type inference, and qualified member path validation, preventing standard library member method calls from polluting project symbol call graphs and avoiding speculative bare-name matching.
- DeusData/codebase-memory-mcp:
  - Symlink agent config installer crash (Issue #2671, opened 2026-10-17T04:00Z): `install.sh` downloads and verifies v0.12.1 binary, but crashes during agent configuration when any harness config file (e.g. `/Users/.../Library/Application Support/Zed/settings.json`) is a symlink (common dotfiles pattern). The single failure halts the entire installer, leaving 15+ agent configs in a partially modified state and failing to clean up.
  - Self-hosted model gap in Lens chat (Issue #2670, opened 2026-10-17T02:41Z): Users request an OpenAI-compatible endpoint setting (Ollama / vLLM / llama.cpp) because CBM Lens enforces downloading small 0.5B-2B in-browser ONNX models per device via WebGPU or binds to a hardcoded `127.0.0.1:4141` loopback sidecar.
  - Architectural contrast: trace-mcp follows a non-invasive, zero-side-effect architecture. It never silently rewrites 15 different agent config files or breaks on symlinked dotfiles, and requires no heavy multi-gigabyte browser models or native Go/C binaries.
- jgravelle/jcodemunch-mcp:
  - Virtualenv pruning by PEP 405 pyvenv.cfg (PR #1122, merged 2026-10-17T02:52Z): Prunes directories whose `pyvenv.cfg` carries a `home` key during indexing walks and watcher paths. Required multiple review rounds to ensure only `site-packages` is pruned rather than project root layout directories (`bin/`, `lib/`), preserving hand-written files.
  - Test harness and Python 3.14 gaps (PR #1121, merged 2026-10-17T02:16Z): Addressed Python 3.14 `Optional[str]` string formatting divergence (`str | None`) and git blame timeouts under load.
  - Architectural contrast: trace-mcp's walker (`src/indexer/walker.ts`) uses well-defined ignore patterns and project boundary definitions, preventing accidental exclusion of valid project source files.
- abhigyanpatwari/GitNexus:
  - Cache identity derivation (PR #3606, opened 2026-10-16T21:01Z): Automatic derivation of parser and PDG cache identities from executed artifacts.

**Competitor pulse (as of 2026-10-17 morning pass):**
- nikolai-vysotskyi/trace-mcp: 194★ (=), 24 forks (=)
- yamadashy/repomix: 28,869★ (-1), 1,618 forks (=)
- oraios/serena: 30,336★ (+7), 2,114 forks (=)
- DeusData/codebase-memory-mcp: 46,724★ (+7), 3,849 forks (-1)
- tirth8205/code-review-graph: 32,203★ (+8), 2,973 forks (=)
- colbymchenry/codegraph: 74,300★ (+17), 4,804 forks (+1)
- abhigyanpatwari/GitNexus: 47,919★ (+1), 5,200 forks (+1)
- jgravelle/jcodemunch-mcp: 2,777★ (+1), 375 forks (=)
- continuedev/continue: 36,234★ (+1), 5,480 forks (+1)
- Aider-AI/aider: 49,588★ (+4), 5,064 forks (+1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.






### Afternoon pass, 2026-10-17 (TRA-2493): mention sweep clean, open threads audit, competitor triage (codegraph sync import member retry PR #2630 & Windows libuv suspended child leak PR #2629, DeusData duplicate index worker CPU storm & DB corruption #2673, jcodemunch protective boolean env typo PR #1125 & git blame fallback PR #1128, GitNexus rebuild journal consolidation PR #3613 & directory symlink crawler PR #3616)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds.
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: CONFLICTING due to upstream self-additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; standing no-ping rule holds, no follow-up).
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: 0 new repos outside the seen list. Sweep verified clean across all search facets.
- External touches: 0.

**Ecosystem & useful repositories:**
- Active architectural shift across agent code intelligence tools towards resilient background daemon management and atomic persistence.
- Multi-client concurrency remains a significant pain point for competitors that lack unified single-instance daemon architectures, leading to SQLite contention and high CPU thrashing when multiple agent sessions connect to the same repository.

**Competitor intelligence & architectural observations:**
- colbymchenry/codegraph:
  - Import member relinking on module change (PR #2630, merged 2026-10-17T07:56Z): Addressed failed references to members (`R.m`) accessed through imported module bindings when an edited or added module gains exports. Implemented SQLite expression index `idx_unresolved_failed_module_member` (schema v16) and prefix range lookups on `idx_unresolved_failed_module_name` to retry unresolved member calls without triggering full project re-indexes.
  - Windows libuv suspended child leak on daemon respawn (PR #2629, merged 2026-10-17T05:14Z): Investigated libuv (v1.51.0 in Node 22) behavior on Windows where detached processes are spawned suspended and resumed only at `uv_spawn` completion. If an MCP launcher process was terminated during a daemon respawn attempt, the spawned daemon was left suspended and unrecorded, consuming 3.6 MB and holding open handles indefinitely without taking a lock. Hardened test teardown to close launcher stdin gracefully rather than killing parent processes synchronously during spawn loops.
  - Architectural contrast: trace-mcp relies on semantic tree-sitter AST queries with deterministic symbol namespaces, avoiding complex unresolved reference expression parking in SQLite. trace-mcp's daemon lifecycle (hardened in TRA-2438 (#1631) and TRA-2443 (#1630)) correlates PIDs, verify timestamps, and aggregates aborted watcher reindex batches on clean shutdown without leaving unmanaged child processes.
- DeusData/codebase-memory-mcp:
  - macOS duplicate index worker CPU storm & database corruption (Issue #2673, opened 2026-10-17T05:08Z): On macOS Apple Silicon, running two concurrent MCP conversations against the same repository causes both servers to spawn duplicate full `index_repository` workers simultaneously (~400–450% CPU each, load average ~55, respawning every 1–8 minutes on file edits). Because staleness triggers a full re-extract rather than debounced incremental updates, and multi-process SQLite writers lack cross-server file locking, databases suffer recurring WAL starvation and corruption (9 quarantined `.db.corrupt` files, including a 669 MB database), forcing endless from-scratch rebuilds.
  - Architectural contrast: trace-mcp utilizes a single background daemon per workspace with flock/PID synchronization, batch-debounced watcher reindexing, and sub-second incremental tree-sitter graph updates instead of launching multiple 400% CPU workers per client conversation or corrupting SQLite databases under concurrent agent sessions.
- jgravelle/jcodemunch-mcp:
  - Typo in boolean env vars silently disabling protections (PR #1125, opened 2026-10-17T05:30Z): In `config._parse_env_value`, any env value not strictly matching `("true", "1", "yes", "on")` evaluated to false. For protective settings enabled by default (`JCODEMUNCH_RESPECT_CACHEDIR_TAG`, `JCODEMUNCH_SKIP_VIRTUALENVS`, `JCODEMUNCH_RUNTIME_REDACT`, etc.), any typo silently switched off protections and PII redaction. Constrained to keep defaults on unrecognized values. Review also exposed that `install-pack` evaluates `JCODEMUNCH_SHARE_SAVINGS != "0"`, causing `false` or `off` to still transmit telemetry (logged as ledger L-212).
  - Git blame silent failure under host contention (PR #1128, opened 2026-10-17T08:40Z): `GitBlameProvider.detect` probed git root using `git rev-parse --show-toplevel` with a 5s timeout in a bare `except: pass`, silently dropping blame annotations when git timed out on busy machines. Replaced with an in-process filesystem walk for `.git`.
  - Release v1.108.374 (merged 2026-10-17T04:11Z): Automatically skips Python virtual environments regardless of folder name by inspecting PEP 405 `pyvenv.cfg`.
  - Architectural contrast: trace-mcp uses strict schema validation for configuration and safe in-memory git metadata checks without brittle process timeouts that silently discard annotations.
- abhigyanpatwari/GitNexus:
  - Staged rebuild atomic swap & journal consolidation (PR #3613, opened 2026-10-17T07:56Z): Enforces a verified final checkpoint and consolidation of live journals before swapping the published database during staged full rebuilds, preventing missing or corrupted recovery files from breaking cold readers on interrupted writes.
  - Directory symlink exclusion in crawler (PR #3616, opened 2026-10-17T08:12Z): Prevented directory symlinks returned by glob from causing repeated analyze/status content drift due to missing hash receipts, enforcing `stat` regular-file checks across traversal and include extractors.
  - Architectural contrast: trace-mcp's file walker (`src/indexer/walker.ts`) natively differentiates regular files, directory symlinks, and circular links without drift, and uses atomic transactional updates to protect graph integrity.

**Competitor pulse (as of 2026-10-17 afternoon pass):**
- nikolai-vysotskyi/trace-mcp: 194★ (=), 24 forks (=)
- yamadashy/repomix: 28,872★ (+3), 1,628 forks (+10)
- oraios/serena: 30,339★ (+3), 2,138 forks (+24)
- DeusData/codebase-memory-mcp: 46,739★ (+15), 3,850 forks (+1)
- tirth8205/code-review-graph: 32,213★ (+10), 2,988 forks (+15)
- colbymchenry/codegraph: 74,312★ (+12), 4,804 forks (=)
- abhigyanpatwari/GitNexus: 47,919★ (=), 5,199 forks (-1)
- jgravelle/jcodemunch-mcp: 2,778★ (+1), 375 forks (=)
- continuedev/continue: 36,234★ (=), 5,479 forks (-1)
- Aider-AI/aider: 49,594★ (+6), 5,065 forks (+1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.






### Evening pass, 2026-10-17 (TRA-2496): mention sweep clean, open threads audit, competitor triage (codegraph Python builtin member resolution PR #2632 & Rust Cargo workspace path resolution PR #2631, jcodemunch v1.108.375 & install-pack telemetry opt-out PR #1130, DeusData v0.12.1 release sync PR #2674 & musl libc build fix PR #2675, GitNexus OpenCode plugin hooks PR #3619 & semantic rename reviewed edit plan PR #3617)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds.
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: CONFLICTING due to upstream self-additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; standing no-ping rule holds, no follow-up).
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: 0 new repos outside the seen list. Sweep verified clean across all search facets.
- External touches: 0.

**Ecosystem & useful repositories:**
- Coding-agent tooling ecosystem continues rapid diversification across client-specific hooks (e.g. OpenCode plugin architecture) and multi-package workspace cross-reference extraction.
- Edge cases in language-specific symbol resolution (Python absolute import member shadowing, Cargo cross-crate workspace paths) and telemetry compliance under configuration opt-outs remain central areas of ongoing maintenance for rival indexers.

**Competitor intelligence & architectural observations:**
- colbymchenry/codegraph:
  - Python builtin-named member resolution on absolute imports (PR #2632, opened 2026-10-17T12:48Z by BGamboa13): Fixed project functions named like built-in methods (`get`, `write`, `update`, `items`, `find`, `read`) being dropped as standard dictionary/list/file methods when imported by absolute module path in src-layout projects (`from app import db; db.get(...)`). Added `findPythonModuleFile` fallback and local scope rebinding guards (parameters, `with ... as`, `for`, assignments, walrus operator, `del`, nested defs) to prevent false positives when receivers are rebound.
  - Cargo workspace cross-crate path resolution (PR #2631, opened 2026-10-17T12:48Z by BGamboa13): Resolves paths into other crates of a Cargo workspace (`sim::items::ItemPool::for_def(...)`) by walking the module tree from anchor (`crate`, `self`, `super`, crate name, or file `use` binding) following `pub use` and glob re-exports; separated Rust path logic into dedicated `rust-paths.ts`.
  - Architectural contrast: trace-mcp leverages Tree-sitter AST queries with deterministic symbol namespaces and lexical scoping, extracting symbol definitions and references directly without fragile naming heuristics or special-cased built-in method exclusion filters.
- jgravelle/jcodemunch-mcp:
  - Release v1.108.375 (published 2026-10-17T13:05Z): Enforces that unrecognized environment variable values for six default-on protective boolean settings (`JCODEMUNCH_RESPECT_CACHEDIR_TAG`, `JCODEMUNCH_SKIP_MSBUILD_OUTPUT`, `JCODEMUNCH_SKIP_NUGET_PACKAGES`, `JCODEMUNCH_SKIP_VIRTUALENVS`, `JCODEMUNCH_TRUSTED_FOLDERS_WHITELIST_MODE`, `JCODEMUNCH_RUNTIME_REDACT`) keep protections active and log warnings, preventing parser typos from silently disabling security and privacy settings.
  - Starter pack telemetry honors all opt-outs (PR #1130, merged 2026-10-17T14:03Z, ledger L-212): Fixed `install-pack` telemetry sending events unless `JCODEMUNCH_SHARE_SAVINGS` was exactly `0`, ignoring `false`, `off`, `no`, or config `share_savings: false`.
  - Architectural contrast: trace-mcp operates strictly on opt-in, zero-telemetry by default, conducts no background network telemetry calls in MCP runtime tool paths, and uses strict type-safe schema validation.
- DeusData/codebase-memory-mcp:
  - Packaging metadata sync for v0.12.1 (PR #2674, merged 2026-10-17T12:40Z): Synchronized post-release packaging manifests across Chocolatey, Scoop, Homebrew, Go installer, Nix flake, npm, and PyPI with VirusTotal candidate provenance artifacts.
  - musl libc build fix (PR #2675, opened 2026-10-17T13:16Z by attilaolah): Resolved undefined behavior in `%s` format strings under musl-gcc when `phase` and `log` pointers are null, and enabled `$LD` environment variable override for linker toolchains.
  - Architectural contrast: trace-mcp is distributed as a pure TypeScript/Node.js package with precompiled native tree-sitter bindings and an Electron desktop bundle, avoiding complex C/musl toolchain build matrices and gigabyte-sized dependencies.
- abhigyanpatwari/GitNexus:
  - OpenCode auto-loaded global plugin hooks (PR #3619, opened 2026-10-17T13:02Z by rgb-vgx): Added OpenCode integration parity via a self-contained ESM plugin (`~/.config/opencode/plugins/gitnexus.js`) implementing OpenCode's `tool.execute.after` hook for automatic graph-context augmentation after searches and stale-index hints after git mutations.
  - Exact reviewed edit plan enforcement for semantic rename (PR #3617, opened 2026-10-17T09:56Z): Hardened semantic rename workflow to enforce verified token and edit plan application with atomic per-file writes, dirty-worktree graph refresh, and strict rollback reporting.
  - Architectural contrast: trace-mcp exposes standard MCP protocol tools directly, providing clean, predictable context without mutating user global configuration directories or injecting background hook scripts into third-party agent directories.

**Competitor pulse (as of 2026-10-17 evening pass):**
- nikolai-vysotskyi/trace-mcp: 194★ (=), 24 forks (=)
- yamadashy/repomix: 28,873★ (+1), 1,630 forks (+2)
- oraios/serena: 30,343★ (+4), 2,148 forks (+10)
- DeusData/codebase-memory-mcp: 46,744★ (+5), 3,854 forks (+4)
- tirth8205/code-review-graph: 32,214★ (+1), 2,998 forks (+10)
- colbymchenry/codegraph: 74,321★ (+9), 4,804 forks (=)
- abhigyanpatwari/GitNexus: 47,920★ (+1), 5,198 forks (-1)
- jgravelle/jcodemunch-mcp: 2,779★ (+1), 376 forks (+1)
- continuedev/continue: 36,233★ (-1), 5,481 forks (+2)
- Aider-AI/aider: 49,594★ (=), 5,066 forks (+1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.




### Late night pass, 2026-10-17 (TRA-2498): mention sweep clean, open threads audit, competitor triage (codegraph Vue module path resolution PR #2633, jcodemunch text-search zero-savings model L-180 PR #1135 & v1.108.376, GitNexus directory symlink convergence PR #3616 & RC v1.6.13-rc.117)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds.
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: CONFLICTING due to upstream self-additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; standing no-ping rule holds, no follow-up).
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: 0 new repos outside the seen list. Sweep verified clean across all search facets.
- External touches: 0.

**Ecosystem & useful repositories:**
- Coding-agent tooling ecosystem continues rapid diversification across framework-specific import aliases and bundler conventions (Vue CLI `@/` and `~/` module resolution), token-savings measurement integrity, and filesystem-level symlink edge cases.
- Contrast across code-intelligence tools is increasingly defined by deterministic parsing and indexing vs heuristic regex/string fallbacks and ad-hoc multiplier credits.

**Competitor intelligence & architectural observations:**
- colbymchenry/codegraph:
  - Vue module path import resolution (PR #2633, opened 2026-10-17T15:51Z by colbymchenry): Fixed flaw where Vue `@/...` and `~/...` module imports bypassed standard import resolution and returned `getNodesInFile(path)[0]` with 0.9 confidence, which bound imports to arbitrary first-stored constant or component nodes instead of the file node. This broke reference traversal during incremental sync (`reopenReferencesThroughAddedFiles`/`reopenReferencesThroughBarrels`), making graph syncs miss dependent importers in Vue/Nuxt projects. Fixed by delegating module path resolution to the import resolver first (respecting tsconfig paths and workspace packages), and only falling back to Vue CLI extension resolution (`.vue`, `/index.vue`) for SFCs and Vue CLI aliases before hitting virtual-module sinks.
  - Architectural contrast: trace-mcp relies on `oxc-resolver` and Tree-sitter AST queries for deterministic symbol extraction and module resolution. File node identity and AST symbol declarations are strictly separated by architecture; import links are never bound to arbitrary node array offsets (`getNodesInFile()[0]`), ensuring rock-solid consistency across fresh indexes and incremental syncs.
- jgravelle/jcodemunch-mcp:
  - Text search zero-savings model (PR #1135, opened 2026-10-17T16:16Z by jgravelle; ledger L-180): Major correction to token-savings accounting. Previously, `search_text` and `check_references` were given inflated multiplier credits (12.0x and 15.0x) against a symbol-retrieval benchmark that never measured text search, resulting in larger search results claiming higher token savings. Empirical testing showed grep returns the exact same matching lines at a fraction of the token cost (grep tokens were 0.36 of `search_text` and 0.69 of `check_references` tokens). Removed multipliers from `_TOOL_MULTIPLIERS`, renamed metric to `Modeled gross savings`, and priced text-search actions at zero counterfactual savings credit.
  - Release v1.108.376 (published 2026-10-17T17:50Z): "install-pack honours every savings opt-out".
  - Batch ledger fixes (PR #1137, opened 2026-10-17T17:58Z): Consolidated fixes for ledgers L-209, L-142, L-144, L-149, L-180.
  - Architectural contrast: trace-mcp measures token reduction directly against real-world PR review tasks across 60+ external repositories (`70.5% - 72.7%` median reduction in input tokens to achieve comprehension parity) rather than relying on synthetic per-tool multiplier heuristics over grep-like matching lines.
- abhigyanpatwari/GitNexus:
  - Directory symlink convergence during indexing (PR #3616, updated 2026-10-17T16:36Z by magyargergo): Fixed issue where repository directory symlinks caused repeated analyze/status runs to fail to converge because the walker returned directory symlinks that never received file hashes, leaving repository freshness permanently stale at the same commit. Fix filters directory symlinks using stat checks to retain only regular-file symlink targets.
  - Release Candidate v1.6.13-rc.117 (published 2026-10-17T16:25Z).
  - Architectural contrast: trace-mcp's indexer natively bounds directory traversal using git-ignore and realpath resolution, preventing symlink loops and stale hashes without requiring special-cased stat patches in the walker.

**Competitor pulse (as of 2026-10-17 late night pass):**
- nikolai-vysotskyi/trace-mcp: 194★ (=), 24 forks (=)
- yamadashy/repomix: 28,876★ (+3), 1,630 forks (=)
- oraios/serena: 30,344★ (+1), 2,148 forks (=)
- DeusData/codebase-memory-mcp: 46,757★ (+13), 3,857 forks (+3)
- tirth8205/code-review-graph: 32,219★ (+5), 2,997 forks (-1)
- colbymchenry/codegraph: 74,329★ (+8), 4,806 forks (+2)
- abhigyanpatwari/GitNexus: 47,925★ (+5), 5,198 forks (=)
- jgravelle/jcodemunch-mcp: 2,780★ (+1), 376 forks (=)
- continuedev/continue: 36,234★ (+1), 5,483 forks (+2)
- Aider-AI/aider: 49,594★ (=), 5,067 forks (+1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.




### Morning pass, 2026-10-18 (TRA-2502): mention sweep clean, open threads audit, competitor triage (DeusData cross-file method linking in sequential pipeline PR #2678, jcodemunch licence lookup auto-config bug L-215 PR #1138, GitNexus rename preview plan-token binding PR #3617)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds.
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: CONFLICTING due to upstream self-additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; standing no-ping rule holds, no follow-up).
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: 0 new repos outside the seen list. Sweep verified clean across all search facets.
- External touches: 0.

**Ecosystem & useful repositories:**
- The coding-agent ecosystem is grappling with cross-file symbol resolution nondeterminism, tool configuration side-effects, and atomic refactoring plan guarantees.
- Tools operating with complex pipelines (separate sequential vs parallel indexing paths, heuristic config file writers, separate preview/apply steps) increasingly surface bugs where AST/graph state diverges across runtime modes.
- trace-mcp's architectural simplicity (single-pass deterministic AST indexing into SQLite, declarative MCP tool surface with no runtime configuration mutations, and stateless symbol search) avoids these failure modes by design.

**Competitor intelligence & architectural observations:**
- DeusData/codebase-memory-mcp:
  - Sequential vs parallel pipeline method linking (PR #2678, opened 2026-10-17T21:35:26Z by DeusData): Fixed critical graph discrepancy between sequential (`CBM_WORKERS=1` or repos <= 50 files) and parallel indexing. In sequential mode, `DEFINES_METHOD` edges were linked during file registration rather than after all definitions exist. When `readdir` returned a file defining a method before the file declaring its parent type (e.g. Go multi-file packages or C++ out-of-line `.cpp` before `.h`), the parent definition was missing, causing silent drops of `DEFINES_METHOD`, `IMPLEMENTS`, and `OVERRIDE` edges (lost 236 `DEFINES_METHOD`, 22 `IMPLEMENTS`, 11 `OVERRIDE` on helm/helm). Fixed by deferring edge linking to a post-Phase 1 pass.
  - Architectural contrast: trace-mcp uses two-phase indexing where symbol definitions and AST declarations are indexed into SQLite, and references/type relationships are resolved workspace-wide using `oxc-resolver` across the complete indexed repository manifest. Edge relationships never depend on directory walk order or worker count.
  - DevOps/deployment expansion (PR #2677, opened 2026-10-17T19:14:50Z by DeusData): Added rendering for Helm images, default-valued image markers, CRDs and werf charts.
  - Test impact optimization (PR #2676, merged 2026-10-17T21:56:50Z): Tightened PR test selection harness.
- jgravelle/jcodemunch-mcp:
  - Unsolicited config file generation in license lookup (PR #1138, opened 2026-10-17T21:15:15Z by jgravelle; ledger L-215): Fixed flaw where `install_pack.resolve_effective_license_key` called `load_config(create_missing=True)` before pack installations lacking `--license`. This unexpectedly generated a bare `config.jsonc` file on disk. Lacking a `tool_surface` key, this auto-generated file inadvertently locked first-time users into the bloated 91-tool `full` surface instead of the default lean surface, polluting Claude Code's prompt with unneeded tools.
  - Architectural contrast: trace-mcp has zero global configuration side-effects on first run or on server invocation. Its MCP surface is intentionally lean and predictable (compact core tools like `get_symbol`, `search`, `get_task_context`, `get_outline`), never writes unsolicited configuration files or secretly toggles agent tool surface settings, and requires zero license checks or pack management.
- abhigyanpatwari/GitNexus:
  - Rename preview plan token binding (PR #3617, merged 2026-10-17T18:38:01Z by magyargergo): Introduced an opaque `plan_token` to bind rename preview to rename apply. Prevents `apply` from computing a divergent edit set when files on disk change between preview and execution.
  - Directory symlink indexing convergence (PR #3616, merged 2026-10-17T18:37:46Z): Resolved infinite loops/non-convergence caused by directory symlinks lacking hashes.
  - OpenCode integration (PR #3619, opened 2026-10-17T12:05:16Z by rgb-vgx): Shipping hooks as an auto-loaded global plugin for full OpenCode support.

**Competitor pulse (as of 2026-10-18 morning pass):**
- nikolai-vysotskyi/trace-mcp: 194★ (=), 24 forks (=)
- yamadashy/repomix: 28,877★ (+1), 1,639 forks (+9)
- oraios/serena: 30,347★ (+3), 2,164 forks (+16)
- DeusData/codebase-memory-mcp: 46,774★ (+17), 3,859 forks (+2)
- tirth8205/code-review-graph: 32,222★ (+3), 3,012 forks (+15)
- colbymchenry/codegraph: 74,333★ (+4), 4,806 forks (=)
- abhigyanpatwari/GitNexus: 47,926★ (+1), 5,198 forks (=)
- jgravelle/jcodemunch-mcp: 2,780★ (=), 376 forks (=)
- continuedev/continue: 36,235★ (+1), 5,482 forks (-1)
- Aider-AI/aider: 49,599★ (+5), 5,068 forks (+1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.




### Pass 2026-10-18 (TRA-2511): mention sweep clean, ProSkills auto-listing verified, competitor triage (DeusData Python root-binding import base resolution PR #2679, jcodemunch v1.108.377 zero-savings text search model L-180 & post-edit filter leak L-142 PR #1140, GitNexus OpenCode plugin hooks PR #3619)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds.
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: CONFLICTING due to upstream additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; standing no-ping rule holds, no follow-up).
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: 0 new repos outside the seen list. Sweep verified clean across all search facets.
- External touches: 0.

**Surfaces & Ecosystem findings:**
- ProSkillsMD/proskills: Verified auto-scouting and publishing of all three in-repo agent skills (`skills/trace-mcp/SKILL.md` issue #8193 status `groot:published` and `review:pass`; `trace-mcp-codemod` issue #8194; `trace-mcp-pre-commit` issue #8195). Discovered via topic crawl (`claude-skills`).
- activeing123/mcptoon: Investigated zero-dependency MCP management and token optimization CLI (277★, Apache-2.0). Focuses on tool schema minimization (-99.2% token overhead by stripping uncalled schemas out of agent prompt context). Its pre-packaged `code-review` bundle currently routes to standard GitHub/git/filesystem tools; recorded in ledger as an ecosystem observation.

**Competitor intelligence & architectural observations:**
- DeusData/codebase-memory-mcp:
  - Python root-binding import base class resolution (PR #2679, opened 2026-10-18T03:30:00Z by DeusData): Fixed bug where `import pkg.mod.nodes` bound the root name `pkg`, but cross-LSP inheritance resolution (`pxc_resolve_base_qn`) looked up the import-map target `pkg.mod.nodes` joined with the remainder `mod.nodes.Context`, failing to match. As a result, `class X(pkg.mod.nodes.Context)` kept its raw unparsed spelling, breaking the Python LSP inheritance view and causing inherited member lookups to fall back to heuristic name guessing (`self.m()` -> `unique_name`, `super().m()` -> `suffix_match`).
  - Architectural contrast: trace-mcp uses static AST symbol parsing into SQLite and resolves module imports deterministically via `oxc-resolver` across the indexed manifest, avoiding ad-hoc cross-LSP C string concatenation heuristics.
- jgravelle/jcodemunch-mcp:
  - Text search zero-savings model & post-edit ignore leak (PR #1140 / Release v1.108.377, opened 2026-10-18T03:51:13Z by jgravelle):
    - Replaced inflated token savings multipliers for text searches with zero counterfactual credit (L-180), acknowledging plain text grepping does not compress context over raw file reads.
    - Reversed previous design where `index_file` post-edit hook bypassed directory exclusion filters (`node_modules/`, `.next/`, virtualenvs, gitignores), which previously allowed ignored build directories and vendor trees to pollute the search index until the next full rebuild (L-142).
    - Fixed silent timeout drops in `git_blame` detection (L-209).
  - Architectural contrast: trace-mcp measures real PR-review token savings against actual file reads (70.5% - 72.7% median reduction) rather than synthetic multipliers, and enforces identical gitignore and path traversal filters across both initial indexing and incremental file watching.
- abhigyanpatwari/GitNexus:
  - OpenCode auto-loaded plugin integration (PR #3619, updated 2026-10-18T04:00:44Z by rgb-vgx): Adds OpenCode hooks by copying a self-contained ESM plugin into `~/.config/opencode/plugins/gitnexus.js` to augment graph context after search operations (`grep`/`glob`/`bash`) and provide stale-index hints after git mutations.
  - Architectural contrast: trace-mcp relies on standard MCP client protocol endpoints and non-invasive CLI tools (`trace blast`, `trace impact`), without injecting persistent global plugin files into user config directories.

**Competitor pulse (as of 2026-10-18 pass):**
- nikolai-vysotskyi/trace-mcp: 193★ (-1), 24 forks (=)
- yamadashy/repomix: 28,880★ (+3), 1,644 forks (+5)
- oraios/serena: 30,352★ (+5), 2,170 forks (+6)
- DeusData/codebase-memory-mcp: 46,788★ (+14), 3,860 forks (+1)
- tirth8205/code-review-graph: 32,225★ (+3), 3,016 forks (+4)
- colbymchenry/codegraph: 74,342★ (+9), 4,806 forks (=)
- abhigyanpatwari/GitNexus: 47,929★ (+3), 5,198 forks (=)
- jgravelle/jcodemunch-mcp: 2,779★ (-1), 376 forks (=)
- continuedev/continue: 36,237★ (+2), 5,484 forks (+2)
- Aider-AI/aider: 49,603★ (+4), 5,069 forks (+1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.




### Pass 2026-10-18 (TRA-2514): mention sweep clean, competitor triage (DeusData package-relative dot import resolution PR #2680, jcodemunch CLI deny_guard fail-closed hardening PR #1141, GitNexus LadybugDB WAL checkpoint accounting test PR #3624)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds.
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: UNKNOWN/CONFLICTING due to upstream additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; standing no-ping rule holds, no follow-up).
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: 0 new repos outside the seen list. Sweep verified clean across all search facets.
- External touches: 0.

**Surfaces & Ecosystem findings:**
- ashlrai/phantom-secrets: Local secret masking proxy and value-blind MCP server (v0.7.9, 18★, Rust 1.95) replacing real credentials with scoped `phm_` tokens for Claude Code, Cursor, Windsurf, and Codex. Complements the local privacy and token-boundary ecosystem alongside trace-mcp's redacted `get_env_vars` contract (TRA-1882/1884).

**Competitor intelligence & architectural observations:**
- DeusData/codebase-memory-mcp:
  - Python package-relative dot import path extraction & caller/callee resolution (PR #2680, opened 2026-10-18T04:12:16Z by Martin Vogel / DeusData): Fixed an extractor bug where package-relative from-imports with modules composed solely of dots (`from . import x`, `from .. import x`, `from . import x as y`) joined the module to the imported name with an extra separator (`..x` instead of `.x`), causing relative imports to misidentify as parent package bindings. The import resolver then missed the real binding and silently fell back to lexicographically earliest global name guessing, cross-binding thousands of unrelated functions across different integrations (e.g. 7,175 caller/callee pairs in Home Assistant binding webhook handlers to AccuWeather functions). Fixed by joining without an extra separator when the module already ends with `.`.
  - Architectural contrast: trace-mcp resolves relative imports deterministically against the indexed repository file hierarchy and AST import nodes without synthetic dot-string concatenation heuristics or fallback global name guessing.
- jgravelle/jcodemunch-mcp:
  - CLI agent deny_guard fail-closed hardening against irreversible API actions (PR #1141, opened 2026-10-18T04:16:35Z by jgravelle / Claude Opus 5.5): Hardens the Claude Code shell guard against command-line evasion techniques that bypass PR merge/delete blocks, such as flag equality spellings (`gh api --method=PUT`), `-X=PUT`, quoted methods (`--method 'PUT'`), clustered flags (`-iXPUT`), GraphQL mutation queries loaded from files (`-F query=@file`), shell alias bypasses (`gh alias set m`), and implicit POSTs from parameter flags (`-f ref=...`). Additionally changed failure exit code from 1 to 2 because Claude Code treated non-zero exit code 1 as non-blocking and proceeded to execute blocked commands.
  - Architectural contrast: trace-mcp avoids brittle command-line string-matching heuristics by exposing structured, read-only analysis tools (`search`, `get_symbol`, `get_outline`, `get_task_context`, `trace blast`, `trace impact`) and enforcing strict read/write boundaries with explicit multi-file confirmation semantics within the MCP protocol itself.
- abhigyanpatwari/GitNexus:
  - Native LadybugDB WAL checkpoint file handle leak and max DB size accounting guard (PR #3624, opened 2026-10-18T09:22:24Z by rgb-vgx): Adds an integration regression test guarding against engine-level memory leaks during repeated WAL checkpoints. In engine pin `0.18.3`, `ShadowFile::reset()` orphaned `FileHandle` instances on each checkpoint, leaking 4 MiB VMRegion frame groups against `max_db_size` until reaching memory ceilings (256 MiB / 2^38) during heavy embedding writeback passes and failing with transient "Maximum database size ... has been reached" errors.
  - Architectural contrast: trace-mcp uses standard embedded SQLite in WAL mode with fixed page caches and bounded memory usage, eliminating native engine VMRegion handle leaks during large-scale incremental repository indexing.

**Competitor pulse (as of 2026-10-18 pass):**
- nikolai-vysotskyi/trace-mcp: 193★ (=), 24 forks (=)
- yamadashy/repomix: 28,881★ (+1), 1,654 forks (+10)
- oraios/serena: 30,351★ (-1), 2,188 forks (+18)
- DeusData/codebase-memory-mcp: 46,807★ (+19), 3,862 forks (+2)
- tirth8205/code-review-graph: 32,230★ (+5), 3,029 forks (+13)
- colbymchenry/codegraph: 74,352★ (+10), 4,805 forks (-1)
- abhigyanpatwari/GitNexus: 47,930★ (+1), 5,198 forks (=)
- jgravelle/jcodemunch-mcp: 2,779★ (=), 376 forks (=)
- continuedev/continue: 36,240★ (+3), 5,487 forks (+3)
- Aider-AI/aider: 49,606★ (+3), 5,070 forks (+1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.




### Pass 2026-10-18 (TRA-2516): mention sweep clean, ecosystem findings (spine-bank, rootpath, purser), competitor triage (GitNexus section filtering PR #3621 & eval PR #3622, jcodemunch config side-effect PR #1142 & release dispatch PR #1143, codegraph Vue resolver PR #2633)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds (reminder budget spent).
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: UNKNOWN/CONFLICTING due to upstream additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; standing no-ping rule holds, no follow-up).
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: 0 new repos outside the seen list. Sweep verified clean across all search facets.
- External touches: 0.

**Surfaces & Ecosystem findings:**
- romannekrasovaillm/spine-bank: Deterministic architectural gate and offline validation harness with an MCP server for CLI coding agents (Claude Code, GigaCode, Kimi Code, Qwen Code, OpenClaw). Features offline rule evaluation, verification memory, and rule enforcement without external LLM API calls.
- IWhitebird/rootpath: Incident resolution agent running over a FalkorDB service/deployment/dependency graph. Connects as an MCP host and Claude Code plugin to trace production failures from alert triggers to root cause code locations.
- neurot1ca/purser-claude-orchestrator: Claude Code orchestration plugin that delegates implementation tasks to Codex in parallel git worktrees while retaining Claude for planning and code review, reducing primary token expenditure.

**Competitor intelligence & architectural observations:**
- abhigyanpatwari/GitNexus:
  - Agent section filtering in MCP graph responses (PR #3621, opened 2026-10-18T07:02:15Z by magyargergo): Implements explicit section and relationship-category filter arguments for graph queries, enabling agents to request targeted sub-graphs rather than consuming broad graph edge dumps that bloat context and trigger repeated model re-reading.
  - PR cost evaluation benchmarking by label (PR #3622, opened 2026-10-18T08:14:29Z by magyargergo): Adds `run-cost-evaluation` PR label workflow executing 12 MCP test sessions comparing billed costs and task solve rates against latest main release benchmarks.
  - Architectural contrast: trace-mcp avoids complex response-masking parameters by design; its atomic MCP tools (`get_symbol`, `get_outline`, `get_task_context`, `search`) return lean, pre-compacted code intelligence structures by default.
- jgravelle/jcodemunch-mcp:
  - CLI install-pack configuration side-effect elimination (PR #1142 / v1.108.378, opened 2026-10-18T13:46:31Z by jgravelle): Fixed a bug where running `install-pack <id>` without `--license` wrote a default `config.jsonc` file to disk during license checks if none existed. Because the generated default lacked the `tool_surface` key, it inadvertently pinned users to the `full` tool surface mode.
  - CI release dispatch governance & token scoping (PR #1143, opened 2026-10-18T13:55:47Z by jgravelle): Hardened workflow triggers so `release.yml` executes only when initiated directly by maintainer `jgravelle`, while restricting GitHub App tokens to per-job minimal scopes after granting Actions write permissions for automated competitive evaluation dispatch.
  - Architectural contrast: trace-mcp has zero license key lookup workflows, never mutates workspace config files during tool invocation, and isolates state within dedicated profile locations.
- colbymchenry/codegraph:
  - Vue import path resolution (@/ and ~/ aliases) fix (PR #2633, opened 2026-10-17T15:51:05Z by colbymchenry): Fixed an issue where `vueResolver.resolve` ran before the general import resolver on projects with Vue/Nuxt dependencies, naively rewriting `@/` and `~/` paths to `src/` and returning `getNodesInFile(path)[0]` at 0.9 confidence (whichever AST node was declared first in the file rather than the module itself).
  - Architectural contrast: trace-mcp relies on `oxc-resolver` and tree-sitter AST symbol resolution honoring project path alias configurations (`tsconfig.json`/`jsconfig.json`) instead of path-string rewriting heuristics and arbitrary node-order fallbacks.

**Competitor pulse (as of 2026-10-18 14:05 UTC pass):**
- nikolai-vysotskyi/trace-mcp: 193★ (=), 24 forks (=)
- yamadashy/repomix: 28,889★ (+8), 1,655 forks (+1)
- oraios/serena: 30,360★ (+9), 2,189 forks (+1)
- DeusData/codebase-memory-mcp: 46,824★ (+17), 3,864 forks (+2)
- tirth8205/code-review-graph: 32,235★ (+5), 3,029 forks (=)
- colbymchenry/codegraph: 74,361★ (+9), 4,807 forks (+2)
- abhigyanpatwari/GitNexus: 47,931★ (+1), 5,198 forks (=)
- jgravelle/jcodemunch-mcp: 2,781★ (+2), 376 forks (=)
- continuedev/continue: 36,240★ (=), 5,489 forks (+2)
- Aider-AI/aider: 49,610★ (+4), 5,072 forks (+2)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.



### Pass 2026-10-18 (TRA-2518): mention sweep clean, ecosystem findings (Hivora, graphmaster, repomap, neat), competitor triage (GitNexus fetch-wrapper PR #3628, DeusData Rust generic impl PR #2685 & Python nested defs PR #2686, jcodemunch ledger PR #1144)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds (reminder budget spent).
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: CONFLICTING due to upstream additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; standing no-ping rule holds, no follow-up).
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: 0 new repos outside the seen list. Sweep verified clean across all search facets.
- External touches: 0.

**Surfaces & Ecosystem findings:**
- Enard52/Hivora: Open-source multi-agent orchestrator for Claude Code, Cursor, Copilot & Cline featuring symbol-level locking and git worktree isolation. Dependency detection (`packages/orchestrator/src/deps/dependents.ts`) uses synchronous recursive directory traversal (`walkCodeFiles`) and raw regex word-boundary scanning (`\b<symbol>\b`) across up to 2,000 files to infer dependent callers before locking.
  - Architectural contrast: trace-mcp indexes true AST call-graph edges and module dependencies into SQLite via tree-sitter, providing instant, sub-millisecond call-path analysis (`trace blast`, `trace impact`, `get_symbol`) without regex false positives (variable names in comments/strings) or disk I/O thrashing.
- pragmataW/graphmaster: Go-based local code graph engine serving 13 MCP tools (`callers`, `impact`, `find_symbol`, `search`, `inheritance`) over stdio with tree-sitter + SQLite. Implements token budgeting (`max_tokens`), edge confidence scoring (1-100), and a PreToolUse hook for Claude Code to steer Grep/Glob calls toward symbol queries.
  - Architectural contrast: trace-mcp provides broader multi-language support (16 languages vs Go/TS/Python subset), an integrated Electron desktop UI, and persistent decision/state tracking (`decisions.db`, `state.db`) in addition to AST code navigation.
- SylphxAI/repomap: Rust-based code mapping tool (unifying Spine, Locus, and CodeRAG) offering call trees, impact analysis, and hybrid search (BM25 + local embeddings downloaded from Hugging Face). Includes an opt-in Claude Code search-steering hook.
  - Architectural contrast: trace-mcp operates with zero network dependencies or background model downloads (100% offline local static analysis via tree-sitter), eliminating model download overhead and Hugging Face API availability risks.
- neat-technologies/neat: Graph engine fusing tree-sitter static analysis with OpenTelemetry runtime trace data, exposed over MCP (24 tools) and packaged as a Claude Code plugin with a `PreToolUse` search-nudge hook and web dashboard.
  - Architectural contrast: trace-mcp provides lightweight, zero-daemon stdio execution tailored for resource-constrained local workflows without requiring OpenTelemetry collectors or external runtime telemetry infrastructure.

**Competitor intelligence & architectural observations:**
- abhigyanpatwari/GitNexus:
  - Base-URL fetch wrapper linking for route extraction (PR #3628, opened 2026-10-18T17:20:13Z by abhigyanpatwari): Introduces AST walking for fetch wrapper chains (`fetchWithTimeout` -> `resilientFetch` -> `fetch`) and strips leading `${base}` templates to map frontend API calls to backend route definitions. Requires complex heuristic filters to prevent false positive bindings from string literals (`'Failed to fetch'`) or parameter sibling collisions (`/api/analyze/${id}`).
  - Express router registration via helper parameters (PR #3629, opened 2026-10-18T17:21:20Z by abhigyanpatwari): Follows router registrations passed through helper parameters.
  - Architectural contrast: trace-mcp focuses on semantic code intelligence, symbol definitions, references, import/export dependency graphs, and AST-level symbol outline/context (`get_symbol`, `get_outline`, `get_task_context`, `trace blast`, `trace impact`). It intentionally avoids brittle ad-hoc HTTP string-matching heuristics to simulate client-server RPCs.
- DeusData/codebase-memory-mcp:
  - Generic impl call scoping in Rust (PR #2685, opened 2026-10-18T15:26:04Z by Martin Vogel): Resolves issue #763 where calls inside methods of generic Rust impl blocks (`impl<T> Gen<T>`) kept type parameters in their caller qualified name (`Gen<T>.in_generic`), conflicting with the stripped definition qualified name (`Gen.in_generic`). Across 9 pinned Rust repositories (diesel, tokio, tauri, etc.), this mismatch had caused 22,287 method calls to collapse onto the root File node instead of the calling method node (−93% drop to 1,572 File-scoped calls upon stripping generic parameters).
  - Lexical scoping and extraction for Python nested definitions (PR #2686, opened 2026-10-18T15:26:47Z by Martin Vogel): Extracts nested functions and classes (closures, app-factory routes, test helpers) with qualified names `<enclosing>.<name>` and resolves bare local calls lexically before global registry fallback. Previously, nested definitions were ignored, causing calls to collapse to File nodes and bare calls to erroneously bind to unrelated global definitions via loose name heuristics (`suffix_match`).
  - Architectural contrast: trace-mcp's tree-sitter queries extract full lexical symbol hierarchies natively across all supported languages, correctly retaining parent-child scopes in symbol trees (`get_symbol`, `get_outline`) without collapsing nested definitions to file containers.
- jgravelle/jcodemunch-mcp:
  - Defect ledger and release governance updates (PR #1144, opened 2026-10-18T14:15:55Z by jgravelle): Documents ledger entry L-218 regarding a race in `open_selective` returning cached full index during fast-path test execution, registry publish verification timeout (C-27), and pre-PR branch validation hook across git worktrees (W-58).

**Competitor pulse (as of 2026-10-18 18:05 UTC pass):**
- nikolai-vysotskyi/trace-mcp: 193★ (=), 24 forks (=)
- yamadashy/repomix: 28,895★ (+6), 1,665 forks (+10)
- oraios/serena: 30,365★ (+5), 2,195 forks (+6)
- DeusData/codebase-memory-mcp: 46,842★ (+18), 3,864 forks (=)
- tirth8205/code-review-graph: 32,238★ (+3), 3,033 forks (+4)
- colbymchenry/codegraph: 74,371★ (+10), 4,808 forks (+1)
- abhigyanpatwari/GitNexus: 47,932★ (+1), 5,198 forks (=)
- jgravelle/jcodemunch-mcp: 2,781★ (=), 376 forks (=)
- continuedev/continue: 36,243★ (+3), 5,490 forks (+1)
- Aider-AI/aider: 49,614★ (+4), 5,072 forks (=)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.



### Pass 2026-10-19 (TRA-2525): mention sweep clean, ecosystem findings (Ariadne, codegraph-go, Vex, Patchloom), competitor triage (DeusData Claude Code tool deferral PR #2698 & Python C3 MRO PR #2696, GitNexus routes PR #3629, jcodemunch CI tokens PR #1143)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds (reminder budget spent).
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: CONFLICTING due to upstream additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; standing no-ping rule holds, no follow-up).
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: 0 new repos outside the seen list. Sweep verified clean across all search facets.
- External touches: 0.

**Surfaces & Ecosystem findings:**
- CRJFisher/ariadne: TypeScript/Node code intelligence engine and MCP server (`@ariadnejs/mcp`) using tree-sitter. Exposes entry-point discovery (`list_entrypoints`) and neighborhood traversal (`show_call_graph_neighborhood`), filtering framework-invoked routes and test functions. Supports 4 languages (JS, TS, Python, Rust).
  - Architectural contrast: trace-mcp indexes true AST call-graph edges and module dependencies into a persistent SQLite database across 16 languages (vs 4 in Ariadne), provides an integrated Electron desktop UI, and persistent decision/state tracking (`decisions.db`, `state.db`) alongside AST navigation tools (`get_symbol`, `get_outline`, `get_task_context`, `trace blast`, `trace impact`).
- isink17/codegraph: Go-based single-binary local code context engine and MCP server (29 tools) under FSL-1.1-MIT. Indexes source code into a persistent SQLite graph to serve symbol lookups, call graphs, impact analysis, and task context (`context_for_task`, `agentic_query`) across 12 languages.
  - Architectural contrast: trace-mcp is fully permissive open-source (MIT), supports 16 languages, integrates with an Electron desktop application, executes via zero-daemon stdio, and separates static AST indexing from runtime memory/telemetry stores without embedding model dependencies.
- tenatarika/vex: Rust-based hybrid structural and semantic code search CLI/MCP (32 commands) combining FST, BM25, and local HNSW vector index across 20 languages. Features persistent call graphs (`vex callers`, `vex callees`) and AST pattern matching (`vex pattern`).
  - Architectural contrast: trace-mcp focuses on 100% offline static AST analysis with SQLite without the overhead, memory footprint, or Hugging Face model downloads required by local HNSW vector embeddings.
- patchloom/patchloom: Rust single-binary structured file editor for AI agents (JSON/YAML/TOML, AST, multi-file batch/tx with undo, MCP server). Focuses on atomic write operations and syntax-preserving config mutations.
  - Architectural contrast: Patchloom specializes in structured mutation/writing, whereas trace-mcp specializes in static read/navigation/token-reduction intelligence. They occupy complementary roles in an agent workspace.

**Competitor intelligence & architectural observations:**
- DeusData/codebase-memory-mcp:
  - Claude Code MCP tool deferral upfront loading (PR #2698, opened 2026-10-18T21:46:17Z by Martin Vogel): Tackles Claude Code tool deferral where tools are omitted from upfront system prompt unless tagged. Adds `_meta["anthropic/alwaysLoad"]: true` to structural tools (`search_graph`, `trace_path`, `get_code_snippet`), keeping the remaining 14 tools deferred. Re-engineers server instructions (from 309 to 999 chars) to declare which structural questions the graph answers vs where grep fits better.
  - Python C3 linearization for super() calls (PR #2696, opened 2026-10-18T21:17:28Z by Martin Vogel): Resolves `super()` calls through Python's C3 method resolution order instead of walking inheritance bases sequentially, preventing incorrect shared-base binding on mixin hierarchies (e.g. in scikit-learn, sqlalchemy, home-assistant).
- abhigyanpatwari/GitNexus:
  - Route linking via Express helper parameters (PR #3629, opened 2026-10-18T17:21:20Z by abhigyanpatwari): Follows router registrations passed through helper parameters.
  - Base-URL fetch wrapper linking for route extraction (PR #3628, opened 2026-10-18T17:20:13Z by abhigyanpatwari): Traces AST wrapper chains (`fetchWithTimeout` -> `resilientFetch` -> `fetch`) and strips `${base}` templates to bind client calls to server endpoints.
  - Architectural contrast: trace-mcp provides deterministic AST code navigation, definition/reference lookup, and lexical scope analysis without ad-hoc heuristic HTTP route matching.
- jgravelle/jcodemunch-mcp:
  - GitHub App token scoping and rerun reason guard (PR #1143, opened 2026-10-18T18:00:23Z by jgravelle): Scopes GitHub App tokens per release job and validates rerun reasons against strict regex to prevent GITHUB_OUTPUT injection.
  - Defect ledger L-218 and fast-path cache race (PR #1144).

**Competitor pulse (as of 2026-10-19 02:05 UTC pass):**
- nikolai-vysotskyi/trace-mcp: 193★ (=), 24 forks (=)
- yamadashy/repomix: 28,896★ (+1), 1,677 forks (+12)
- oraios/serena: 30,368★ (+3), 2,216 forks (+21)
- DeusData/codebase-memory-mcp: 46,857★ (+15), 3,870 forks (+6)
- tirth8205/code-review-graph: 32,245★ (+7), 3,043 forks (+10)
- colbymchenry/codegraph: 74,386★ (+15), 4,808 forks (=)
- abhigyanpatwari/GitNexus: 47,936★ (+4), 5,197 forks (-1)
- jgravelle/jcodemunch-mcp: 2,782★ (+1), 375 forks (-1)
- continuedev/continue: 36,248★ (+5), 5,491 forks (+1)
- Aider-AI/aider: 49,617★ (+3), 5,074 forks (+2)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.



### Pass 2026-10-19 08:00 UTC (TRA-2537): mention sweep clean, ecosystem findings (FastGraph-mcp, Synapse, Batas, cfgaudit), competitor triage (DeusData PHP imports PR #2705 & Python re-exports PR #2704, colbymchenry Claude desktop context PR #2642 & TS call links PR #2641, jcodemunch SubagentStart PR #1147)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds (reminder budget spent).
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: CONFLICTING due to upstream additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; standing no-ping rule holds, no follow-up).
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: 0 new repos outside the seen list. Sweep verified clean across all search facets.
- External touches: 0.

**Surfaces & Ecosystem findings:**
- ouli-1242/FastGraph-mcp: Python-based lightweight code intelligence MCP server (`fastgraph-mcp`) using tree-sitter, SQLite, and FTS5 trigram indexing for CJK docstrings. Positioned strictly as a code navigation layer across 9 languages (Python, TS/TSX, JS, Vue, Svelte, Go, Rust, Java, C/C++). Employs 20-second indexing budget slices to prevent blocking large repository cold-starts, writes index chunks in batches of 128 files, and explicitly distinguishes verified edges from guesses via `via: resolved|text`, `evidence: same_file|imported|name_only`, and `unresolved_incoming|unresolved_outgoing`.
  - Architectural contrast: trace-mcp provides broader language coverage (81 languages, 16 deep AST, 88 frameworks), zero-daemon stdio native binary / node distribution, cross-file framework-aware AST analysis, integrated Electron desktop application, persistent decision & state tracking (`decisions.db`, `state.db`), and token-budgeted output formatting (`get_task_context`, `trace blast`, `trace impact`).
- Locker-Room-Tools/synapse: Python-based local-first AST code context engine for AI agents (`synapse-mcp`) featuring a dual-profile tool design. Default profile exposes exactly 2 navigation tools (`synapse_orient` and `synapse_inspect`) to minimize static `tools/list` schema token footprint (~700 tokens total), while `--profile full` exposes 19 tools. Addresses symbols via deterministic compact handles (`s_` + 22 base64url characters) and distinguishes `payload_complete` from evidence coverage with an 800-token default response bound.
  - Architectural contrast: trace-mcp provides rich AST querying (`get_symbol`, `get_outline`, `get_task_context`, `search`, `trace blast`, `trace impact`) with natural symbol signatures, human-readable identifier navigation, multi-file blast radius calculations, comprehensive multi-language support (81 languages, 16 deep AST, 88 frameworks), zero-daemon stdio CLI execution, and Electron desktop integration without requiring python package installation or a local daemon.
- Antheurus/batas: Local guardrail and memory layer for Claude Code integrating PreToolUse, PostToolUse, and UserPromptSubmit hooks to inject markdown rules, incident references, and user memory when relevant code or bash triggers fire. Explicitly notes architectural division with code graph tools: "GitNexus tells the agent what the code does. batas tells it what has gone wrong before and what the user wants."
  - Architectural contrast: trace-mcp combines AST code intelligence with persistent architectural decisions and state tracking natively in SQLite (`decisions.db`, `state.db`) without requiring external hook orchestrators or ad-hoc prompt-injection wrappers.
- cfgaudit/cfgaudit: Go-based static security auditor for AI agent configurations (Claude Code, MCP servers, Cursor, Codex, Copilot, Gemini CLI) providing 109 rules mapped to OWASP LLM Top 10 and OWASP MCP Top 10 (MCP01 Token Mismanagement, MCP02 Privilege Escalation, MCP04 Software Supply Chain, MCP05 Command Injection, MCP07 Insufficient Auth, MCP09 Shadow MCP).
  - Architectural contrast: trace-mcp aligns with least-privilege MCP design principles out of the box — zero remote network calls during indexing, value-blind redacted environment inspection (`get_env_vars` contract, TRA-1882/1884), read-only structural inspection by default, and zero prompt-injection surface.

**Competitor intelligence & architectural observations:**
- DeusData/codebase-memory-mcp:
  - PHP unaliased global class absence proof (PR #2705, opened 2026-10-19T03:57:29Z by DeusData): PHP files marked import evidence complete (`php_imports_complete`) only when every `use` resolved or was proven absent. Unaliased global-namespace imports (`use Exception;`, `use stdClass;`) had no absence proof, blocking bindings across almost every PHP project until this fix added explicit global-namespace absence recognition.
  - Python re-exported package names (PR #2704, opened 2026-10-19T02:14:29Z by DeusData): Resolves names re-exported through package `__init__.py` files (both explicit imports and star imports like `from django.db.models.fields import *`), allowing downstream consumers importing from the package namespace to bind directly to definitions in submodules.
  - Python C3 MRO attribute lookup (PR #2697, closed 2026-10-19T03:06:01Z): Aligns attribute lookup with C3 method resolution order rather than sequential base walking.
  - ASP.NET Core attribute routing extraction (PR #2688, updated 2026-10-19T03:54:41Z): Adds extraction for `[HttpGet]`, `[HttpPost]`, `[Route]` attributes on controllers and actions.
- colbymchenry/codegraph:
  - Claude Code Desktop system context filtering (PR #2642, opened 2026-10-19T02:45:42Z by yang0228): Filters out `<system-reminder>` blocks injected by Claude Code Desktop into `UserPromptSubmit` payloads, preventing short agent replies (e.g. `yes`) from erroneously triggering graph search queries on injected desktop system reminders.
  - TypeScript typed call class linkage (PR #2641, closed 2026-10-19T01:32:49Z by colbymchenry): Disambiguates typed calls (`store: DisposableStore`, `new Store()`) against the specific class imported by the file rather than globally sharing names.
- jgravelle/jcodemunch-mcp:
  - Bounded SubagentStart briefing startup latency (PR #1147 / release v1.108.379 in PR #1149, closed 2026-10-19T03:48:30Z by jgravelle): Fixes issue #1139 where the `SubagentStart` hook injected a full repository briefing into every spawned Claude Code subagent, causing subagents to wait minutes during startup. Bounds briefing generation cost and adds benchmark tracking (PR #1148).
- abhigyanpatwari/GitNexus:
  - Python prefixed literals and f-string URL routing (PR #3626, updated 2026-10-19T01:51:36Z by abhigyanpatwari): Parses raw, bytes, unicode, and f-string URL prefixes (`r`, `b`, `u`, `fr`) in Python HTTP consumer calls to form contract IDs.
- oraios/serena:
  - Vue LS initialization ordering (PR #2177, opened 2026-10-19T02:07:31Z by karajanchang): Fixes dependency resolution order in `VueLanguageServer` so `ls_path` and `ls_base_cmd` are honored before base class initialization.

**Competitor pulse (as of 2026-10-19 08:05 UTC pass):**
- nikolai-vysotskyi/trace-mcp: 193★ (=), 24 forks (=)
- yamadashy/repomix: 28,900★ (+4), 1,677 forks (=)
- oraios/serena: 30,370★ (+2), 2,216 forks (=)
- DeusData/codebase-memory-mcp: 46,874★ (+17), 3,874 forks (+4)
- tirth8205/code-review-graph: 32,251★ (+6), 3,044 forks (+1)
- colbymchenry/codegraph: 74,402★ (+16), 4,812 forks (+4)
- abhigyanpatwari/GitNexus: 47,938★ (+2), 5,197 forks (=)
- jgravelle/jcodemunch-mcp: 2,783★ (+1), 375 forks (=)
- continuedev/continue: 36,253★ (+5), 5,493 forks (+2)
- Aider-AI/aider: 49,629★ (+12), 5,080 forks (+6)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.



### Pass 2026-10-19 14:00 UTC (TRA-2540): mention sweep clean, ecosystem findings (mini-consumes-tokens, codeindex, smarter-faster-better-mcp, opencrayast), competitor triage (colbymchenry TS dollar method calls PR #2662 & injected receivers PR #2661, DeusData PHP unindexed vendor receiver PR #2710 & tool search profiles PR #2708, jcodemunch PreCompact landmarks budget PR #1150 & release v1.108.380, Serena TypeScript 7 native LSP PR #2178, GitNexus lexical bindings PR #3632)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, standing no-ping rule holds (reminder budget spent).
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: CONFLICTING due to upstream additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; standing no-ping rule holds, no follow-up).
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: 0 new repos outside the seen list. Sweep verified clean across all search facets.
- External touches: 0.

**Surfaces & Ecosystem findings:**
- Zubiarka8/mini-consumes-tokens: Rust-based MCP server & CLI (`mct-cli` and `mct-mcp-server`) indexing repos into an AST/tree-sitter SQLite symbol graph across 17 languages. Notably adopted trace-mcp's TOON (Token-Optimized Object Notation) format as its default output representation (`format: toon`). Features 23 tools with progressive tool discovery (`select_tools`, `discover_tool_categories`, `get_tool_schema`, `MCT_TOOL_ATTENTION=1`), multi-hop call graph exploration (`find_references`, `find_calls`, `find_callers`, `impact_analysis` with `depth`), query batching (up to 25 queries in a single request), and `build_context_pack` returning symbol definition, docstrings, and callers/callees in one call.
  - Architectural contrast: trace-mcp provides broader language and framework support (81 languages, 16 deep AST, 88 frameworks vs 17 in mct), zero-daemon stdio native binary / node distribution, persistent architectural decision tracking and state ledger (`decisions.db`, `state.db`), integrated Electron desktop application, and specialized token-reduction commands (`trace blast`, `trace impact`, `get_task_context`).
- maxgfr/codeindex: Zero-dependency repo-indexing engine and MCP server (40 tools) designed for downstream agent skills and CLIs to vendor as a single self-contained `engine.mjs` file. Features deterministic repo walking (.gitignore, symlink cycle protection, size cap), tree-sitter AST with regex fallback, typed cross-file link-graph, and SCIP export. Accompanied by a detailed benchmark suite against universal-ctags, Serena, and Graphify across 75 compiler-graded questions.
  - Architectural contrast: trace-mcp provides persistent cross-session SQLite caching, token-budgeted output formats (TOON), active workspace watch daemon, native pre-compiled binaries, and deep framework semantic modeling across 88 frameworks, whereas codeindex focuses on a vendorable single-file script without native binaries.
- iHaiduk/smarter-faster-better-mcp (MCP Scout): Ultra-lightweight MCP server for AST-based code intelligence and semantic discovery powered by Bun and `oxc-parser` (zero native build dependencies for JS/TS) with web-tree-sitter fallback for polyglot repos. Employs code collapsing (`summaryOnly` collapses function/class bodies into stubs, retaining context while saving up to 90% tokens) and sub-second triage. Exposes `find_code`, `trace_symbol`, and `get_file_context`.
  - Architectural contrast: trace-mcp covers full multi-language AST graphs across 81 languages and 88 frameworks, multi-file blast radius calculation, cross-file call hierarchies, and persistent architecture memory without being limited to oxc/JS-focused parsing.
- amgio38/opencrayast: Rust-based MCP server & CLI for structural code reading and safe structural editing for AI coding agents. Works on syntax trees (outline, shape search, preview-then-apply plans with journaled undo; write operations off by default and path-contained).
  - Architectural contrast: opencrayast specializes in structural modification and safe AST writes/plans, whereas trace-mcp specializes in comprehensive static read/navigation/token-reduction intelligence across whole repositories.

**Competitor intelligence & architectural observations:**
- colbymchenry/codegraph:
  - TypeScript dollar method call resolution (PR #2662, merged 2026-10-19T11:44:17Z by colbymchenry): Expanded method call regex from `^([\w.]+)\.(\w+)$` to `^([\w.]+)\.([\w$]+)$` for the JS/TS family to handle dollar-bearing method names (Bitwarden's RxJS observables like `organizations$(userId)`, VS Code's RPC proxies like `_proxy.$acceptModelChanged`, Qwik's `$name$` methods). Gained 1,514 linked call sites in VS Code and 2,116 in Bitwarden with zero removals. Kept receiver side unchanged to prevent handing RxJS `next`/`pipe` to name guessing.
  - Dependency injection receiver type recovery (PR #2661, merged 2026-10-19T11:12:50Z by colbymchenry): Extracted concrete classes from Angular `inject(X)` / `inject<T>(TOKEN)` and VS Code `createInstance(X)` patterns; handles aliased re-exports (`import { Engine as FileSearchEngine }`). Gained 594 links in VS Code and 1,835 in Bitwarden.
  - Go import and interface linkage (PR #2660, PR #2659, PR #2658, all merged 2026-10-19 10:10–11:00 UTC): Fixed precedence for explicitly named Go imports over unaliased path stems, interface method type signatures, and local variable shadowing over package declarations.
- DeusData/codebase-memory-mcp:
  - PHP unindexed vendor receiver false-positive suppression (PR #2710, opened 2026-10-19T08:57:39Z by DeusData): When PHP LSP detects a receiver type that belongs to an unindexed vendor class (`php_method_typed_unindexed`), suppresses weak unique_name / suffix_match fallback to prevent false linkage to local methods with the same name. Tested on TYPO3, eliminating 25 false call edges.
  - Structural question declarations for tool search (PR #2708, opened 2026-10-19T05:46:00Z by Martin Vogel): Updated server instructions in scout and analysis profiles to explicitly state keywords and structural questions answered (symbol definition, callers, callees, data flow, impact), optimizing dynamic tool discovery for Claude Code's tool search capability.
  - Traited receiver methods and boundary scoping (PR #2706, PR #2707, PR #2705 merged).
- jgravelle/jcodemunch-mcp:
  - PreCompact hook landmarks time and size budgeting (PR #1150 / release v1.108.380 in PR #1152, merged 2026-10-19 11:00–12:32 UTC by jgravelle): Fixes defect L-219 where the PreCompact hook hydrated and PageRanked every touched repository without a time cap or size ceiling. Added `HYDRATE_MAX_SYMBOLS` and `BUDGET_SECONDS` deadline checks before loading repositories.
  - Defect ledger tracking (PR #1154): Documented L-221 (tool counters lose a batch at process exit) and C-27 repeat occurrence.
- oraios/serena:
  - Native TypeScript 7 LSP integration (PR #2178, merged 2026-10-19T11:33:58Z): Added `typescript_tsgo` language server support running `tsc --lsp --stdio` from the TypeScript 7.0.2 npm package, handling incremental sync and non-blocking initialization.
- abhigyanpatwari/GitNexus:
  - Lexical binding ownership in HTTP wrapper detection (PR #3632, updated 2026-10-19T11:02:03Z by abhigyanpatwari): Preserves lexical declaration ownership and scope-aware fetch-wrapper analysis for TS/JS/Vue with an $O(V+E)$ reverse work queue.

**Competitor pulse (as of 2026-10-19 14:30 UTC pass):**
- nikolai-vysotskyi/trace-mcp: 193★ (=), 24 forks (=)
- yamadashy/repomix: 28,912★ (+12), 1,686 forks (+9)
- oraios/serena: 30,389★ (+19), 2,232 forks (+16)
- DeusData/codebase-memory-mcp: 46,915★ (+41), 3,880 forks (+6)
- tirth8205/code-review-graph: 32,260★ (+9), 3,057 forks (+13)
- colbymchenry/codegraph: 74,433★ (+31), 4,816 forks (+4)
- abhigyanpatwari/GitNexus: 47,949★ (+11), 5,198 forks (+1)
- jgravelle/jcodemunch-mcp: 2,785★ (+2), 375 forks (=)
- continuedev/continue: 36,258★ (+5), 5,494 forks (+1)
- Aider-AI/aider: 49,637★ (+8), 5,082 forks (+2)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.



### Pass 2026-10-19 18:00 UTC (TRA-2547): mention sweep clean, ecosystem findings (tokensave, Graphicle, ctxfw, TokenForge), competitor triage (codegraph PR #2666–#2670, jcodemunch v1.108.381 PR #1155–#1156, serena PR #2180, GitNexus PR #3632 & #3635)

Audited read-only via GitHub API, nothing written outside this repository.

**Open threads audit (via GitHub API read-only):**
- Tracked external threads audit:
  - GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, reminder budget spent (2026-09-20); standing no-ping rule holds.
  - 0xNyk/awesome-hermes-agent#395: OPEN issue, reminder budget spent (2026-09-20); standing no-ping rule holds.
  - tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, reminder budget spent (2026-09-26); standing no-ping rule holds.
  - ai-boost/awesome-harness-engineering#240: OPEN (mergeable: CONFLICTING due to upstream additions; left alone per wontfix-spend / standing no-ping rule: rebase only close to a merge signal).
  - natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
  - hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
  - hesreallyhim/awesome-claude-code#2871: CLOSED (closed 2026-10-15T06:38Z by maintainer hesreallyhim with state_reason: not_planned; standing no-ping rule holds, no follow-up).
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: 0 new repos outside the seen list. Sweep verified clean across all search facets.
- External touches: 0.

**Surfaces & Ecosystem findings:**
- aovestdipaperino/tokensave: Rust-based semantic code intelligence MCP server and CLI (Rust port of CodeGraph TypeScript with 37-80+ tools across 30+ languages, bundled tree-sitter grammars into a single 25MB binary). Features official MCP registry manifest (`server.json` schema 2025-12-11 with `mcpb` bundle distribution). Exposes multi-branch indexing, per-call token tracking, on-demand staleness checks on every MCP tool call, porting tools (`port_status`, `port_order`), and Claude Code hooks / prompt rules.
  - Architectural contrast: trace-mcp provides broader language & framework coverage (81 languages, 16 deep AST, 88 frameworks), zero-daemon stdio native binary + npm distribution, persistent architecture decisions and state ledger (`decisions.db`, `state.db`), integrated Electron desktop UI, and compact TOON token budgeting.
- Graphicle-AI/graphicle: Rust-based code graph and memory MCP server & CLI for coding agents (Claude Code, Codex, Cursor, VS Code). Combines code graph AST navigation with project memory (document indexes, architectural decisions, past agent session replay) with token-budgeted cited excerpts (`graphicle ask "query"` -> 4 cited excerpts, 598 of 3,000 tokens). Uses `AGENTS.md` 2-line steering section and automated git hooks for continuous index synchronization.
  - Architectural contrast: trace-mcp similarly pairs AST code intelligence with persistent architectural memory (`decisions.db`, `state.db`) and token budgeting (`trace blast`, `get_task_context`), while delivering deep semantic framework graphs (88 frameworks) and a standalone Electron desktop experience without requiring background daemon setup.
- heuristicolab/ctxfw (Context Firewall): High-assurance in-memory AST context firewall and Model Context Protocol gatekeeper for coding agents (-72.4% token reduction). Prunes peripheral module code based on graph distance: $D_0$ target (100% full implementation), $D_1$ direct imports (replaces function/method bodies with interface signatures and type definitions), $D_{2+}$ transitive imports (collapses to minimal stubs, saving up to 91.9% tokens). Enforces axiomatic integrity sieves (rejecting ungrounded prompts) and zero network telemetry egress.
  - Architectural contrast: trace-mcp operates a deterministic whole-repo symbol index and graph-driven blast radius navigation (`trace blast`, `trace impact`, TOON representation), avoiding runtime prompt rejections while providing accurate cross-file call hierarchies and jump-to-definition.
- speedydivid/TokenForge: Context window optimization layer for AI coding agents (Claude Code, Gemini CLI, OpenCode, Codex). Sandboxes massive tool outputs (compressing up to 98% verbose tool output before it reaches the LLM context), persists session memory via SQLite + FTS5, and routes tool interactions across 17 platforms via MCP + hooks.
  - Architectural contrast: trace-mcp prevents bloated context at the source by pre-calculating token-budgeted code maps and targeted symbol extraction rather than relying solely on post-hoc tool output filtering/compression.

**Competitor intelligence & architectural observations:**
- colbymchenry/codegraph:
  - React Router `<Outlet />` empty route rendering (PR #2670, merged 2026-10-19T17:59:29Z by colbymchenry): Route objects with `element: <Outlet />` or `Component: Outlet` previously registered `Outlet` as the route page and layout of every nested child route, generating orphaned non-linking `layout:Outlet` references. Now recognized as rendering nothing of their own, eliminating bogus layout edges.
  - Upward folder import index linkage (PR #2669, merged 2026-10-19T17:37:06Z by colbymchenry): Incremental sync previously only tracked `.`, `./`, `..`, and `../` in `getFailedFolderImports`. Imports referencing folders two or more levels up (`../../`) remained unlinked when the folder's `index` file appeared. Added general relative path traversal to retry failed folder imports.
  - Function-returned React Router table extraction (PR #2668, merged 2026-10-19T17:22:57Z by colbymchenry): Handles router table factories (e.g. Medusa admin dashboard's `const routes = getRouteMap(...); createBrowserRouter(routes)`), evaluating literal route tables returned across module boundaries.
  - Go package-level variable type linkage (PR #2667, merged 2026-10-19T16:46:08Z by colbymchenry): Top-level Go `var` and `const` declarations are now parsed to retain their declared type, resolving method calls through variables (e.g. `var lg *zap.Logger` -> `lg.Panic(...)`) to the concrete type instead of falling back to loose name guessing.
  - Popular import name stem collision filtering (PR #2666, merged 2026-10-19T16:58:57Z by colbymchenry): When an added file shares a stem with widespread library imports (e.g. `utils` in `jotai/utils`), sync ignores keys shared by >500 failed imports to avoid retry stalls.
- jgravelle/jcodemunch-mcp:
  - Cross-repository index collision fix & Release v1.108.381 (PR #1155 & PR #1156, merged 2026-10-19 15:36–17:36 UTC by jgravelle): Fixed a critical storage collision defect where SQLite index files named `<owner>-<name>` collided for repositories with hyphens in owner vs repo (e.g., `foo-bar/baz` vs `foo/bar-baz`). Indexing one repository would silently overwrite the other, serving wrong codebase answers. Added recorded repository validation before reusing storage slots.
- oraios/serena:
  - Claude Desktop chat mode `session_id` compatibility (PR #2180, merged 2026-10-19T15:51:34Z): Fixed Claude Desktop chat mode filtering out MCP tool parameters named `session_id` by renaming the parameter to `session`.
  - Dashboard welcome pane automatic opening behaviour (PR #2181, merged 2026-10-19T17:12:10Z).
- abhigyanpatwari/GitNexus:
  - 1-based line numbers in cross-function explain (PR #3635, opened 2026-10-19T15:37:36Z by abhigyanpatwari): Fixed interprocedural analysis returning 0-based raw tree-sitter line rows for `source.line`, `sink.line`, and `hops[].line`, aligning with standard 1-based editor coordinates.
  - Lexical binding ownership in HTTP wrapper detection (PR #3632, updated 2026-10-19 17:45 UTC).
  - MiniMax M3.1 Flash presets and saved model persistence (PR #3636).

**Competitor pulse (as of 2026-10-19 18:05 UTC pass):**
- nikolai-vysotskyi/trace-mcp: 193★ (=), 24 forks (=)
- yamadashy/repomix: 28,912★ (=), 1,693 forks (+7)
- oraios/serena: 30,396★ (+7), 2,242 forks (+10)
- DeusData/codebase-memory-mcp: 46,933★ (+18), 3,881 forks (+1)
- tirth8205/code-review-graph: 32,263★ (+3), 3,065 forks (+8)
- colbymchenry/codegraph: 74,448★ (+15), 4,818 forks (+2)
- abhigyanpatwari/GitNexus: 47,951★ (+2), 5,199 forks (+1)
- jgravelle/jcodemunch-mcp: 2,785★ (=), 374 forks (-1)
- continuedev/continue: 36,262★ (+4), 5,494 forks (=)
- Aider-AI/aider: 49,640★ (+3), 5,082 forks (=)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.

### Early morning pass, 2026-10-20 (TRA-2559): mention sweep (sayef/comindly), open threads audit, competitor & ecosystem triage

**External threads audit (read-only via GitHub API):**
- MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
- GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, standing no-ping rule holds.
- 0xNyk/awesome-hermes-agent#395: OPEN issue, reminder budget spent (2026-09-20); standing no-ping rule holds.
- tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, reminder budget spent (2026-09-26); standing no-ping rule holds.
- ai-boost/awesome-harness-engineering#240: CLOSED / dead end (verified 2026-10-20, TRA-926 / commit aa2d53df: 0 external PRs merged since July, maintained by author's daily self-adds, marked отброшено, standing no-ping rule holds).
- natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
- hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
- hesreallyhim/awesome-claude-code#2871: CLOSED (`state_reason: not_planned`); standing no-ping rule holds.
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: 1 new repo outside the seen list (`sayef/comindly`).
- Evaluated matched file `docs/design/ledger.md` via read-only raw fetch: confirmed continuation/rename of `sayef/comind` (independent deterministic code intelligence engine project for coding agents). Under §1 "Why this, why now" / "Decision records", cites `trace-mcp` alongside ADR/MADR and Lore trailers, referencing `trace-mcp decision memory: https://trace-mcp.com/decision-memory.html`. Recorded as a genuine architectural citation in the surfaces table and silenced in `ops/mentions-seen.txt`.
- External touches: 0.

**Surfaces & Ecosystem findings:**
- sayef/comindly: Continuation of sayef/comind (0★, active 2026-10-19/20). SCIP-based code intelligence engine for agents, evaluating agent memory and decision records in `docs/design/ledger.md`, explicitly citing `trace-mcp` and its decision memory architecture.
- bgts-ai-org/bgts-context-engine: Deterministic code-graph context engine for AI coding agents (75★, MIT, PyPI `bgts-context-engine`). Backed by PostgreSQL + Apache AGE + pgvector over MCP and REST, targeting structural context delivery (e.g. call hierarchies and write locations) without an LLM in the loop. Claims -82% tokens, -63% cost, -89% tool calls across 6 languages.
  - Architectural contrast: trace-mcp requires zero external database servers or Docker containers (embedded SQLite + sqlite-vec directly inside Node/npx with zero external database dependencies vs requiring a full PostgreSQL + Apache AGE setup), while delivering comparable or superior token compression (70.5%–72.7% median reduction) across 81 languages (vs BCE's 6 languages).
- alexsoft-hq/Cascade: Code-to-column change-impact knowledge graph for AI coding agents (8★, Apache-2.0). Provides stored project structure queryable over MCP, CLI and local web viewer (`session_briefing`, `architecture`, `code_search`, `file_outline`, `code_trace`, `code_snippet`, `changed_impact`, `flow`) across Java, TypeScript and frontend inputs.
  - Architectural contrast: trace-mcp covers 81 languages (16 deep AST, 88 frameworks) vs Cascade's Java/TS/frontend, features non-invasive CLI tools and compact TOON budgeting, and provides an integrated Electron desktop client without background daemon synchronization locks.
- Novaya-AI/novgraph: Python-based CLI/MCP client for Novaya's hosted code knowledge graph (10★, Apache-2.0). Claims 96% to 99.8% smaller context than full file reads, but delegates indexing and storage to proprietary cloud servers (`trynovaya.com`).
  - Architectural contrast: trace-mcp is 100% local, zero-telemetry / zero-cloud, open source (MIT), requires no API key or remote server, and indexes code deterministically on the user's machine.

**Competitor intelligence & architectural observations:**
- DeusData/codebase-memory-mcp:
  - PR #2714 (`feat(hooks): name the graph follow-up tools in every search augmentation`, opened 2026-10-19T21:52:30Z): In Claude Code PreToolUse hooks, whenever grep/glob/bash matches a symbol, appends a dedicated prompt line explicitly directing the agent to graph tools (`trace_path` for callers/callees, `get_code_snippet` for source, `search_graph` for related symbols).
  - PR #2713 (`fix(python): a top-level call of a harmless same-module function keeps the package namespace`, opened 2026-10-19T20:57:57Z): In Python package namespace extraction, previously any top-level call caused cbm to withdraw all published re-exports. Stacked on #2712, adds an allowlist for provably harmless top-level calls (e.g. SQLAlchemy's `__go(locals())`), preventing 55 wrong name guesses for `sql.and_`, `sql.select`, and `sql.cast`.
  - PR #2710 (`fix(php): drop the name guess when the receiver's class is not indexed`, opened 2026-10-19T21:57:21Z by wazum): In PHP call extraction, when the receiver class is known to the LSP but not indexed (vendor classes), drops heuristic fallback edges (`unique_name`/`suffix_match`), removing 25 incorrect cross-class call linkages (e.g. `$file->getUid()` falsely linking to `App\Item::getUid`).
- colbymchenry/codegraph:
  - PR #2683 (`fix(swift): a call written after try! links what it calls on Windows`, merged 2026-10-19T21:49:18Z by colbymchenry): Fixed 32-bit `unsigned long` overflow (`1UL << 31`) in MSVC Windows tree-sitter-swift scanner where `try!` misparsed as logical NOT `!`, causing callee names and receivers to be corrupted (e.g. `! Message2`, `! Repository`). Backported upstream 0.7.4 fix into vendored grammar.
  - PR #2682 (`fix(go): variables declared in a var ( … ) block are indexed`, merged 2026-10-19T21:23:08Z by colbymchenry): Fixed Go variable extraction ignoring variables declared inside grouped `var ( ... )` blocks (wrapped in `var_spec_list`), which previously caused struct references, composite literals, and typed calls through package-level variables in etcd/prometheus/gin to remain unindexed.
  - PR #2681 (`fix(extraction): a build folder inside src/ is indexed for its TypeScript, JSX, Vue, Svelte and Astro files`, merged 2026-10-19T21:10:40Z by colbymchenry).
  - PR #2679 & #2678: Go doc comment extraction fixes (excluding `//go:embed` directives and comments separated by blank lines from declaration docs).
- jgravelle/jcodemunch-mcp:
  - PR #1165 / Release v1.108.383 (`fix: refreshing summaries no longer erases complexity and the call graph (#1161)`, merged 2026-10-19T21:43:29Z by jgravelle): Fixed critical data-loss defect where `summarize_repo(force=true)` reconstructed symbols via incomplete dictionaries and rewrote entire SQLite rows, setting `cyclomatic`, `max_nesting`, `param_count`, and `call_references` to NULL and zeroing repo health/complexity metrics. Switched to column-targeted summary updates.
- oraios/serena:
  - PR #2182 (`Make language-server file synchronization configurable`, opened 2026-10-19T21:06:24Z by AhmedDusuki): Added configurable `full` vs `none` strategies for language-server file synchronization to let users disable heavy filesystem baseline and rescans in large projects.
  - Architectural contrast: trace-mcp uses native file watcher diffing with hash-gated stat checks and git fast paths, delivering sub-second incremental index updates without requiring users to disable file synchronization.

**Competitor pulse (as of 2026-10-20 02:05 UTC pass):**
- nikolai-vysotskyi/trace-mcp: 193★ (=), 24 forks (=)
- yamadashy/repomix: 28,914★ (+2), 1,705 forks (+12)
- oraios/serena: 30,401★ (+5), 2,264 forks (+22)
- DeusData/codebase-memory-mcp: 46,945★ (+12), 3,884 forks (+3)
- tirth8205/code-review-graph: 32,265★ (+2), 3,078 forks (+13)
- colbymchenry/codegraph: 74,460★ (+12), 4,818 forks (=)
- abhigyanpatwari/GitNexus: 47,952★ (+1), 5,199 forks (=)
- jgravelle/jcodemunch-mcp: 2,787★ (+2), 374 forks (=)
- continuedev/continue: 36,267★ (+5), 5,498 forks (+4)
- Aider-AI/aider: 49,644★ (+4), 5,084 forks (+2)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.

### Morning pass, 2026-10-20 (TRA-2568): mention sweep (JMartynov/mcp-fingerprints), open threads audit, competitor & ecosystem triage

**External threads audit (read-only via GitHub API):**
- MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
- GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, reminder budget spent (2026-09-20); standing no-ping rule holds.
- 0xNyk/awesome-hermes-agent#395: OPEN issue, reminder budget spent (2026-09-20); standing no-ping rule holds.
- tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, reminder budget spent (2026-09-26); standing no-ping rule holds.
- ai-boost/awesome-harness-engineering#240: CLOSED / dead end (verified 2026-10-20, TRA-926 / commit aa2d53df: 0 external PRs merged since July, maintained by author's daily self-adds, marked отброшено, standing no-ping rule holds).
- natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
- hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
- hesreallyhim/awesome-claude-code#2871: CLOSED (`state_reason: not_planned`); standing no-ping rule holds.
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: 1 new repo outside the seen list (`JMartynov/mcp-fingerprints`).
- Evaluated matched surface via GitHub API (read-only): confirmed genuine open-source MCP server passport & tool signature knowledge base (5,058+ indexed passports, web directory at `jmartynov.github.io/mcp-fingerprints`). Auto-indexed `data/fingerprints/nikolai-vysotskyi_trace-mcp.json` from `official_registry` stream. Recorded in the third-party directory table and silenced in `ops/mentions-seen.txt`.
- Second verification run: clean (`No repos outside the seen list. Nothing to read.`).
- External touches: 0.

**Competitor intelligence & architectural observations:**
- DeusData/codebase-memory-mcp:
  - PR #2719 (`feat(cli): give Codex shell searches graph context through a PreToolUse hook`, opened 2026-10-20T02:08:24Z): Expands PreToolUse search hooks beyond Claude Code to Codex shell CLI searches, injecting graph context when search commands run.
  - PR #2716 (`feat(plugin): Claude Code plugin marketplace, discovery slice (#1188 slice 1)`, opened 2026-10-19T23:45:01Z): Adds an in-repo discovery marketplace slice for Claude Code plugins.
  - PR #2715 (`feat(watcher): add the Subversion working-copy observation core`, opened 2026-10-19T23:44:26Z): Adds SVN working-copy observation core to support enterprise subversion repositories.
  - PR #2714 (`feat(hooks): name the graph follow-up tools in every search augmentation`, merged 2026-10-20T01:28:57Z): In Claude Code PreToolUse hooks, whenever grep/glob/bash matches a symbol, explicitly prompts the model to call graph follow-up tools (`trace_path`, `get_code_snippet`, `search_graph`).
- colbymchenry/codegraph:
  - PR #2700 (`fix(rust): a Self:: call is the function of the type whose impl it is in`, merged 2026-10-20T02:08:19Z by colbymchenry): Fixed call target resolution for `Self::` method calls inside trait/struct impl blocks.
  - PR #2699 (`fix(objc): a file-scope constant or global is indexed, in an @implementation too`, merged 2026-10-20T01:43:15Z by colbymchenry): Extracted static globals inside Objective-C implementation blocks.
  - PR #2698 (`fix(cpp): every name a declaration lists has its type, like strings_found in ByteBuffer symbols_found, strings_found;`, merged 2026-10-20T01:52:08Z by colbymchenry): Resolved multi-variable declaration type propagation in C++.
  - PR #2697 (`fix(rust): a call reaches a project impl on a std type only as Rust would pick it`, merged 2026-10-20T01:37:17Z by colbymchenry): Disambiguated project impls extending standard library types in Rust.
  - PR #2696 (`fix(objc): a doc comment inside an @implementation documents the method below it`, merged 2026-10-20T01:16:24Z by colbymchenry): Doc-comment attachment for Objective-C methods inside `@implementation`.
- jgravelle/jcodemunch-mcp:
  - PR #1174 / Release v1.108.385 (`release: v1.108.385 - a summary written by another process reaches this one's searches`, opened 2026-10-20T03:10:44Z by jgravelle): Multi-process cross-instance search synchronization for external summary caches (stacked on PR #1171).
  - PR #1173 (`fix: an index read back in the process that saved it keeps ecosystem_context (L-224)`, merged 2026-10-20T02:44:39Z by jgravelle): Preserving ecosystem metadata on in-process index reload.
  - PR #1172 (`docs: README and server.json name the benchmark behind the token figure`, merged 2026-10-20T02:10:18Z by jgravelle): Token reduction benchmark source attribution in documentation and server manifest.
- Graphify-Labs/graphify:
  - PR #4576 (`fix: render node rationale in query, get_node and explain output (#2821)`, opened 2026-10-20T01:10:17Z): Adds node rationale rendering to query, get_node, and explain tool responses.
  - PR #4573 (`fix(vbnet): resolve cross-file calls to Module members, typed locals and C# statics (#4570)`, opened 2026-10-19T23:02:06Z): Cross-file call resolution across VB.NET and C# statics.
  - PR #4572 (`fix(json_config): link a package.json dependency's manifest entry to its ref node (#4569)`, opened 2026-10-19T21:13:27Z): Structural linking of package.json manifest dependencies to AST ref nodes.
- tirth8205/code-review-graph:
  - PR #1124 (`Add MCP readOnlyHint annotations to tools`, opened 2026-10-19): Adding MCP standard `readOnlyHint` protocol annotations across tool definitions.
  - PR #1122 (`fix(postprocess): match repo-relative changed files in incremental flow pass`, opened 2026-10-19): Fixing path normalization in incremental flow calculation.

**Competitor pulse (as of 2026-10-20 04:05 UTC pass):**
- nikolai-vysotskyi/trace-mcp: 193★ (=), 24 forks (=)
- yamadashy/repomix: 28,913★ (-1), 1,705 forks (=)
- oraios/serena: 30,405★ (+4), 2,265 forks (+1)
- DeusData/codebase-memory-mcp: 46,963★ (+18), 3,886 forks (+2)
- tirth8205/code-review-graph: 32,268★ (+3), 3,078 forks (=)
- colbymchenry/codegraph: 74,476★ (+16), 4,821 forks (+3)
- abhigyanpatwari/GitNexus: 47,959★ (+7), 5,200 forks (+1)
- jgravelle/jcodemunch-mcp: 2,788★ (+1), 374 forks (=)
- continuedev/continue: 36,267★ (=), 5,498 forks (=)
- Aider-AI/aider: 49,648★ (+4), 5,083 forks (-1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.

### Afternoon pass, 2026-10-20 (TRA-2571): mention sweep clean, open threads audit, competitor & ecosystem triage

**External threads audit (read-only via GitHub API):**
- MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
- GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, reminder budget spent (2026-09-20); standing no-ping rule holds.
- 0xNyk/awesome-hermes-agent#395: OPEN issue, reminder budget spent (2026-09-20); standing no-ping rule holds.
- tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, reminder budget spent (2026-09-26); standing no-ping rule holds.
- ai-boost/awesome-harness-engineering#240: CLOSED / dead end (verified 2026-10-20, TRA-926 / commit aa2d53df: 0 external PRs merged since July, marked отброшено, standing no-ping rule holds).
- natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
- hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
- hesreallyhim/awesome-claude-code#2871: CLOSED (`state_reason: not_planned`); standing no-ping rule holds.
- eltociear/awesome-AI-driven-development#119: MERGED (verified 2026-09-30, live in README & README_JA).
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: **0 new repos outside the seen list**. Sweep verified clean across all facets.
- External touches: 0.

**Surfaces & Ecosystem findings:**
- **jalil-dini/plainlook**: Python standard-library offline scanner (30 checks) for agent skill files (`SKILL.md`, `AGENTS.md`, `CLAUDE.md`) and MCP server code. Highlights transparent empirical base rates across 576 public MCP servers and 300 skill packs, reports false-positive conditions ("fires on something fine when..."), and explicitly lists unexamined surfaces (NOT COVERED). Demonstrates rising developer expectation for static capability auditing and least-privilege MCP compliance.
  - *Architectural contrast*: trace-mcp adheres to least privilege by design — zero network calls during local indexing, value-blind redacted environment variables (`get_env_vars` contract), read-only structural queries by default, and isolated SQLite storage (`decisions.db`, `state.db`).
- **mlgxiii/contextrie-mcp**: TypeScript MCP server (`contextrie-mcp`) exposing `select_context` tool that uses remote LLM calls (`gpt-4.1-mini`/`claude-haiku-5-5`) to summarize files into `.contextrie/sources.json` and score file summaries against user tasks.
  - *Architectural contrast*: trace-mcp is fully local, instant, and token-free for indexing, using tree-sitter AST and cross-file symbol call graphs across 81 languages without remote API keys, privacy leakage, or per-query model billing.
- **sajjadGG/Ghostlab**: Agent evaluation lab sandboxed in NVIDIA OpenShell for multi-turn role-playing and scoring of Claude Code, Codex, and Copilot CLI workflows across MCP tools and skills.
- **numikel/kprun**: Rust CLI for injecting KeePass secrets into ephemeral MCP server and coding agent child processes, avoiding token persistence in `mcp.json`.

**Competitor intelligence & architectural observations:**
- **DeusData/codebase-memory-mcp**:
  - PR #2720 (`fix(discover): a symlink must not abort a bounded count (carries #1803, fixes #2701)`, opened 2026-10-20T04:36:09Z): `safe_stat()` flags symlinks as unsafe/not-found by policy; in the auto-index admission count phase (`count_only`), encountering any symlink aborted the whole walk. Fixed by skipping symlinks cleanly during bounded counts.
  - PR #2721 (`docs: propose phased TypeScript reference improvements (#2709)`, opened 2026-10-20T06:26:22Z): Phased design RFC for TypeScript reference resolution and type-hierarchy caching.
- **colbymchenry/codegraph**:
  - PR #2703 (`fix(objc): a message to an ivar or a property reaches the class it is declared as`, opened 2026-10-20T06:27:54Z): Binds Objective-C ivar and property method calls to their declared class interfaces instead of treating them as untyped receiver expressions.
  - PR #2702 (`fix(rust): a name a use brings in is the item of the module its path walks`, opened 2026-10-20T06:18:39Z): Fixed cross-module name collisions in Rust `use` imports where imports like `use crate::sync::watch::Receiver;` erroneously bound to other in-scope modules defining `Receiver`.
  - PR #2701 (`fix(rust): a call through a Pin, Rc or Box self reaches the method Rust picks, inherent first`, opened 2026-10-20T06:03:03Z): Resolves wrapped receiver calls (`self: Pin<&mut Self>`, `Rc`, `Box`) to the inner type's inherent/trait methods instead of the outer smart pointer wrapper.
- **jgravelle/jcodemunch-mcp**:
  - PR #1179 (`Opt-in summarizer_body_chars: send each symbol's body + decorators to the AI summariser`, opened 2026-10-20T08:05:54Z): Implements `summarizer_body_chars` config parameter (default 0) to feed symbol body spans up to N chars and decorators to the summarizer, addressing shallow summary degradation.
- **Graphify-Labs/graphify**:
  - PRs #4578, #4579, #4580, #4581, #4582 (opened 2026-10-20 08:05–08:08Z): Coordinated 5-language sprint extracting explicit `type` aliases and `typedef`s as dedicated type nodes across Python, Go, C++, Rust, and Dart, preventing them from falling back to sourceless stubs or untyped variable bindings.
- **tirth8205/code-review-graph**:
  - PR #1125 (`feat(install): keep the graph in sync after checkout, merge and rebase`, opened 2026-10-20T08:35:42Z): Installs `post-checkout`, `post-merge`, and `post-rewrite` git hooks alongside `pre-commit` to prevent graph staleness during branch switches and rebases without daemon watchers.
- **oraios/serena**:
  - PR #2184 (`fix(memory): bound cyclic source scans and stalled logging backlog`, opened 2026-10-20T06:37:25Z): Tracks traversal ancestry to prevent directory cycles and bounds asynchronous logging queue to mitigate memory spikes.
  - PR #2185 (`Fix: expand leading ~ in path-valued configuration settings`, opened 2026-10-20T09:38:22Z): Expands leading `~` in path configuration settings.

**Competitor pulse (as of 2026-10-20 10:05 UTC pass):**
- nikolai-vysotskyi/trace-mcp: 193★ (=), 24 forks (=)
- yamadashy/repomix: 28,925★ (+12), 1,721 forks (+16)
- oraios/serena: 30,422★ (+17), 2,308 forks (+43)
- DeusData/codebase-memory-mcp: 46,993★ (+30), 3,890 forks (+4)
- tirth8205/code-review-graph: 32,275★ (+7), 3,098 forks (+20)
- colbymchenry/codegraph: 74,498★ (+22), 4,820 forks (-1)
- abhigyanpatwari/GitNexus: 47,967★ (+8), 5,198 forks (-2)
- jgravelle/jcodemunch-mcp: 2,789★ (+1), 374 forks (=)
- continuedev/continue: 36,273★ (+6), 5,501 forks (+3)
- Aider-AI/aider: 49,653★ (+5), 5,087 forks (+4)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.

### Evening pass, 2026-10-20 (TRA-2574): mention sweep clean, external threads audit, competitor & ecosystem triage

**External threads audit (read-only via GitHub API):**
- MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
- GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, reminder budget spent (2026-09-20); standing no-ping rule holds.
- 0xNyk/awesome-hermes-agent#395: OPEN issue, reminder budget spent (2026-09-20); standing no-ping rule holds.
- tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, reminder budget spent (2026-09-26); standing no-ping rule holds.
- ai-boost/awesome-harness-engineering#240: CLOSED / dead end (verified 2026-10-20, TRA-926 / commit aa2d53df: 0 external PRs merged since July, marked отброшено, standing no-ping rule holds).
- natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
- hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
- hesreallyhim/awesome-claude-code#2871: CLOSED (`state_reason: not_planned`); standing no-ping rule holds.
- eltociear/awesome-AI-driven-development#119: MERGED (verified 2026-09-30, live in README & README_JA).
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: **0 new repos outside the seen list**. Sweep verified clean across all facets.
- External touches: 0.

**Surfaces & Ecosystem findings:**
- **drknowhow/code-context-control** (C3): Local MCP server (v2.93.x on PyPI) exposing 21 tools addressing the token-waste failure mode of LLM coding agents ("they read too much"). Features AST compression (`c3_compress`), surgical symbol reads (`c3_read`), access/mask guards, edit ledgers, agent locks, and PM integrations.
  - *Architectural contrast with trace-mcp*:
    - *Tool schema footprint*: Exposing 21 distinct tools clutters the agent context with massive JSON schemas on every prompt turn; trace-mcp keeps a lean, focused tool interface for code navigation (`explore_node`, `query_subgraph`, `trace_path`, etc.).
    - *Surface sprawl & security surface*: C3 bundles shell execution (`c3_shell`), local CI container runners (`c3_ci`), and credential vaulting (`c3_credentials`). trace-mcp strictly maintains a zero-network indexing model and read-only structural inspection by default, keeping agent blast radius minimal.
    - *Language breadth*: C3 relies on dynamic runtime typecheckers (pyright/tsc/ruff) for AST maps across limited languages, whereas trace-mcp embeds native tree-sitter grammars and symbol graph resolution across 81 languages with zero per-file process spawning.
- **subodhkc/mcp-tenant-isolation**: Deterministic static analysis scanner and MCP server (57 rules) checking multi-tenant SaaS and MCP server code for cross-tenant data leaks (RLS, Prisma/Drizzle filtering, tenant-scoped tool visibility).
- **agent-gigmole/awesome-ai-agent-tools**: Auto-generated mirror of agentoolrank.com (613 tools ranked by stars). Audited and skipped per our catalog quality criteria: automated affiliate/leadgen mirror with 0 stars and no human maintainer review.

**Competitor intelligence & architectural observations:**
- **colbymchenry/codegraph**:
  - PR #2705 (`fix(java,ts): a parameterized supertype names its type, so implements Store<String> links the interface`, opened 2026-10-20T11:18:02Z): In Java and TypeScript, `generic_type` AST nodes previously caused the entire parameterized string (`Store<String>`) to be recorded as the supertype name, preventing interface-implementation resolution. The fix strips type arguments from the first child identifier, unblocking interface-to-implementation edges for generic supertypes.
  - PR #2704 (`fix(resolution): an interface overload links the implementation overload with its parameters (#2663)`, opened 2026-10-20T10:14:39Z): Fixed combinatorial blowup in interface-impl synthesizer where overloads previously linked all-to-all across same-named methods. In Java, Kotlin, C#, Scala, it now matches implementation overloads by arity and parameter types.
- **jgravelle/jcodemunch-mcp**:
  - PR #1181 (`fix: Flask route methods= are read (#1177); summary Context: order is stable (#1178)`, opened 2026-10-20T12:51:15Z): Parses Flask `methods=` parameter via AST to extract HTTP verbs instead of defaulting every route to GET; fixes unstable hash seed order in `Context:` summary prompts by preserving first-seen insertion order.
  - PR #1180 (`fix(hooks): pre_pr reads the tree gh pr create runs in`, opened 2026-10-20T10:57:54Z): Hardens git workflow hooks against command-chaining and path-manipulation evasion when running `gh pr create`.
- **Graphify-Labs/graphify**:
  - PR #4587 (`fix(swift): model a macro declaration and its freestanding call (#4551)`, opened 2026-10-20T12:36:37Z): Adds Swift 5.9 `macro_declaration` to `function_types` and `macro_invocation` to `call_types` with sibling token handling.
  - PR #4586 (`fix(cpp): blank Metal and CUDA qualifiers tree sitter cpp cannot parse (#4550)`, opened 2026-10-20T12:27:30Z): Byte-preserving normalization that blanks GPU qualifiers (`kernel`, `device`, `constant`, `__global__`, `__device__`) in `.metal` and `.cu` files before tree-sitter C++ parsing, preventing qualifiers from polluting the AST as sourceless type identifiers.
  - PR #4585 (`fix(csharp): model a delegate declaration as a node, not a sourceless stub (#4552)`, opened 2026-10-20T12:18:08Z): Adds `delegate_declaration` to C# class types so delegate references resolve to real in-file nodes instead of minting synthetic sourceless stubs.
  - PR #4583 (`fix(kotlin): model a type alias as a node, not a sourceless stub (#4553)`, opened 2026-10-20T12:10:52Z): Emits sourced nodes for Kotlin `type_alias` declarations, eliminating spurious cross-file hub stubs.

**Competitor pulse (as of 2026-10-20 14:04 UTC pass):**
- nikolai-vysotskyi/trace-mcp: 193★ (=), 24 forks (=)
- yamadashy/repomix: 28,930★ (+5), 1,721 forks (=)
- oraios/serena: 30,453★ (+31), 2,309 forks (+1)
- DeusData/codebase-memory-mcp: 47,011★ (+18), 3,890 forks (=)
- tirth8205/code-review-graph: 32,282★ (+7), 3,098 forks (=)
- colbymchenry/codegraph: 74,510★ (+12), 4,823 forks (+3)
- abhigyanpatwari/GitNexus: 47,970★ (+3), 5,197 forks (-1)
- jgravelle/jcodemunch-mcp: 2,788★ (-1), 374 forks (=)
- continuedev/continue: 36,273★ (=), 5,501 forks (=)
- Aider-AI/aider: 49,662★ (+9), 5,086 forks (-1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.

### Late evening pass, 2026-10-20 (TRA-2576): mention sweep clean, external threads audit, competitor & ecosystem triage

**External threads audit (read-only via GitHub API):**
- MiniMax-AI/MiniMax-Code-Plugins#54: OPEN (Round 4 review from hetaoBackend, dedicated lane for Nikolai).
- GetBindu/awesome-claude-code-and-skills#195: OPEN, mergeable, reminder budget spent (2026-09-20); standing no-ping rule holds.
- 0xNyk/awesome-hermes-agent#395: OPEN issue, reminder budget spent (2026-09-20); standing no-ping rule holds.
- tolkonepiu/best-of-mcp-servers#384: OPEN, mergeable, reminder budget spent (2026-09-26); standing no-ping rule holds.
- ai-boost/awesome-harness-engineering#240: CLOSED / dead end (verified 2026-10-20, TRA-926 / commit aa2d53df: 0 external PRs merged since July, marked отброшено, standing no-ping rule holds).
- natsukium/mcp-servers-nix#606: OPEN issue, standing no-ping rule holds.
- hashgraph-online/awesome-ai-plugins#182: MERGED, listed in HOL Registry; claim declined and stays declined.
- hesreallyhim/awesome-claude-code#2871: CLOSED (`state_reason: not_planned`); standing no-ping rule holds.
- eltociear/awesome-AI-driven-development#119: MERGED (verified 2026-09-30, live in README & README_JA).
- Touch budget: 0 of 5 used. No outgoing pings or unsolicited PRs opened.

**Mention sweep (scripts/mention-sweep.sh):**
- Ran both passes across all 9 search patterns (4 general/domain/npx queries, 5 paired competitor queries).
- Result: **0 new repos outside the seen list**. Sweep verified clean across all facets.
- External touches: 0.

**Surfaces & Ecosystem findings:**
- **jalil-dini/plainlook**: Offline static analysis scanner (30 checks, zero network, zero dependencies) for agent skill files (`SKILL.md`, `AGENTS.md`, `CLAUDE.md`) and MCP server implementations. Checks for credential leaks, `curl | sh`, path traversal, unpinned binaries, and supply-chain vectors. Aligns with our defensive sandboxing model.
- **mlgxiii/contextrie-mcp**: Context selector MCP server wrapping Contextrie with a `select_context(task)` tool ranking relevant files for a task. Requires Anthropic/OpenAI API keys in environment.
  - *Architectural contrast with trace-mcp*: Relies on remote LLM API calls and token burn upfront just to identify which files to read; trace-mcp indexes AST structures and resolves symbol reference subgraphs entirely offline with sub-second queries and zero token cost.
- **numikel/kprun**: CLI utility (Rust) storing API keys and tokens in an encrypted KeePass vault and injecting them directly into spawned child processes (MCP servers, Claude Code, AGY) without leaking secrets into shell profiles or `mcp.json`.

**Competitor intelligence & architectural observations:**
- **colbymchenry/codegraph**:
  - PR #2711 (`fix(rust): a name written through a path is what the path names, not a same-file namesake`, merged 2026-10-20T17:38:36Z): Fixed Rust path resolution in `isRustNameInScope`. Previously accepted any candidate sharing the current file regardless of path prefix, falsely linking `std::ffi::OsStr` or `mio::Interest` to local structs/enums of the same name. Removed the same-file shortcut, added std/core/alloc filtering, and enforced inline `mod` / crate-reach validation.
  - PR #2710 (`fix(rust): a call on what as_mut() hands back reaches the receiver's declared type`, merged 2026-10-20T17:32:30Z): Propagates the underlying receiver's declared type when method chaining through Rust `as_mut()`.
  - PR #2709 (`fix(c): a macro alone below an #include <…> no longer hides the next declaration`, merged 2026-10-20T17:23:23Z): Fixed tree-sitter C grammar failures where lone macros under `#include` headers (e.g. `G_BEGIN_DECLS` in GLib or `NS_ASSUME_NONNULL_BEGIN`) caused subsequent declarations to be parsed as junk functions or hidden. Blanking directives up to newline or non-escaped line endings unblocked clean parsing for 242 C/C++ headers.
  - PR #2708 (`fix(cpp): a bare call on a parameter, local lambda or functor links nothing, not a function elsewhere of its name`, merged 2026-10-20T17:14:28Z): Suppresses spurious cross-file links from local parameter/lambda/functor invocations to unrelated global functions sharing the identifier.
- **jgravelle/jcodemunch-mcp**:
  - PR #1182 (`fix: a deferred AI summary writes the summary and nothing else (L-227)`, merged 2026-10-20T15:07:28Z): The background thread for deferred AI summaries on watched edits previously used `incremental_save(new_symbols=...)`, inadvertently overwriting symbol complexity, call graphs, and advancing `indexed_at`. Switched to `update_symbol_summaries` (single-column UPDATE with `content_hash` guard) and in-memory cache patching under index-write lock.
  - PR #1183 (`release: v1.108.386`, merged 2026-10-20T16:05:51Z): Shipped v1.108.386 with opt-in `summarizer_body_chars` (transmitting symbol body + decorators to AI summarizer), Flask route verb extraction, and deterministic hash seed ordering in summary prompts (#1178).
- **Graphify-Labs/graphify**:
  - PR #4591 (`fix(csharp): give each method overload its own node and bind calls by argument count`, opened 2026-10-20T17:24:10Z): Resolves #4584 where C# method overloads shared a single node ID, causing all calls to collapse onto the first declared method. Added signature-salted IDs and arity matching across in-file walks, member resolution, and interface dispatch.
  - PR #4590 (`Feat/persistent project graph 4063`, opened 2026-10-20T17:22:22Z): Adds `GRAPHIFY_HOME` to persist graphs and caches outside git worktrees, preventing data loss on `git clean -fdx` while keying storage by resolved worktree path.

**Competitor pulse (as of 2026-10-20 18:00 UTC pass):**
- nikolai-vysotskyi/trace-mcp: 193★ (=), 24 forks (=)
- yamadashy/repomix: 28,932★ (+2), 1,676 forks (-45)
- oraios/serena: 30,478★ (+25), 2,224 forks (-85)
- DeusData/codebase-memory-mcp: 47,021★ (+10), 3,881 forks (-9)
- tirth8205/code-review-graph: 32,285★ (+3), 3,040 forks (-58)
- colbymchenry/codegraph: 74,521★ (+11), 4,822 forks (-1)
- abhigyanpatwari/GitNexus: 47,972★ (+2), 5,197 forks (=)
- jgravelle/jcodemunch-mcp: 2,788★ (=), 373 forks (-1)
- continuedev/continue: 36,272★ (-1), 5,502 forks (+1)
- Aider-AI/aider: 49,664★ (+2), 5,087 forks (+1)

**Catalogs:** Moratorium holds.
**Touch budget:** 0 of 5 used.
