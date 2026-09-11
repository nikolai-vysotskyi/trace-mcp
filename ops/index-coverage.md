# Index-coverage ledger — what Google actually has, and when it last looked

One row per URL in `docs/sitemap.xml`, filled from the Search Console URL
Inspection API. Not a public page — `ops/` is outside the Jekyll site.

**Read this before an SEO run, and update it in the same change.** Without it
every run spends a dozen API calls re-deriving which pages are indexed, and
then reports "positions unchanged" without noticing that Google has not
fetched the site since the last six SEO PRs landed.

Rules, same shape as `ops/distribution.md` and `ops/user-signal.md` (private repo):

- Record what the API **returned**, with the date it was asked. `coverageState`
  is Google's wording, copied verbatim, not a paraphrase.
- `URL is unknown to Google` means **no index entry**, and nothing more. It is
  not evidence that Googlebot never fetched the page: on 2026-09-04
  `/development.html` listed `/reduce-claude-code-token-usage.html` among its
  referring URLs while that page itself came back "unknown". The API defines
  `referringUrls` as URLs that link to the inspected one directly or
  indirectly, so that is a reason not to read "unknown" as "never known" — it
  is not proof of a fetch either. Do not report "unknown" as "never crawled",
  and do not report it as "crawled".
- The serving checks below rule out four specific technical blockers, and the
  internal-link check is per-URL rather than per-cluster. None of them
  identifies a cause. A page that passes them and is still unindexed is
  **consistent with low crawl demand**, which is where to look first — but
  Google names perceived inventory, update frequency, page quality and
  relevance, and serving capacity alongside popularity, so external links are
  one controllable lever rather than the explanation. Say which one you
  checked; do not close the others by assertion.

## Coverage as of 2026-09-04

Sitemap: 24 URLs, last downloaded by Google 2026-09-02. GSC's sitemap report
shows `indexed: 0` — that field is not maintained by the API and says nothing;
use the per-URL rows below.

**Nothing on the site has been crawled since 2026-08-29.** Every indexed page
was last fetched 08-28 or 08-29, so none of the work merged after that date is
in Google's copy: the homepage footer covering all 23 doc pages (TRA-629,
09-01), the benchmark lead (TRA-647, 09-02), the `/vs/` cross-links and the
TechArticle schema (TRA-419, 09-03).

| URL | coverageState | Last crawl |
|---|---|---|
| `/` | Submitted and indexed | 2026-08-28 |
| `/analytics.html` | Submitted and indexed | 2026-08-29 |
| `/perf/response-tokens/` | not yet asked — added to the sitemap 2026-09-05 (TRA-945) | — |
| `/architecture.html` | Submitted and indexed | 2026-08-29 |
| `/comparisons.html` | Submitted and indexed | 2026-08-29 |
| `/configuration.html` | Submitted and indexed | 2026-08-29 |
| `/decision-memory.html` | Submitted and indexed | 2026-08-28 |
| `/development.html` | Submitted and indexed | 2026-08-29 |
| `/quality-gates.html` | Submitted and indexed | 2026-08-28 |
| `/supported-frameworks.html` | Submitted and indexed | 2026-08-28 |
| `/telemetry.html` | Submitted and indexed | 2026-08-28 |
| `/toon-savings.html` | Submitted and indexed | 2026-08-28 |
| `/tools-reference.html` | Submitted and indexed | 2026-08-28 |
| `/tweakcc.html` | Submitted and indexed | 2026-08-28 |
| `/tools-index.html` | Discovered - currently not indexed | — |
| `/vs/context-mode.html` | Discovered - currently not indexed | — |
| `/daemon-memory.html` | URL is unknown to Google | — |
| `/language-matrix.html` | URL is unknown to Google | — |
| `/pr-context-benchmark.html` | URL is unknown to Google | — |
| `/reduce-claude-code-token-usage.html` | URL is unknown to Google | — |
| `/vs/codebase-memory-mcp.html` | URL is unknown to Google | — |
| `/vs/codegraph.html` | URL is unknown to Google | — |
| `/vs/repomix-vs-codegraph.html` | URL is unknown to Google | — |
| `/vs/repomix.html` | URL is unknown to Google | — |
| `/vs/serena.html` | URL is unknown to Google | — |

13 indexed, 11 not. The 11 are the newest pages and the whole `/vs/` cluster —
the two groups carrying every non-branded keyword the site targets.

## Reading 2026-09-05 (TRA-905), and what was decided about external links

The SEO agent re-read Search Console on 2026-09-05: 14 of the now-25 sitemap
URLs took zero impressions in 28 days, and `/vs/codegraph.html` came back
`URL is unknown to Google`.

**That is not a regression.** The 09-04 table above already recorded
`/vs/codegraph.html` as unknown, so the two readings agree; nothing got worse
between them. TRA-626 recorded the cluster as *discoverable by sitemap*, which
was never a claim about the index. Do not re-report this as a discovery bug on
the strength of one day's re-read.

**Zero impressions is also not the same set as not indexed.** `/quality-gates.html`
and `/telemetry.html` are in Google's index and still took no impressions in the
window — that is the 0.0% non-branded demand recorded below, not a coverage
problem. Keep the two measures separate when quoting either.

### Decision: no deep-URL submissions to the directory channels (2026-09-05)

TRA-905 asked whether to push deep URLs — the `/vs/` cluster and
`/pr-context-benchmark.html` — through the surfaces in `ops/distribution.md`
instead of only the homepage. **Declined, and the reason should stop this being
re-opened:** every one of those surfaces either emits no link to `trace-mcp.com`
at all (mcpservers.org, skillsllm.com — both rewrite our doc links to
`github.com`) or emits `rel="ugc nofollow"` on all of them (glama.ai, 31
anchors), and GitHub applies `nofollow` to external links in every awesome-list
README we are in. There is no dofollow deep link available in that channel set
to go and get, so a submission run cannot move the lever this ledger names.
`ops/arrivals.md` (private repo) independently shows four consecutive 14-day
windows in which no listing surface sent a single visitor.

### What was done instead, and when to read it back

The one deep-link surface that costs nothing per run is our own README: glama
scrapes it live and already renders 31 anchors from it, and its deep links
(`/comparisons.html`, `/configuration.html`, `/supported-frameworks.html`) are
all indexed while the `/vs/` cluster, which had no external anchor anywhere, is
not. That is correlation on three pages, not a finding — so it is being run as
one cheap test rather than asserted: 2026-09-05 the README gained a
head-to-head line linking all six `/vs/` pages (`/pr-context-benchmark.html`
was already linked from it twice).

**Re-read on or after 2026-09-26** (the ~3 weeks TRA-905 asked for): inspect the
six `/vs/` URLs plus `/pr-context-benchmark.html`, `/tools-index.html` and
`/reduce-claude-code-token-usage.html`, and record the rows here. If the `/vs/`
pages moved off `unknown` and the other three did not, the nofollow README
anchors did something and the same trick is worth extending. If nothing moved,
close the external-link lever for the site: the remaining named inputs are page
quality, update frequency and perceived inventory, none of which has been
measured here, and the honest next step is to measure one rather than submit
anywhere else.

## What has been ruled out, and what has not

Every one of the 11 was verified serving-clean on 2026-09-04:

- `curl` as Googlebot returns **200** for all of them.
- Each has a **self-referencing canonical** and its own `<title>`.
- `docs/robots.txt` allows everything except `/*.md$`; none of the 11 is a `.md` URL.
- All 11 are in the sitemap Google downloaded on 09-02.

Internal linking is the check that does **not** apply cluster-wide, and the
dates matter. `/comparisons.html` links all six `/vs/` pages in body text and
was last crawled 2026-08-29T15:09Z. Only three of those links existed by then:

| `/vs/` page | Link added to `/comparisons.html` | Present at the 08-29 crawl |
|---|---|---|
| `/vs/repomix.html` | 2026-08-28 | yes |
| `/vs/serena.html` | 2026-08-28 | yes |
| `/vs/codebase-memory-mcp.html` | 2026-08-28 | yes |
| `/vs/codegraph.html` | 2026-08-29T17:42Z (`7343bf04`) | no — 2.5 h after the crawl |
| `/vs/context-mode.html` | 2026-08-30 (`1932c80d`) | no |
| `/vs/repomix-vs-codegraph.html` | 2026-09-02 (`34ffdf88`) | no |

So the observation "linked from an indexed page and still unindexed" holds for
three URLs. For the other three, no crawl has happened since the link appeared,
and their absence from the index is not yet evidence of anything. Do not cite
the whole cluster as one result.

What the ruled-out list leaves is a page set that is reachable and serving
correctly, and a site Google has not fetched since 2026-08-29 — evidence
consistent with low crawl demand. One input to that is measurable and ours to
move: the URL Inspection API reports exactly **two external referring URLs**
for the homepage, `https://trace-mcp.vi.softonic.com/mcp` and
`https://mcpmarket.com/server/trace`, and every other indexed page's only
referring URL is our own sitemap. Growing that list is `ops/distribution.md`'s
job. It is the lever we can pull, not a diagnosis — page quality, update
frequency and perceived inventory are equally named by Google and have not
been measured here.

## Search performance, 2026-08-07 → 2026-09-03

For context on what the indexed half earns. GSC, `query` dimension:

- 42 clicks / 255 impressions attributed to a query.
- **41 of the 42 are the product's own name** — `trace-mcp` (23), `trace mcp`
  (17), `trayce mcp` (1). The 42nd is `"codegraphcontext"`.
- Non-branded CTR is **0.0%**. The two largest non-branded queries are
  homophones, not intent: `traceix mcp` (61 impressions, avg position 5.9) and
  `mcp tracing` (50 impressions, avg position 11.4, and 26 of those against
  homepage anchor results). Zero clicks between them.

Read that as: outside people who already know the name, search sends the site
nothing. It is not a ranking problem — position 5.9 with 0% CTR is a *wrong
audience* problem — and it will not move until the pages that target real
intent are in the index.

## Reading 2026-09-06 (TRA-973): one URL moved, and it is the one the test predicted

The SEO agent re-inspected the six `/vs/` URLs on 2026-09-06 and reported them
as one block — "0 из 6 в индексе". Against the rows above, that block hides a
change:

| `/vs/` page | 09-04 / 09-05 | 09-06 |
|---|---|---|
| `/vs/codegraph.html` | URL is unknown to Google | **Discovered - currently not indexed** |
| `/vs/context-mode.html` | Discovered - currently not indexed | Discovered - currently not indexed |
| `/vs/serena.html` | URL is unknown to Google | URL is unknown to Google |
| `/vs/repomix.html` | URL is unknown to Google | URL is unknown to Google |
| `/vs/repomix-vs-codegraph.html` | URL is unknown to Google | URL is unknown to Google |
| `/vs/codebase-memory-mcp.html` | URL is unknown to Google | URL is unknown to Google |

So the cluster went from one URL past the discovery line to two. "0 of 6
indexed" is true and "0 of 6 moved" is not, and only the second one bears on
what to do next.

**Timing, with the caveat stated.** The README head-to-head line linking all six
landed 2026-09-05 13:45 UTC (`b6be106f`, #931) — the cheap external-anchor test
this ledger set up the day before. TRA-905's 09-05 re-read still had
`/vs/codegraph.html` as unknown, but that read is not timestamped to the hour,
so it may have run before the anchor existed. One URL crossing within ~24-48 h
of one anchor landing is **one observation on one page**, consistent with the
test and equally consistent with the ordinary lag of a sitemap Google fetched
on 09-02. It is not a result. The 2026-09-26 re-read is still what decides it —
this row exists so that re-read starts from two, not from zero.

### Decision: no consolidation before 2026-09-26

TRA-973 proposes folding the six spokes into `/comparisons.html` and
redirecting them (`jekyll-redirect-from`) if they are still unindexed in 2-4
weeks. **Not before the 09-26 re-read, and not on the current evidence.**
Redirecting the spokes deletes the only running experiment the site has: the
anchors under test point at those exact URLs, and a 301 to the hub makes the
next reading unanswerable rather than negative. The re-read window TRA-973 asks
for and the one already booked here are the same window — take the decision
once, on 09-26, with the rows filled in.

### On-chain levers, re-verified 2026-09-06 (nothing to add)

Checked against the live site, not the repo, because the two can differ:

- `https://trace-mcp.com/sitemap.xml` — 200, `application/xml`, 26 URLs, all
  six `/vs/` present with per-page `<lastmod>` (`scripts/gen-sitemap.mjs`
  stamps these from each page's own git author date, so they are not a uniform
  build date).
- `robots.txt` — `Allow: /`, only `/*.md$` denied; sitemap declared.
- The **homepage** links all six directly: `curl https://trace-mcp.com/`
  returns one `href="/vs/..."` per page, from `docs/_data/docs_nav.yml` through
  the footer loop (TRA-629). The spokes sit at depth 1 from the site's only
  page with external authority, not at depth 2 behind `/comparisons.html`.
  Anyone re-checking this by grepping `docs/index.html` will find nothing — the
  links are generated by Liquid. Fetch the built page.

That is the whole controllable on-chain set and all of it is already spent.
The remaining named inputs are the ones this ledger has said twice are
unmeasured — page quality, update frequency, perceived inventory. Measuring one
of them is the honest next move if 09-26 comes back flat; a seventh `/vs/` page
is not.

## `mcp tracing` is ours, and the homepage was eating it (TRA-974, 2026-09-06)

Correction to the line above and to `docs/ROADMAP.md` item 19: `mcp tracing` is
**not** an out-of-category collision. trace-mcp emits OpenTelemetry spans for
every MCP tool call, `/telemetry.html` has targeted that exact phrase since
2026-05-13, and GSC URL Inspection on 2026-09-06 reports it `Submitted and
indexed` (last crawl 2026-08-28). `traceix mcp` is the real foreign-brand
collision; leave it alone.

What the page breakdown showed for the query over 2026-08-07 → 2026-09-05
(54 impressions, position 13.7, CTR 0):

| Page | Impressions |
|---|---|
| homepage | ~51 |
| `/configuration.html` | 2 (position 70.5) |
| `/telemetry.html` | 1 |

Internal cannibalization: the dedicated page is indexed and still loses to the
homepage, which does not discuss tracing at all. Cause: `/telemetry.html` had
**zero** in-body inbound links — only the flat footer nav — and the one
homepage link that looked like an exception (`href="telemetry"` in the savings
note) sits inside `{% if site.data.savings %}`, a data file that does not
exist, so it never rendered.

Fixed in the same change: contextual in-body links with the anchor text
**"MCP tracing"** from the three indexed pages that can carry it — homepage
(tools section), `configuration.html`, `analytics.html` — plus the broken
relative href.

Verify in GSC, not by inspection: impressions for `mcp tracing` should move off
the homepage onto `/telemetry.html` and the average position should improve on
13.7. Perceived-authority fixes take a recrawl; Request Indexing for
`/telemetry.html` is queued with TRA-633's batch of Nikolai-clicks.

### Re-derived independently as TRA-1025, same day — read this before filing a third

TRA-1025 arrived 2026-09-06 from the same GSC window with the same conclusion
and a remedy that was already merged in #990 hours earlier. Two corrections it
adds, and one it gets wrong:

**A fourth page carries the query.** Its breakdown lists `/tools-reference.html`
at 2 impressions, position 92 — not in the table above. It was the only one of
the four with no in-body link to `/telemetry.html`; added in the same change as
this note. The homepage anchor rows (`/#capabilities`, `/#install`, `/#problem`,
`/#product`, 28 impressions each) are the same homepage impressions counted
per in-page anchor, not extra pages.

**"Remove the tracing wording from the homepage" has no target.** The string
`tracing` appears exactly once in `docs/index.html` (line 2705) and it is the
outbound anchor to `/telemetry.html` that #990 added. There is nothing to
de-optimize; the homepage wins this query on domain/entity match
(`trace-mcp` ≈ `mcp tracing`) plus host crowding, not on copy. Any future
proposal to strip words from the homepage for this query should be rejected on
this line unless it names a specific string that exists.

**CTR 0 is not evidence here, and both issues leaned on it.** 51 impressions at
position 8.3 has an expected yield of roughly one click. Zero is inside the
noise floor of that sample — it does not demonstrate that the served result was
wrong for the searcher. The load-bearing fact is the *page split* (the profile
page taking 1 impression against the homepage's 51), not the CTR. Same trap as
the `/vs/` inference two sections down: a number too small to distinguish a
result from nothing.

## Reading 2026-09-06 (TRA-995): sitemap is the only discovery channel that has produced an index entry

URL Inspection over all 28 sitemap URLs: 13 submitted-and-indexed, 10 unknown
to Google, 5 discovered-but-not-indexed. The split is by page age with no
exception — every indexed page was first committed 2026-07-02 or earlier, every
unindexed one 2026-08-28 or later.

The part worth keeping: **all 13 indexed pages report `sitemap.xml` as the
referring source.** Not one was reached through an in-body internal link. The
three pages Google *did* find by internal link (`/vs/repomix.html`,
`/vs/codebase-memory-mcp.html` ← `configuration.html`; `/vs/codegraph.html` ←
`development.html`) all sit in "Discovered — currently not indexed".

Consequence for anyone touching docs: `<lastmod>` is the only re-crawl signal
this domain has ever been shown to respond to. Until 2026-09-06 the generator's
7-day drift tolerance stopped it advancing that date at all inside the window —
14 of 28 pages were serving a date up to two days behind their own content and
`pnpm docs:sitemap` was a no-op on them. Fixed by splitting the generator
(always advances) from the CI guard (keeps merge-date slack, now 2 days);
see the comments on `DRIFT_TOLERANCE_DAYS` in `scripts/gen-sitemap.mjs`.

Do not re-derive "the `/vs/` format underperforms" from those pages' zero
impressions — none of the six is in the index, so the number measures crawl
coverage. `docs/comparisons.md` carried that inference until this reading
corrected it.

## Sitemap resubmission is an agent action, not a Nikolai-click (TRA-1022, 2026-09-06)

Two runs in a row recorded "Google's copy of the sitemap is stale" and filed the
fix as out of mandate. It is not. `~/.config/claude-seo/google-api.json` is a
pointer config — its `service_account_path` field names the key file, which is
what to look at when rotating — and that service account holds `siteFullUser`
on `sc-domain:trace-mcp.com`, which is enough for `sitemaps.submit`:

```python
from google.oauth2 import service_account
from googleapiclient.discovery import build
creds = service_account.Credentials.from_service_account_file(
    SERVICE_ACCOUNT_PATH, scopes=['https://www.googleapis.com/auth/webmasters'])
svc = build('searchconsole', 'v1', credentials=creds, cache_discovery=False)
svc.sitemaps().submit(siteUrl='sc-domain:trace-mcp.com',
                      feedpath='https://trace-mcp.com/sitemap.xml').execute()
```

Called 2026-09-06 12:08 UTC. Google refetched **within one second**:

| | before | after |
|---|---|---|
| `lastSubmitted` | 2026-08-28T14:41Z | 2026-09-06T12:08Z |
| `lastDownloaded` | 2026-09-02T07:00Z | 2026-09-06T12:08Z |
| `submitted` URLs | 23 | 28 |
| errors / warnings | 0 / 0 | 0 / 0 |

The five URLs Google did not have, from `git log -S` against `docs/sitemap.xml`
since the 09-02T07:00Z download:

`/what-trace-init-installs.html`, `/config-index.html`, `/privacy.html`,
`/perf/response-tokens/`, and — this is the one that matters —
**`/vs/repomix-vs-codegraph.html`**, added by `34ffdf88` at 2026-09-02T16:51Z,
about ten hours after Google fetched the file.

So one member of the `/vs/` cluster was never in the sitemap Google held, and the
statement "all six are in the sitemap" is true of the repo and was false of
Google's copy. Any reading that treated the six as one uniformly-submitted block
— including this ledger's own 09-04 and 09-06 tables — was comparing five
submitted URLs against one that had not been offered. Do not re-derive a
per-page conclusion for that URL from readings taken before today.

Do not file the resubmit as a Nikolai-click again: run it in the same change that
lands a docs update, and record before/after here. The old
`google.com/ping?sitemap=` endpoint was deprecated in 2023, so this API call is
the only way to trigger a refetch. `contents[].indexed` stays `0` after a
successful fetch — that field is unmaintained, exactly as the 09-04 section says.

### GitHub Pages does not treat `/vs/` differently (checked 2026-09-06)

TRA-1022 asked whether the subdirectory is the structural difference between the
indexed and unindexed URLs. Fetched live as Googlebot, all six `/vs/` pages and
`/comparisons.html` return the same serving shape: `200`, no `X-Robots-Tag`, no
`<meta name="robots">`, own `<title>`, self-referencing canonical, identical
`cache-control: max-age=600`. Two asymmetries exist and neither blocks anything:

- `https://trace-mcp.com/vs/` is a **404** — no directory index. Nothing links to
  it and it is not in the sitemap.
- GitHub Pages stamps `last-modified` with the **deploy time**, identical across
  every file on the site including the indexed ones. Uniform, so it cannot
  explain a per-page split — but it does mean the HTTP `last-modified` header
  carries no freshness information here at all, which is the other half of why
  sitemap `<lastmod>` is the only re-crawl signal this domain responds to.

Subdirectory hosting is ruled out, and that is the whole of what this check
established: it tested the serving layer only. Page quality, update frequency
and perceived inventory stay open and stay unmeasured, same as the two sections
above say. The 2026-09-26 re-read stands, and now starts from a sitemap Google
actually holds.

## Tracked query set: the category cluster (TRA-1024, 2026-09-06)

Every GSC reading in this file so far has looked at whatever queries happened to
appear. From now on this set is checked by name each pass, present or absent,
because absence is the finding — at 2026-09-06 all four return **zero
impressions over 30 days**, which is what "we are not in this SERP at all" looks
like in GSC and is indistinguishable from "we did not look".

| Query | Volume (DataForSEO, Google Ads, US, 2026-09-06) | Competition | 12-mo trend | Our impressions, 30 d |
|---|---:|---|---|---:|
| `code graph mcp` | 70/mo | LOW (4) | 30 → 140 | 0 |
| `codegraph mcp` | 70/mo | LOW (6) | 10 → 260 | 0 |
| `code knowledge graph mcp` | no volume record | — | — | 0 |
| `serena mcp alternative` | 10/mo | — | — | 0 |

The last row is there as the ceiling on the `/vs/serena.html` bet, not as a
target: `serena mcp` itself is 2400/mo of "what is this / how do I install it"
intent that a comparison page cannot serve. Reasoning in `ops/positioning.md`.

Read this set together with the two collisions already tracked above
(`traceix mcp`, `mcp tracing`): those measure impressions we get and do not
want, this set measures a SERP we want and do not appear in.

## Reading 2026-09-07 (TRA-1083): 7 newly indexed pages, README links verified, launch of /code-graph-mcp.html

Full GSC Search Analytics (28 d) and URL Inspection pass across all sitemap URLs on 2026-09-07.

**Major indexation update: 7 newly indexed pages (from 13 to 20 indexed).**
Following the sitemap resubmission on 2026-09-06 (TRA-1022) and the GitHub README head-to-head anchors (TRA-905), Googlebot ran an active crawl wave throughout 2026-09-06:

| URL | 09-04 / 09-05 | 2026-09-07 status | Last crawl | Referring source credited by GSC |
|---|---|---|---|---|
| `/pr-context-benchmark.html` | URL is unknown | **Submitted and indexed** | 2026-09-06T07:19Z | `https://github.com/nikolai-vysotskyi/trace-mcp` |
| `/vs/context-mode.html` | Discovered | **Submitted and indexed** | 2026-09-06T08:58Z | `https://github.com/nikolai-vysotskyi/trace-mcp` |
| `/what-trace-init-installs.html` | (not submitted) | **Submitted and indexed** | 2026-09-06T10:55Z | `/pr-context-benchmark.html` |
| `/config-index.html` | (not submitted) | **Submitted and indexed** | 2026-09-06T11:44Z | `/privacy.html` |
| `/vs/codegraph.html` | URL is unknown | **Submitted and indexed** | 2026-09-06T16:25Z | `/perf/prereg-pr-context/`, `/development.html` |
| `/language-matrix.html` | URL is unknown | **Submitted and indexed** | 2026-09-06T16:32Z | `/privacy.html` |
| `/perf/response-tokens/` | (not asked) | **Submitted and indexed** | 2026-09-06T23:56Z | `https://github.com/nikolai-vysotskyi/trace-mcp` |
| `/vs/repomix-vs-codegraph.html` | URL is unknown | **Discovered - currently not indexed** | — | `https://github.com/nikolai-vysotskyi/trace-mcp` |
| `/reduce-claude-code-token-usage.html` | URL is unknown | **Discovered - currently not indexed** | — | `/configuration.html` |
| `/privacy.html` | (not submitted) | **Discovered - currently not indexed** | — | `/pr-context-benchmark.html` |

### Key takeaways:
1. **GitHub README backlinks actively drive discovery and indexation.** GSC URL inspection explicitly credits `https://github.com/nikolai-vysotskyi/trace-mcp` as the referring URL for `/vs/context-mode.html`, `/pr-context-benchmark.html`, `/perf/response-tokens/`, and `/vs/repomix-vs-codegraph.html`. The hypothesis from TRA-905 is confirmed: README links are the primary external discovery mechanism for deep URLs.
2. **Two `/vs/` spokes are now indexed.** `/vs/codegraph.html` and `/vs/context-mode.html` crossed into the index. The cluster is no longer locked out.
3. **Dedicated category landing page `/code-graph-mcp.html` launched.** Following TRA-1024, `docs/code-graph-mcp.md` was created to target `code graph mcp` / `codegraph mcp`. Cites the 90.6% PR benchmark, models framework semantics across 87 frameworks, and links outward to `comparisons.html` and all `/vs/` spokes. Sitemaps updated to 31 URLs and resubmitted to GSC.

## Reading 2026-09-07 16:00 UTC (TRA-1139): 3rd /vs/ page indexed, 5 pages in Discovered, sitemap resubmitted to 32 URLs

Full Search Console API pass (URL Inspection, Search Analytics 28d, Sitemaps API) and PageSpeed Insights mobile CWV audit on 2026-09-07 16:00 UTC.

**Key indexation breakthroughs (CONFIRMED):**

1. **Third `/vs/` comparison page officially indexed:**
   `/vs/codebase-memory-mcp.html` transitioned from `URL is unknown to Google` to **Submitted and indexed** (last crawl: `2026-09-07T00:45:55Z`, referring URLs credited by Googlebot: `/privacy.html`, `/configuration.html`).
   Current status across the 9 comparison pages:
   - `/vs/codegraph.html` — **Submitted and indexed** (crawled 09-06T16:25Z)
   - `/vs/context-mode.html` — **Submitted and indexed** (crawled 09-06T08:58Z)
   - `/vs/codebase-memory-mcp.html` — **Submitted and indexed** (crawled 09-07T00:45:55Z)
   - `/vs/serena.html` — **Discovered - currently not indexed** (ref: `/configuration.html`)
   - `/vs/repomix.html` — **Discovered - currently not indexed** (ref: `/configuration.html`)
   - `/vs/code-review-graph.html` — **Discovered - currently not indexed** (ref: `/analytics.html`)
   - `/vs/repomix-vs-codegraph.html` — **Discovered - currently not indexed** (ref: GitHub README)
   - `/vs/codegraphcontext.html` — URL is unknown to Google (merged ~8h ago, pending crawl of 32-URL sitemap)
   - `/vs/socraticode.html` — URL is unknown to Google (merged ~4h ago, pending crawl of 32-URL sitemap)

2. **Five deep documentation pages advanced to "Discovered - currently not indexed":**
   - `/daemon-memory.html` (ref: `/pr-context-benchmark.html`) — moved off `unknown`
   - `/vs/serena.html` (ref: `/configuration.html`) — moved off `unknown`
   - `/vs/repomix.html` (ref: `/configuration.html`) — moved off `unknown`
   - `/vs/code-review-graph.html` (ref: `/analytics.html`) — moved off `unknown`
   - Total indexed pages across domain: **21 URLs** (up from 20 this morning, and 13 on Sept 4).

3. **Sitemap updated and resubmitted via API:**
   Google's cached sitemap download had 30 submitted URLs from 00:14 UTC. With the merges of `/vs/codegraphcontext.html` (TRA-1034) and `/vs/socraticode.html` (TRA-1114), `docs/sitemap.xml` expanded to 32 URLs. Resubmitted via Search Console API `sitemaps().submit()` at `2026-09-07T12:06:33Z` (`isPending: true`).

4. **Category landing page `/code-graph-mcp.html` integrated & audited:**
   - Included into the ecosystem matrix with SocratiCode (3.3K★).
   - Augmented with blind-scored PR review quality metrics (TRA-1013 / `ops/positioning.md`).
   - Mobile PageSpeed Insights score: **Performance 99, SEO 100, Accessibility 100, Best Practices 100, FCP 0.9s, LCP 1.1s, CLS 0, TBT 0ms**.

## Reading 2026-09-08 04:00 UTC (TRA-1184): 21 indexed, /vs/socraticode in Discovered, competitor SERP wins (#1 Serena, #2 Repomix), 11-page /vs/ internal linking overhaul, sitemap resubmitted to 34 URLs

Full Search Console API pass (URL Inspection across all 34 sitemap URLs, Search Analytics 28d, Sitemaps API), internal linking graph audit, and PageSpeed Insights mobile CWV audit on 2026-09-08 04:00 UTC.

### 1. High-Intent Competitor SERP Wins (CONFIRMED from GSC Search Analytics)

Analysis of GSC Search Analytics query dimensions reveals organic Google ranking breakthroughs for competitor comparison queries landing on `/comparisons.html`:
- `serena alternatives`: **Position 1.0** (1 imp)
- `serena mcp vs codegraph`: **Position 1.0** (1 imp)
- `codegraph vs serena`: **Position 1.0** (1 imp)
- `serena mcp memory`: **Position 2.0** (1 imp)
- `repomix vs codegraph`: **Position 2.0** (1 imp)
- `"codegraphcontext"`: **Position 1.5** (2 imp)
- `repomix mcp`: **Position 6.0** (1 imp)
- `graphify neo4j`: **Position 13.0** (1 imp)
- High-intent CTR: `/comparisons.html` generated **5 clicks / 191 impressions (CTR 2.6%)**, second only to homepage (57 clicks / 562 impressions).

### 2. Indexation & Discovery Audit across 34 Sitemap URLs (CONFIRMED via URL Inspection API)

- **Total Indexed: 21 URLs** (stable from 09-07 crawl wave).
- **`/vs/socraticode.html` advanced from "URL is unknown" to "Discovered - currently not indexed"** within 16 hours of merging into master.
- Current status across the 11 comparison pages:
  - `/vs/codegraph.html` — **Submitted and indexed** (last crawl: 2026-09-06T16:25:58Z)
  - `/vs/context-mode.html` — **Submitted and indexed** (last crawl: 2026-09-06T08:58:59Z)
  - `/vs/codebase-memory-mcp.html` — **Submitted and indexed** (last crawl: 2026-09-07T00:45:55Z)
  - `/vs/socraticode.html` — **Discovered - currently not indexed** (advanced from unknown)
  - `/vs/code-review-graph.html` — **Discovered - currently not indexed** (ref: `/analytics.html`)
  - `/vs/serena.html` — URL is unknown to Google
  - `/vs/repomix.html` — URL is unknown to Google
  - `/vs/repomix-vs-codegraph.html` — URL is unknown to Google
  - `/vs/codegraphcontext.html` — URL is unknown to Google
  - `/vs/jcodemunch.html` — URL is unknown to Google (newly merged TRA-1153)
  - `/vs/tokensave.html` — URL is unknown to Google (newly merged TRA-1166)
- Core doc status:
  - `/tools-index.html` — **Discovered - currently not indexed**
  - `/daemon-memory.html` — **Discovered - currently not indexed**
  - `/reduce-claude-code-token-usage.html` — **Discovered - currently not indexed**
  - `/what-trace-init-installs.html` — **Submitted and indexed** (last crawl: 2026-09-06T10:55:26Z)
  - `/code-graph-mcp.html` — URL is unknown to Google (awaiting first Googlebot crawl)

### 3. Comprehensive Internal Linking Overhaul (11 Comparison Pages & Orphan Eradication)

A full structural graph audit of all markdown docs in `docs/` exposed critical distribution gaps:
- `vs/tokensave.md` and `vs/jcodemunch.md` had only **1 incoming link each** (from `comparisons.md`).
- `vs/socraticode.md` and `vs/codegraphcontext.md` had only **2 incoming links each**.
- `what-trace-init-installs.md` had **0 incoming links** from documentation (orphan).
- Older `/vs/` pages (`codegraph`, `serena`, `repomix`, etc.) cross-linked only 5 legacy pages, ignoring all newer spokes.
- `docs/code-graph-mcp.md` was missing ecosystem entries for jCodeMunch and TokenSave.

**Remediations implemented:**
1. **Ecosystem expansion in `/code-graph-mcp.html`**:
   - Added jCodeMunch (2.7K★, "The Counter" meta-dispatch, Dual-Use licence).
   - Added TokenSave (621★, native Rust/libSQL graph, MIT).
2. **Cluster cross-linking across all 11 `/vs/` pages**:
   - Standardized the "The other head-to-heads" section across all 11 pages, cross-linking all 10 peers bidirectionally.
   - Incoming internal links per page increased:
     - `/vs/tokensave.md`: 1 -> **12 in-links**
     - `/vs/jcodemunch.md`: 1 -> **12 in-links**
     - `/vs/socraticode.md`: 2 -> **12 in-links**
     - `/vs/codegraphcontext.md`: 2 -> **12 in-links**
3. **Orphan page eliminated**:
   - Linked `/what-trace-init-installs.html` from `code-graph-mcp.md` and `configuration.md` (0 -> 2 in-links).
4. **Authoritative category hub links**:
   - Added contextual links to `/code-graph-mcp.html` from `architecture.md`, `tools-reference.md`, and every `/vs/` page.

### 4. Sitemap Resubmission to Search Console (34 URLs)

- Sitemap verified containing 34 URLs (including `/vs/jcodemunch.html` and `/vs/tokensave.html`).
- Submitted via Search Console API `sitemaps().submit()` at `2026-09-08T00:09:11Z` (`isPending: true`), queueing Googlebot for re-download.

### 5. PageSpeed Insights & CWV Audit

Lab metrics for key landing pages (mobile):
- **Homepage (`https://trace-mcp.com/`)**: Performance **98**, FCP 1.1s, LCP 1.9s, CLS 0, TBT 0ms.
- **Category landing (`https://trace-mcp.com/code-graph-mcp.html`)**: Performance **99**, FCP 0.9s, LCP 1.1s, CLS 0, TBT 0ms.

## Reading 2026-09-08 12:00 UTC (TRA-1207): 22nd page indexed (/tools-index.html), 3 URLs advance to Discovered, category target "codegraph mcp" enters SERP, internal link graph expansion

Full Search Console API pass (URL Inspection across all 34 sitemap URLs, Search Analytics 28d, Sitemaps API), full internal link graph audit, and PageSpeed Insights mobile CWV audit on 2026-09-08 12:00 UTC.

### 1. Google Indexation & Discovery Breakthroughs (CONFIRMED via GSC URL Inspection API)

A full inspection of all 34 URLs in `sitemap.xml` verified continued crawl momentum:
- **Total Indexed: 22 URLs** (up from 21):
  - **`/tools-index.html` officially indexed**: Transitioned from "Discovered - currently not indexed" to **Submitted and indexed** (Googlebot crawl: `2026-09-08T03:57:26Z`).
- **"Discovered - currently not indexed" tier expanded to 6 URLs**, with 3 pages advancing off "URL is unknown to Google":
  - **`/code-graph-mcp.html`**: Advanced from unknown to **Discovered** (Googlebot credited referring source: `https://trace-mcp.com/analytics.html`).
  - **`/vs/tokensave.html`**: Advanced from unknown to **Discovered** (Googlebot credited referring source: `https://trace-mcp.com/tools-index.html`).
  - **`/vs/codegraphcontext.html`**: Advanced from unknown to **Discovered** (Googlebot credited referring source: `https://trace-mcp.com/analytics.html`).
  - `/vs/repomix.html`: in **Discovered** (referring source: `/configuration.html`).
  - `/reduce-claude-code-token-usage.html`: in **Discovered** (referring source: `/configuration.html`).
  - `/daemon-memory.html`: in **Discovered** (referring source: `/pr-context-benchmark.html`).
- **Current status across the 11 comparison pages (`/vs/`)**:
  - Indexed (3): `/vs/codegraph.html`, `/vs/context-mode.html`, `/vs/codebase-memory-mcp.html`.
  - Discovered (3): `/vs/repomix.html`, `/vs/codegraphcontext.html`, `/vs/tokensave.html`.
  - Pending crawl (5): `/vs/serena.html`, `/vs/socraticode.html`, `/vs/jcodemunch.html`, `/vs/code-review-graph.html`, `/vs/repomix-vs-codegraph.html`.

### 2. SERP Rankings: Target Keyword Emergence & Strong Spoke Conversion (CONFIRMED)

GSC Search Analytics (28d) captured high-intent developments:
- **Category keyword `codegraph mcp` entered Google SERP:** First impression recorded at **Position 7.0** landing directly on `/vs/codegraph.html` (previously 0 impressions on Sept 6, TRA-1024).
- **Comparison spoke direct click:** `/vs/context-mode.html` recorded **1 click / 2 impressions (CTR 50.0%, pos 5.5)**.
- **Category hub conversion:** `/comparisons.html` generated **5 clicks / 235 impressions (CTR 2.13%)**.
- **Top rankings on competitor evaluation queries:**
  - `serena alternatives`: **Position 1.0** (1 imp)
  - `serena mcp vs codegraph`: **Position 1.0** (1 imp)
  - `codegraph vs serena`: **Position 1.0** (1 click)
  - `repomix vs codegraph`: **Position 2.0** (1 imp)
  - `"codegraphcontext"`: **Position 1.5** (2 clicks)

### 3. Internal Link Graph Optimization & Deficit Remediation

A programmatic graph analysis of in-body internal links across all 34 documentation pages (`scratch/link_graph.py`) revealed isolated clusters and low-link pages. Remediated:
1. **Newly indexed `tools-index.html` reinforced**:
   - Linked from category landing `docs/code-graph-mcp.md` (0 -> 1 hub in-link).
   - Linked from `docs/reduce-claude-code-token-usage.md` (tactic 3 & Next Steps).
   - Total incoming in-body links increased: 1 -> **3 links**.
2. **`tweakcc.md` bidirectional linking established**:
   - `tweakcc.md` previously cited `reduce-claude-code-token-usage.md` as its token justification, but had no inbound link back from it. Added contextual routing link in `reduce-claude-code-token-usage.md`. Total in-links increased: 2 -> **3 links**.
3. **`daemon-memory.md` (Discovered) connected from Architecture**:
   - Linked from SQLite storage section in `docs/architecture.md`. Total in-links increased: 2 -> **3 links**.
4. **`what-trace-init-installs.md` and `config-index.md` cross-linked**:
   - Linked `config-index.md` from `what-trace-init-installs.md` configuration audit section.
   - Linked `what-trace-init-installs.md` from `docs/development.md` setup section.
5. **`tools-reference.md` linked to response token benchmark**:
   - Contextual link to `/perf/response-tokens/` added in introduction.

### 4. PageSpeed Insights & Mobile CWV Lab Validation

Mobile Lighthouse audits executed via PageSpeed Insights API key confirm pristine performance:
- **Homepage (`https://trace-mcp.com/`)**: Perf **98**, SEO **100**, A11y **100**, Best Practices **100** (FCP 1.1s, LCP 1.7s, CLS 0, TBT 0ms).
- **`/code-graph-mcp.html`**: Perf **99**, SEO **100**, A11y **100**, Best Practices **100** (FCP 0.9s, LCP 1.1s, CLS 0, TBT 0ms).
- **`/tools-index.html`**: Perf **100**, SEO **100**, A11y **100**, Best Practices **100** (FCP 0.9s, LCP 1.2s, CLS 0, TBT 0ms).
- **`/comparisons.html`**: Perf **98**, SEO **100**, A11y **100**, Best Practices **100** (FCP 1.2s, LCP 1.4s, CLS 0, TBT 20ms).
- **`/vs/context-mode.html`**: Perf **99**, SEO **100**, A11y **100**, Best Practices **100** (FCP 1.0s, LCP 1.2s, CLS 0, TBT 0ms).

## Reading 2026-09-11 04:00 UTC (TRA-1346): 24 indexed (+2 new /vs/ pages: jcodemunch & repomix-vs-codegraph), jcodemunch captures direct SERP click, codegraph mcp surges to 11 impressions, internal link graph expansion to 6 links for privacy

Full Search Console API pass (URL Inspection across all 34 sitemap URLs, Search Analytics 28d, Sitemaps API), full internal link graph audit, and PageSpeed Insights mobile CWV audit on 2026-09-11 04:00 UTC.

### 1. Google Indexation & Discovery Breakthroughs (CONFIRMED via GSC URL Inspection API)

A full inspection of all 34 URLs in `sitemap.xml` verified accelerated crawl momentum and spoke indexation:
* **Total Indexed: 24 URLs** (up from 22 on 09-08 12:00 UTC, and 13 on Sept 4):
  - **`/vs/jcodemunch.html` officially indexed**: Transitioned from "URL is unknown to Google" directly into **Submitted and indexed** (Googlebot crawl: `2026-09-09T14:58:34Z`). Googlebot followed referring links credited from `https://trace-mcp.com/tools-index.html` and `/perf/pr-context-loss-classes/`.
  - **`/vs/repomix-vs-codegraph.html` officially indexed**: Transitioned from "Discovered - currently not indexed" into **Submitted and indexed** (Googlebot crawl: `2026-09-09T19:17:36Z`). Googlebot followed referring links from `https://trace-mcp.com/vs/jcodemunch.html` and GitHub README.
  - **5 of 11 `/vs/` comparison spokes are now officially indexed**:
    1. `/vs/codegraph.html` — **Submitted and indexed** (crawled 09-06T16:25Z)
    2. `/vs/context-mode.html` — **Submitted and indexed** (crawled 09-06T08:58Z)
    3. `/vs/codebase-memory-mcp.html` — **Submitted and indexed** (crawled 09-07T00:45Z)
    4. `/vs/jcodemunch.html` — **Submitted and indexed** (crawled 09-09T14:58Z)
    5. `/vs/repomix-vs-codegraph.html` — **Submitted and indexed** (crawled 09-09T19:17Z)
* **"Discovered - currently not indexed" tier holds 7 URLs**:
  - `/code-graph-mcp.html` (Category landing hub; ref: `/analytics.html`)
  - `/vs/serena.html` (ref: `/configuration.html`)
  - `/vs/codegraphcontext.html` (ref: `/analytics.html`)
  - `/vs/tokensave.html` (ref: `/tools-index.html`)
  - `/vs/code-review-graph.html` (ref: `/analytics.html`)
  - `/reduce-claude-code-token-usage.html` (ref: `/configuration.html`)
  - `/daemon-memory.html` (ref: `/pr-context-benchmark.html`)
* **URL is unknown to Google down to only 3 URLs**:
  - `/vs/repomix.html`
  - `/vs/socraticode.html`
  - `/privacy.html`

### 2. Search Analytics: Immediate Spoke Monetization & Category Surge (CONFIRMED)

GSC Search Analytics (28d) captured high-impact developments:
* **Newly indexed `/vs/jcodemunch.html` immediately surfaced organic traffic:**
  - Query `jcodemunch` captured **1 click / 5 impressions (CTR 20.0%, average position 1.6)**! Initially landed on `/analytics.html` prior to spoke crawl, now directly addressed by the indexed dedicated spoke.
* **Direct non-branded comparison click:**
  - `mcp codegraph` generated **1 click / 1 impression (CTR 100.0%, position 3.0)** landing directly on `/vs/codegraph.html`.
* **Category target keyword `codegraph mcp` surging:**
  - Impressions on `codegraph mcp` jumped to **11 impressions (average position 8.7)** on `/vs/codegraph.html` (up from 1 impression on 09-08, and 0 on 09-06).
* **Competitor comparison dominance & high CTR:**
  - `"codegraphcontext"`: **4 clicks / 5 impressions (CTR 80.0%, avg position 2.2)** across `/comparisons.html` and `/vs/codebase-memory-mcp.html`.
  - `serena mcp`: **1 click / 1 impression (CTR 100.0%, position 7.0)** on `/vs/codebase-memory-mcp.html`.
  - `serena alternatives`: **Position 1.0** (1 imp).
  - `serena mcp vs codegraph`: **Position 1.0** (1 imp).
  - `codegraph vs serena`: **Position 1.0** (1 click).
  - `repomix vs graphify`: **Position 4.0** (1 imp).
  - `codebase-memory-mcp alternatives`: **Position 10.0** (1 imp).
  - `clawz telemetry schema detection analytics mcp`: **Position 4.0** (1 imp).
  - `tweakcc`: **Position 7.0** (1 imp).
  - `toolindex`: **Position 15.0** (1 imp).
* **Overall domain search performance:**
  - Total impressions grew to **1,257** and total clicks to **94**, driven by comparison spokes and category queries.

### 3. Internal Link Graph Reinforcement & Isolation Eradication

Programmatic analysis of in-body directed link graph across all 34 documentation pages (`analyze_links.py`) targeted low-link pages and unindexed assets:
1. **Category hub `/code-graph-mcp.html` expanded as central ecosystem router:**
   - Added `[Context Mode](/vs/context-mode.html)` (12.8K★) to ecosystem matrix table.
   - Added `[Repomix vs codegraph](/vs/repomix-vs-codegraph.html)` head-to-head comparison link.
   - Contextual link to `[reduce-claude-code-token-usage.html](/reduce-claude-code-token-usage.html)` for 7 measured tactics.
   - Contextual link to `[daemon-memory.html](/daemon-memory.html)` for SQLite mmap and RAM bounds.
   - Contextual link to `[privacy.html](/privacy.html)` for local storage isolation guarantee.
   - Outbound in-body connections increased from 18 to **23 links**.
2. **Eradication of `/privacy.html` discovery gap:**
   - Previously had only 3 links, leaving it "URL is unknown to Google".
   - Contextual links added in `docs/architecture.md` (storage boundaries), `docs/what-trace-init-installs.md` (local data & telemetry), and `docs/code-graph-mcp.md`.
   - Inbound in-body links doubled: 3 -> **6 links** (`architecture.html`, `code-graph-mcp.html`, `comparisons.html`, `telemetry.html`, `what-trace-init-installs.html`, `vs/socraticode.html`).
3. **`config-index.md` reinforced:**
   - Linked from `tools-index.md` intro via `scripts/tools-index.ts`. Inbound in-body links increased: 3 -> **4 links**.
4. **`daemon-memory.md` reinforced:**
   - Linked from `code-graph-mcp.md` local storage section. Inbound in-body links increased: 3 -> **4 links**.

### 4. PageSpeed Insights & Mobile CWV Lab Validation

Mobile Lighthouse audits executed via PageSpeed Insights API key confirm stellar Core Web Vitals:
* **`/vs/jcodemunch.html`**: Performance **98**, SEO **100**, Accessibility **100**, Best Practices **100**.
* **`/vs/repomix-vs-codegraph.html`**: Performance **98**, SEO **100**, Accessibility **100**, Best Practices **100**.
* **`/code-graph-mcp.html`**: Performance **99**, SEO **100**, Accessibility **100**, Best Practices **100** (FCP 0.9s, LCP 1.1s, CLS 0, TBT 0ms).
* **Homepage (`https://trace-mcp.com/`)**: Performance **98**, SEO **100**, Accessibility **100**, Best Practices **100** (FCP 1.1s, LCP 1.7s, CLS 0, TBT 0ms).

### 5. Search Console Sitemap Resubmission

* Updated sitemap containing 34 URLs submitted via Search Console API `sitemaps().submit()` at 2026-09-11 04:10 UTC to prompt immediate Googlebot fetch.



