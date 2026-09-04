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

| Channel | Signal as of 2026-09-03 | How to read it | Verified |
|---|---|---|---|
| GitHub issues | **Zero open issues.** #199 closed on its merits 2026-09-03 (the relay from #357 covers the ask) — the last external thread is now shut. No new external reporter since `zerocodefast` (#536) on 2026-08-29. Last real ones: `drguptavivek` (#381/#382, plugin requests, shipped same day), `cerebrotecnologico` (#199/#334, repeat power user) | `gh issue list --state all` | 2026-09-03 |
| GitHub discussions | **Not enabled on the repo** — the GraphQL `discussions` node returns nothing. Don't keep "checking discussions"; there is no such surface | — | 2026-08-30 |
| GitHub traffic — views | Still flat and still the one honest adoption number: 721 views / 185 uniques over 14 days, 13-23 uniques/day (was 568 / 175). Three 14-day windows now agree on ~13-23 uniques/day | `gh api repos/:r/traffic/views` (owner-only) | 2026-09-03 |
| GitHub traffic — referrers | **reddit.com still #1** (87 views / 33 uniques), Google #2 (77/34), trace-mcp.com #3 (40/19), github.com, then `my.feishu.cn` (8/1 — a link inside a Lark/Feishu workspace, so a Chinese-language team doc; login-walled the same way Reddit is), `l.threads.com` (7/2), Bing, yandex, DuckDuckGo, `chatgpt.com` (1/1). Not one MCP directory appears — third window agreeing, see `ops/distribution.md` | `gh api repos/:r/traffic/popular/referrers` | 2026-09-03 |
| GitHub traffic — clones | **Not a metric**, and still running. 31,518 clones / 1,245 uniques in the trailing 14 days (was 16,006 / 928 on 08-30), peaking 8,736 on 08-29, dipping to 1,019 on 08-31, back to 4,627 on 09-02 — while human views stayed at ~20 uniques/day throughout. Unique cloners inflate too (49 → 360) | same API, `/traffic/clones` | 2026-09-03 |
| npm downloads | **Dead as an adoption metric** — settled three times now, don't re-derive. See `docs/ROADMAP.md` and the note in `docs/comparisons.md`. 2026-09-03 added the cheapest possible proof and a real baseline: the *daily* curve. August ran at **10-48 downloads/day**, then 08-27 → 09-01 went 1322 / 1555 / 2000 / 1583 / 507 / 427 and fell back. So the "5,033 weekly" figure this row carried on 08-30 was ~90% a six-day burst inside the same window as the clone ramp below, not a level. Peer control over the same days: `codebase-memory-mcp` holds a flat **830-1591/day** with no burst at all | `api.npmjs.org/downloads/range/<from>:<to>/<pkg>` — the daily range, never `point/last-week`, which averages the burst into the baseline | 2026-09-03 |
| Reddit | Our largest referrer, and **we cannot read it** — see the dead-end note below | Human with a browser | 2026-08-30 |
| Threads (`l.threads.com`) | Small but real referral (7 views / 2 uniques). Source post never identified; Threads search is login-walled the same way Reddit is | Human with an account | 2026-08-30 |
| Hacker News | No mention, and now checked at the source rather than through a search engine: `hn.algolia.com/api/v1/search?query="trace-mcp"` returns `nbHits: 0`, as does `search_by_date` for `"trace mcp"`. `ops/launch-hn.md` is drafted and unposted — posting is Nikolai's call | `curl hn.algolia.com/api/v1/search?query=%22trace-mcp%22` — no key, no rate limit, answers in one call. Use this, not WebSearch | 2026-09-03 |
| Blogs / dev.to / Zenn / Qiita | No mention of trace-mcp found on any of them | WebSearch | 2026-08-30 |
| Desktop app (`packages/app`) | **Zero public feedback, ever** — no issue, review or mention has been about the Electron app specifically. Every reported bug to date is server/daemon/indexing. Read "no complaints" here as "no observed users", not as "it works" | — | 2026-08-30 |
| The daily ping (`adoption.yml`) | **The richest channel we have, and the one this ledger was missing.** Every install describes itself once a UTC day: `client`, `model`, `version`, `country`, `install_type`, `repos_indexed`, `calls`, `preset`, `tools_advertised`, `daemon_starts`. Read as *shape of the installed base*, never as an audited count — the credentials ship in the published bundle. See the two findings below | `git show origin/adoption-data:adoption.yml`. Written daily by `.github/workflows/ga4-snapshot.yml` | 2026-09-03 |
| GitHub forks | **18 forks, and not one carries a single commit of its own.** Every fork's `pushed_at` equals its `created_at` except `vitaly-z/trace-mcp`, and comparing that one gives `ahead_by: 0, behind_by: 449` — it synced our commits, it did not change anything. Forks here are bookmarks and mirrors, not adaptation, so this channel carries no "what users had to patch" signal. Two forks are ecosystem mirrors, not users: `iflow-mcp/nikolai-vysotskyi-trace-mcp` (Chinese MCP tooling account, already noted in `docs/development.md`) and `bradparks/trace-mcp___jcodemunch-mcp_fork`, renamed by its owner to sit beside `jgravelle/jcodemunch-mcp` — someone comparing the two | `gh api repos/:r/forks` and compare each fork's `created_at` with its `pushed_at`; for any where `pushed_at` is later, `gh api repos/:r/compare/master...<owner>:<repo>:<branch>` and read `ahead_by` | 2026-09-03 |
| GitHub dependents | **Structurally dead, don't re-check.** `network/dependents` reads 0 repositories and 0 packages. That is correct rather than surprising: trace-mcp is run as an MCP server via `npx`/global install, so it never appears in anyone's `package.json`, and the dependents graph only sees declared dependencies. It cannot ever carry signal for a product shaped like ours | `network/dependents` page | 2026-09-03 |
| Chinese-language dev web | No mention found (searched 代码索引 / MCP 服务器 / 节省 token phrasings). Worth re-checking now that `my.feishu.cn` shows as a referrer, but the referrer is a private workspace doc, not a public post — expect nothing findable | WebSearch in Chinese | 2026-09-03 |
| Third-party evaluations of us | **One exists and nobody had read it**: `mattbutlerengineering/ai-tooling` carries `evaluations/trace-mcp.md`, a source-grounded review of v1.43.1 stamped 2026-06-22. It is the only outside write-up that engages with our code rather than our README, and it names its own re-evaluation trigger (a hands-on benchmark on a real polyglot project). It also publishes **"no telemetry"**, stale since v1.47.0. Answered once in [ai-tooling#585](https://github.com/mattbutlerengineering/ai-tooling/issues/585) 2026-09-04 (TRA-857) | Read the eval file itself, not the catalog row — the objections are the signal. Full ledger entry in `ops/distribution.md` | 2026-09-04 |
| Directory listings | Tracked in `ops/distribution.md`, not here | — | — |

## Findings that should not be re-derived

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
