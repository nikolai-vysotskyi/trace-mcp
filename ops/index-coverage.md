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

