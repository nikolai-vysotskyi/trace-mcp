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

| Channel | Signal as of 2026-08-30 | How to read it | Verified |
|---|---|---|---|
| GitHub issues | 1 open (#199), everything else closed. Last external reporters: `drguptavivek` (#381/#382, plugin requests, shipped same day), `cerebrotecnologico` (#199/#334, repeat power user), `zerocodefast` (#536, directory invite) | `gh issue list --state all` | 2026-08-30 |
| GitHub discussions | **Not enabled on the repo** — the GraphQL `discussions` node returns nothing. Don't keep "checking discussions"; there is no such surface | — | 2026-08-30 |
| GitHub traffic — views | Flat and honest: 568 views / 175 uniques over 14 days, 13–23 uniques/day, no trend. This is the one adoption number that survived scrutiny | `gh api repos/:r/traffic/views` (owner-only) | 2026-08-30 |
| GitHub traffic — referrers | **reddit.com is #1** (90 views / 35 uniques / 14 days), Google #2 (84/39), trace-mcp.com #3, then github.com, `l.threads.com` (7/2), Bing, yandex | `gh api repos/:r/traffic/popular/referrers` | 2026-08-30 |
| GitHub traffic — clones | **Not a metric.** 16,006 clones / 928 uniques in 14 days, ramping 166 → 619 → 1,251 → 3,888 → 8,736/day over 08-24…08-29 while human views stayed at ~20/day. Unique cloners inflate too (62 → 300), so clone *uniques* are no safer than clone counts | same API, `/traffic/clones` | 2026-08-30 |
| npm downloads | **Dead as an adoption metric** — settled twice, don't re-derive. See `docs/ROADMAP.md` and the note in `docs/comparisons.md`. Re-confirmed 2026-08-30: 5,033 weekly downloads, of which 4,420 sit in 23 versions inside a 152–228 band, while the two newest releases (3.5.2, 3.6.0) show **zero**. Peer control over the same days: `codebase-memory-mcp` puts 50% of its volume on one version, we put 4.5% | `api.npmjs.org/versions/<pkg>/last-week` | 2026-08-30 |
| Reddit | Our largest referrer, and **we cannot read it** — see the dead-end note below | Human with a browser | 2026-08-30 |
| Threads (`l.threads.com`) | Small but real referral (7 views / 2 uniques). Source post never identified; Threads search is login-walled the same way Reddit is | Human with an account | 2026-08-30 |
| Hacker News | No mention. `ops/launch-hn.md` is drafted and unposted — posting is Nikolai's call | WebSearch / hn.algolia.com | 2026-08-30 |
| Blogs / dev.to / Zenn / Qiita | No mention of trace-mcp found on any of them | WebSearch | 2026-08-30 |
| Desktop app (`packages/app`) | **Zero public feedback, ever** — no issue, review or mention has been about the Electron app specifically. Every reported bug to date is server/daemon/indexing. Read "no complaints" here as "no observed users", not as "it works" | — | 2026-08-30 |
| Directory listings | Tracked in `ops/distribution.md`, not here | — | — |

## Findings that should not be re-derived

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
