# User-signal ledger — where real users show up, and what we already found out

Every channel that could carry a signal from a live trace-mcp user, what it
currently shows, and which ones turned out to be dead ends. Companion to
`ops/distribution.md`: that one tracks where we are *listed*, this one tracks
where users *speak*. Not a public page — `ops/` is outside the Jekyll site.

**Read this before a User Feedback run, and update it in the same change.**
Without it every run re-checks the same four channels, re-discovers that npm
downloads are bot traffic, and reports "nothing found".

Same three rules as the distribution ledger:

- Record what you **verified**, with the date. "Nothing in a web search" is not
  "nobody is talking about us" — see the Reddit row below, where a channel we
  could not read was our single largest referrer.
- Record the **dead ends and why**, not just the state. A blocked door with no
  reason written down gets pushed on again next month.
- Numbers quoted outward come from `docs/_data/counts.yml`. Adoption numbers
  come from the metric of record in `docs/ROADMAP.md`, never from npm.

## Channels

| Channel | Signal as of 2026-09-05 | How to read it | Verified |
|---|---|---|---|
| GitHub issues | **Still zero open.** No external author since `zerocodefast` (#536) on 2026-08-29 — seven days silent. Everything since is dependabot / release-please / our own agents. Last real ones: `drguptavivek` (#381/#382, plugin requests, shipped same day), `cerebrotecnologico` (#199/#334) | `gh api search/issues -f q="repo:… -author:nikolai-vysotskyi"` — cheaper than `gh issue list` and separates humans from bots in one call | 2026-09-05 |
| GitHub discussions | **Not enabled on the repo** — the GraphQL `discussions` node returns nothing. Don't keep "checking discussions"; there is no such surface | — | 2026-08-30 |
| GitHub traffic — views | Flat, fourth window running: 796 views / 192 uniques over 14 days (was 721/185, 568/175). ~14 uniques/day. Top path is the repo root 399/161; `/issues` 38/9, `/releases` 33/7 | `gh api repos/:r/traffic/views` (owner-only) | 2026-09-05 |
| GitHub traffic — referrers | **Google overtook reddit** for the first time: Google 72/36, reddit.com 64/33, trace-mcp.com 44/19, github.com 33/10, `my.feishu.cn` 8/1, `l.threads.com` 7/2, Bing 4/4, yandex 2/1, DuckDuckGo 1/1, chatgpt.com 1/1. Read the swap as noise until a second window agrees — both moved by single digits. Still **not one MCP directory**, fourth window running, and that now includes a 30k-star listing we are actually on (TRA-846) | `gh api repos/:r/traffic/popular/referrers` | 2026-09-05 |
| GitHub traffic — clones | **Not a metric**, and the ramp has stopped. 34,638 / 1,307 uniques trailing 14 days (was 31,518 / 1,245 on 09-03) — a +3,120 increment over two days against +15,512 over the three before it, i.e. back near the pre-burst level while the 14-day total stays inflated. It will decay out of the window on its own by ~09-12 | same API, `/traffic/clones` | 2026-09-05 |
| npm downloads | **Dead as an adoption metric** — settled four times, do not re-derive. The burst ended: 08-27→09-01 ran 1322 / 1555 / 2000 / 1583 / 507 / 427 against an August baseline of 10-48/day. **And from 09-02 the API returns `0` for us, which is backfill lag, not a collapse** — `codebase-memory-mcp`, `repomix` and `mcp-server-git` all read `0` over the same days while `react` and `@modelcontextprotocol/server-filesystem` have data through 09-02. Always confirm a zero against a high-volume control before reporting it | `api.npmjs.org/downloads/range/<from>:<to>/<pkg>` — the daily range, never `point/last-week` | 2026-09-05 |
| Reddit | Our largest referrer, and **we cannot read it** — see the dead-end note below | Human with a browser | 2026-08-30 |
| Threads (`l.threads.com`) | Small but real referral (7 views / 2 uniques). Source post never identified; Threads search is login-walled the same way Reddit is | Human with an account | 2026-08-30 |
| Hacker News | Still no mention. `nbHits: 0` for `"trace-mcp"` and for `search_by_date` on `"trace mcp"`. `ops/launch-hn.md` drafted and unposted — Nikolai's call | `curl hn.algolia.com/api/v1/search?query=%22trace-mcp%22` — no key, no rate limit, one call. Use this, not WebSearch | 2026-09-05 |
| Blogs / dev.to / Zenn / Qiita | No mention of trace-mcp found on any of them | WebSearch | 2026-08-30 |
| Desktop app (`packages/app`) | **Zero public feedback, ever** — no issue, review or mention has been about the Electron app specifically. Every reported bug to date is server/daemon/indexing. Read "no complaints" here as "no observed users", not as "it works" | — | 2026-08-30 |
| The daily ping (`adoption.yml`) | **The richest channel we have, and the one this ledger was missing.** Every install describes itself once a UTC day: `client`, `model`, `version`, `country`, `install_type`, `repos_indexed`, `calls`, `preset`, `tools_advertised`, `daemon_starts`. Read as *shape of the installed base*, never as an audited count — the credentials ship in the published bundle. See the two findings below | `git show origin/adoption-data:adoption.yml`. Written daily by `.github/workflows/ga4-snapshot.yml` | 2026-09-03 |
| GitHub forks | **18 → 15 forks**; three were deleted between 09-03 and 09-05. Still not one fork carries a commit of its own, so the channel carries no "what users had to patch" signal and the count is the only thing that moves. Two are ecosystem mirrors, not users: `iflow-mcp/nikolai-vysotskyi-trace-mcp` and `bradparks/trace-mcp___jcodemunch-mcp_fork` | `gh api repos/:r/forks`, compare each `created_at` with `pushed_at`; where later, `gh api repos/:r/compare/master...<owner>:<repo>:<branch>` and read `ahead_by` | 2026-09-05 |
| GitHub dependents | **Structurally dead, don't re-check.** `network/dependents` reads 0 repositories and 0 packages. That is correct rather than surprising: trace-mcp is run as an MCP server via `npx`/global install, so it never appears in anyone's `package.json`, and the dependents graph only sees declared dependencies. It cannot ever carry signal for a product shaped like ours | `network/dependents` page | 2026-09-03 |
| Chinese-language dev web | No mention found (searched 代码索引 / MCP 服务器 / 节省 token phrasings). Worth re-checking now that `my.feishu.cn` shows as a referrer, but the referrer is a private workspace doc, not a public post — expect nothing findable | WebSearch in Chinese | 2026-09-03 |
| GitHub code search | **New channel, and the only one that produced a finding this week.** Others' repos that name us in committed files. Signal is thin but real; noise is heavy — `trace-mcp` collides with dynatrace-mcp, playwright-trace-mcp, retrace-mcp, bpftrace-mcp and an in-house `trace-mcp-server.ts` at `semaj90/deeds_web_app`, so every hit needs opening before it counts. Verified ours as of 09-05: `mattbutlerengineering/ai-tooling` (a full evaluation of us — TRA-845), `davila7/claude-code-templates` + 7 of its forks (our own listing — TRA-846), `QuesmaOrg/awesome-ai-tokenomics`, `Chat2AnyLLM/awesome-claude-plugins`, `Arnon-hs/open-source`, `SAIRAMANALADI/vybe-intelligence-vault` (an agent-run digest that has stamped us daily since 08-05), `aibot88/sec_skill_store` (a third-party Claude skill wrapping us). **Zero** real hits for `filename:.mcp.json` or `filename:claude_desktop_config.json` — every one was a dynatrace collision, so no public repo commits a trace-mcp client config | `gh api -X GET search/code -f q='"trace-mcp" -repo:nikolai-vysotskyi/trace-mcp'`, then the `filename:` and `"npx trace-mcp"` variants. Needs a token with code-search scope | 2026-09-05 |
| Third-party comparison blogs | One found, and it omits us: `saurabhsharma.dev/blogs/code-graph-mcp-tools-comparison/` (2026-07-02) ranks code-review-graph vs Graphify vs codebase-memory-mcp on token efficiency, language coverage and Claude Code integration — our exact three closest competitors and our exact criteria, with no mention of trace-mcp. July, so predates most of what we would want cited | WebSearch on the category, not on our name — searching our name only returns our own pages and directory mirrors | 2026-09-05 |
| Third-party evaluations of us | **One exists and nobody had read it**: `mattbutlerengineering/ai-tooling` carries `evaluations/trace-mcp.md`, a source-grounded review of v1.43.1 stamped 2026-06-22. It is the only outside write-up that engages with our code rather than our README, and it names its own re-evaluation trigger (a hands-on benchmark on a real polyglot project). It also publishes **"no telemetry"**, stale since v1.47.0. Answered once in [ai-tooling#585](https://github.com/mattbutlerengineering/ai-tooling/issues/585) 2026-09-04 (TRA-857) | Read the eval file itself, not the catalog row — the objections are the signal. Full ledger entry in `ops/distribution.md` | 2026-09-04 |
| Directory listings | Tracked in `ops/distribution.md`, not here | — | — |

## Findings that should not be re-derived

**Someone outside evaluated us, and we were one tier below `codegraph`**
(2026-09-05). `mattbutlerengineering/ai-tooling` holds
`evaluations/trace-mcp.md` — the first substantive third-party read of the
project any run has found. Verdict `discovery-log — tentative read`, against
codegraph's ADOPT. Source-grounded but hands-off, stamped `Last verified:
2026-06-22` against v1.43.1 at 88 stars. What it praises is unprompted and
therefore informative: framework-aware cross-language edges as the
differentiator, and `benchmark.ts` self-labelling as a synthetic estimator —
"the transparency is better than most". What blocks the upgrade is, in their
words, that the headline "~42 minutes" is "marketing, not a measured or even
computed figure"; they grepped for it and found one README hit with nothing
deriving it. Their stated re-evaluation trigger is a hands-on benchmark on a
real polyglot project, which is exactly `pr-context-benchmark` — the thing
TRA-647 says appears zero times in `README.md` and `docs/index.html`. Full read
and what to do about it: TRA-845. **Do not re-open the evaluation looking for
more; it has been read line by line.** Re-check only if the file's git history
moves. One correction it makes about us in public is now wrong: it says "no
telemetry", read off the June source, while the ping shipped 2026-08-23.

**The biggest surface we are listed on was never in the distribution ledger**
(2026-09-05). `davila7/claude-code-templates` (30,531 stars, 3,459 forks) ships
`cli-tool/components/mcps/devtools/trace-mcp.json`. Both commits are Nikolai's
(#553 on 2026-04-29, #844 refreshing the counts on 2026-08-29), so it is our
own placement that the ledger built to prevent re-discovery never recorded —
including a refresh a week ago. It also sends no measurable traffic, fourth
window running. TRA-846.

**`active_users.week` has equalled `active_users.month` in every snapshot that
exists** (2026-09-05). 90/90 on 09-03, 102/102 on 09-04, and
`scripts/ga4-snapshot.mjs` genuinely queries different ranges, so the month
figure carries no information the week figure does not. The 61 → 90 → 102 climb
is therefore consistent with a 28-day window still filling — the ping only
reached published builds on 2026-08-23, and `savings.days` reads `6` on a query
starting 2025-01-01 — rather than with growth. `retention_dau_mau_pct` is
`day / month`, so while month equals week it is day-over-week, not DAU/MAU.
**Do not grade the metric of record until week and month diverge.** TRA-843,
which also covers the savings tripwire: `tokens_saved_raw` ran 5.21× the
sanitized figure on 09-04 and `capped_days` is 2 of 6 — the flooding signal
this file defines, fired, into a file nobody reads.

**`by_client` on 2026-09-03 is 90% pre-fix data and must not be interpreted
yet** (2026-09-03). Today's snapshot reads `unknown: 55`, `(not set): 36`,
`claude-code: 11`, `codex-mcp-client: 4`, and one each of `antigravity-client`,
`grok-shell-trace-mcp`, `opencode`, `pi-mcp-trace-mcp`. Applying the
denominator rule from `docs/ROADMAP.md` — divide a `customEvent:` breakdown by
its own total, never by `active_users` — 55 of the 74 installs that *sent* a
value still say `unknown`, which is worse than the 25 of 36 read on 09-01.

That is not a regression. The bug that produced it (the ping's final
`saveState` erasing the client name recorded mid-request) was fixed in
TRA-643/#748, and that fix first ships in **v3.12.0, published 2026-09-02
11:40 UTC** — about nineteen hours before this snapshot was taken, against a
rolling 28-day window. `by_version` puts **12 of 120 rows on ≥3.12.0**
(3.14.0: 10, 3.12.0: 1, 3.13.0: 1), so roughly nine in ten of the population
being averaged physically cannot report a client correctly.

The consequence is a sequencing one, and it lands on `by_client_used_pct` —
the figure `adoption.yml` itself calls "the one that decides distribution
strategy" (TRA-673). Registering `calls` in GA4 is still urgent, because GA4
never backfills and every unregistered day is lost for good. But the first
weeks of that data will be computed over a population that is mostly
client-blind, so **repeat the read, do not grade a strategy on it.** The gate
to watch is the ≥3.12.0 share of `by_version`; wait for it to pass half before
reading a per-client split as anything.

**Two things in the funnel are blank for permission reasons, not data
reasons** (2026-09-03). `adoption.yml` currently carries four `error:` strings,
and it is worth knowing which are waiting on a human and which on nothing:

- `acquisition.error: "popular/referrers: HTTP 403"` and
  `views_uniques_14d: null` — GitHub's traffic endpoints need
  `Administration: read`, a scope `GITHUB_TOKEN` cannot be granted. The
  workflow reads `secrets.GH_TRAFFIC_TOKEN` and falls back to `GITHUB_TOKEN`,
  so the 403 says that secret is unset. The data is fine: the same call from a
  run with the owner's token answers instantly, which is where every referrer
  figure in this file comes from. This blanks the funnel's whole *arrivals*
  stage.
- `activation.error` (`customEvent:repos_indexed`), `usage.error`
  (`customEvent:calls`), `by_preset` / `by_tools_advertised` empty, and
  `daemon.error` (`customEvent:daemon_starts`, `daemon_unclean_stops`) — six
  fields the client already sends and the property does not know. GA4 does not
  backfill any of them.

So five of the funnel's stages and breakdowns are dark, and none of it is a
code problem. This is one console session plus one fine-grained PAT.

**The month count stepped 61 → 90 while the day count fell 54 → 39**
(2026-09-03). `events_28d` went 310 → 425 over the same two days. A rising
28-day count with a falling daily one is what arrivals-without-return looks
like, and `retention_dau_mau_pct: 43` is consistent with that. But
`docs/ROADMAP.md` says to treat a step change as suspect until corroborated,
and this one overlaps the npm/clone harvest window exactly, so it is not yet
safe to read as growth. What would settle it: the ping only fires from
`createServer` (`src/server/server.ts:733`), so downloading a tarball or
cloning the repo cannot produce one — but an automated directory scanner that
*launches* the server can, and `isDisabled` only excludes `CI=true`. The
discriminator is whether the new population looks like scanners: one country,
one arch, `repos_indexed: 0`, no second-day ping. `by_country` cannot answer it
today ("(not set)" is 54 of 120) and `repos_indexed` is unregistered, which is
the same console session as above.

**Amended 2026-09-05 (TRA-843): most of that step is the window, not a
population.** The property holds about a fortnight of pings — it reached
published builds on 2026-08-23, and the savings query returns six days of rows
against a 2025-01-01 start — so a 28-day window is still filling, and a month
figure computed over two weeks of data climbs as it does. The
`retention_dau_mau_pct: 43` quoted above was day-over-fortnight, not a DAU/MAU;
the snapshot now publishes `null` there until `active_users.month_window_full`,
so the caveat travels with the number. The scanner question above is unaffected
and still open — this says the *shape* of the climb is explained, not that the
new installs are human.

Do not re-derive this from `week == month`. Both snapshots have it (90/90, then
102/102) and it looks like proof, but `activeUsers` counts distinct users:
equality only says the older period's users are a subset of this week's, which a
mature property whose audience all returned would satisfy too. The first version
of the fix gated on it and was caught in review — one non-returning day-8 user
would have unlocked a ten-day ratio published as DAU/MAU. Gate on the age of the
data.

**3.9.0 is still invisible in the field** (2026-09-03, second window). It
appears nowhere in `by_version` while 3.8.0 holds 19 installs and 3.10.0 holds
26. Consistent with TRA-566 (v3.9.0 shipped with no Windows assets and no
`latest.yml`) and now agreed by two independent snapshots, though still not
*proven* to be that. 3.8.0 outweighing every fix-carrying version four days
and seven releases later is the upgrade-path question, not a telemetry one.

**Reddit is the biggest thing we cannot see** (2026-08-30). It sends more views
than Google does, so a thread or comment mentioning trace-mcp exists and is
live, but nothing within an agent's reach can read it:

- `reddit.com/search.json` returns **403** to any non-browser client, old.reddit
  included.
- The `WebSearch` tool **refuses `reddit.com`** outright — its user agent is
  blocked on Reddit's side, so `allowed_domains: [reddit.com]` errors out.
- Bing has **no indexed result** for `site:reddit.com "trace-mcp"` — comments
  are indexed poorly, so the mention is most likely a comment, not a submission.
- DuckDuckGo's html/lite endpoints answer with an anti-bot challenge (HTTP 202).
- Every reachable redlib/libreddit mirror now sits behind an **Anubis
  proof-of-work** gate (`safereddit.com`, `redlib.tiekoetter.com`; others 403).

Decision: **we do not solve those challenges.** They exist specifically to keep
automated clients out, and working around them from Nikolai's machine is not
something we do. This channel needs a human with a logged-in browser — a
90-second search for `trace-mcp` on Reddit, sorted by new. Until someone does
that, "no community signal found" in a run report means "no *readable* signal",
and the report should say so. Re-check whether the gates changed at most
quarterly; none of this is likely to open up sooner.

**The Aug-2026 harvest hit git as well as npm** (2026-08-30). The npm
per-version flatness documented in `docs/ROADMAP.md` was read as a registry
mirror. It is broader than that: repo clones ramped ~50× over the same days
(08-25 → 08-29) with human page views dead flat, so something is enumerating
the project across both distribution surfaces at once. Nothing to fix — but any
future "our numbers exploded" report leaning on clones or downloads is reading
this, and both were already known to be junk before it started.

**The savings tripwire has fired, and it now fires somewhere** (2026-09-05,
TRA-843). `adoption.yml` described a widening gap between `tokens_saved` and
`tokens_saved_raw` as "the signal that someone is flooding the endpoint", while
writing it to a file nobody diffs. It went 4.95× → 5.21× in a day — raw grew 68M
on a base of 77M — with `capped_days` reaching 2 of 6, over a window that
overlaps the Aug-2026 harvest above. No published number was ever wrong: the
sanitizer capped every one of those days, and `usd_saved` is not rendered on the
site. What was wrong was that the signal had no receiver.

Settled: past 2× (`INFLATION_RATIO` in `scripts/ga4-savings.mjs`), the snapshot
emits `raw_ratio` and `inflation_suspected` into the file and a `::warning` onto
its workflow run, and `refresh-savings.mjs` warns on stderr before anyone
publishes the number. **Deliberately not a failure** — this file's whole premise
is that the snapshot is the only durable record of the trend, so failing the run
would answer a flood by discarding the day's evidence of it. Do not re-open that
as "the threshold should be blocking"; the sanitizer is the protection, this is
only the notification.

**The plugin-request template is the healthiest channel we have** (2026-08-30).
Four requests across three unrelated users (`marshmallow`, `click`,
`@tanstack/react-table`, `passport`), each naming a concrete framework a real
project depends on, each shipped. When a user has a structured way to say
exactly what they need, they use it. If we want more signal, more channels
shaped like that one beat more places to post.

**#199 has had three of our follow-ups and no reply** (2026-08-30). The reporter
last spoke on 2026-06-07; we pinged on 08-21, 08-26 and 08-29. The relay
(`list_projects` + `call_project_tool`, #357) most likely covers the ask. **Do
not ping again** — a fourth "still there?" on a silent thread is our activity,
not the user's. Close it on its merits or leave it; either beats another ping.

**`Mnehmos/trace-mcp` is an unrelated project with our name** (2026-08-30). It
holds the `trace-mcp` slot on LobeHub (already in `ops/distribution.md`) and
also on `mcprepository.com/mnehmos/trace-mcp`. 0 stars, untouched for ~9 months,
a schema-mismatch analyser — no relation. Expect it to keep surfacing in
searches; it is a name collision, not a competitor and not a fork.
