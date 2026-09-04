# Index-coverage ledger — what Google actually has, and when it last looked

One row per URL in `docs/sitemap.xml`, filled from the Search Console URL
Inspection API. Not a public page — `ops/` is outside the Jekyll site.

**Read this before an SEO run, and update it in the same change.** Without it
every run spends a dozen API calls re-deriving which pages are indexed, and
then reports "positions unchanged" without noticing that Google has not
fetched the site since the last six SEO PRs landed.

Rules, same shape as `ops/distribution.md` and `ops/user-signal.md`:

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
