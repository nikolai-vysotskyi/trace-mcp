# The `trace` rename — decision, boundary, and cutover order

Decided 2026-09-02 (TRA-644). **Go, with a boundary: `trace` is the command,
`trace-mcp` is the project.** Everything local to a developer's machine takes
the short name. Nothing addressable from the outside world changes.

Read this before touching any rename issue, and before proposing a rename of
the package, the domain, the repo, the registry entry or the app bundle —
those are decided, not open.

## Why not the full rename

**It was never available.** `trace` on npm is taken: `AndreasMadsen/trace`,
"Creates super long stack traces", latest 3.2.0, last published 2024-10-23
(verified against `registry.npmjs.org` on 2026-09-02). So `npx trace` can
never be our install command. The install line is the single most-copied
string we have — it is in the client config of every user, in every directory
listing, and on every page of the site. A rename that cannot reach it is not a
rename; it is a second name. The only real question was where the line between
the two names sits.

**The token case does not move that line.** TRA-613 (#720) measured a real
`initialize` + `tools/list` round-trip on four tokenizers: `mcp__trace-mcp__x`
→ `mcp__trace__x` is 2 tokens per tool on GPT tokenizers, 3 on Claude and
Gemini — **66 / 120 / 366 tokens** off the `minimal` / `standard` / `full`
preset, i.e. **0.74–1.23%** of a surface that already costs 8k–45k. This is
not an efficiency change, and it must not be described as one anywhere.

**So put the line where the tokens are.** Every token in the measurement sits
in two places: the MCP server key that prefixes every tool name on every turn,
and the CLI verb in prose. Every cost sits in the other places: the domain and
its indexed URLs, the registry entry, ~10 directory listings, the GitHub
identity, the app bundle. Renaming those buys exactly zero tokens.

**The generic-word objection dissolves at that boundary.** Nothing searchable
becomes "trace". The repo, the domain, `server.json` and every directory entry
keep `trace-mcp`, so search still disambiguates us the way it does today.
`trace` appears only where someone has already found us — their shell and
their client config. mcpmarket.com's existing **"Trace"** listing stops being a
thing to correct and becomes accurate; no paid edit, no email.

**This is the normal shape, not a compromise.** ripgrep ships `rg`, neovim
ships `nvim`, the_silver_searcher ships `ag`, kubernetes ships `kubectl`.
Nobody reads those as half-finished renames. "Half-renamed" is only a failure
mode when the boundary is unstated — which is what this file fixes.

## What the boundary costs

Two real costs. Both are stated rather than absorbed.

**1. macOS already has a `trace`.** `/usr/bin/trace` is Apple's `trace(1)` —
"record and modify trace files", a performance-analysis tool (verified on a
Tahoe machine, 2026-09-02). On the usual developer PATH the npm global prefix
comes first and ours wins; on a PATH where `/usr/bin` wins, `trace add .` runs
Apple's tool and prints an error that never mentions us. Handling: both bin
names stay installed **permanently**, and the migration docs name the
collision and `trace-mcp` as the unambiguous form. Do not remove the
`trace-mcp` bin, ever.

**2. The tool prefix moves, and users wrote it down themselves.**
`mcp__trace-mcp__*` → `mcp__trace__*`. `init` migrates the server entry it
owns; it cannot migrate what the user typed — permission allowlists, custom
hooks, their own `CLAUDE.md` prose (#730 says so in its own known-limitations
section). This is the one place where ~1% of tokens buys a real interruption,
and it is the only part of this program worth extra engineering. Tracked as
**TRA-650**; until it lands, the migration docs must tell people to grep their
own config for `mcp__trace-mcp__`.

## Per-surface disposition

| Surface | Decision | Why |
|---|---|---|
| CLI binary | `trace` added, **`trace-mcp` kept forever** | ergonomics; additive and reversible. See the `/usr/bin/trace` collision above |
| MCP server key in client configs | → `trace`, auto-migrated by `init` | the only place the measured tokens are |
| Config paths `~/.trace`, `.trace.json` | → new, old read as fallback, one-time atomic rename | local, migrated, reversible per install |
| User-written tool-name references (allowlists, hooks, prose) | needs its own migration pass | the one real breakage |
| Analytics `tool_server` classification | must accept `trace`, `trace-mcp`, `trace_mcp` | otherwise the headline savings metric reports zero. See "Ordering" |
| npm package name | **stays `trace-mcp`. Permanently.** | `trace` taken since 2024. Never announce a package rename |
| trace-mcp.com, its URLs and titles | **unchanged** — no redirects, no canonical churn, no title rewrites | 5 of 13 pages are already unindexed (TRA-350, blocked) and the `/vs/` cluster is sitemap-only (TRA-626). We have no index coverage to spend |
| GitHub repo name, topics, description | **unchanged** | the repo name is the registry namespace and every inbound link; 20/20 topic slots are already spent on words people search for |
| MCP registry `server.json` name | **stays `io.github.nikolai-vysotskyi/trace-mcp`** | it is republished on every release and is what mcp.so, Smithery and PulseMCP ingest. Changing the identity downstream directories key on, to save no tokens, is a pure distribution risk |
| ~10 external directory listings | **no rename submissions.** Count corrections already in flight stand | nothing to correct — under this decision the listings are right as they are |
| Electron bundle `productName` / `appId` / `app.name` | **do not rename** — TRA-636 cancelled | moves `userData` (every install loses persisted state), renames the `.app` mid-update, and risks the electron-updater path we only just got working (TRA-437/562/566) — for zero tokens |
| Docs / README | one migration section, stating the boundary | it is not "we renamed to trace", it is "the project is trace-mcp, the command is `trace`" |

## Ordering

One hard constraint, and the board currently violates it.

1. **TRA-641 first — analytics keys.** `src/analytics/rules.ts:244` and
   `real-savings.ts:190` classify our own calls as
   `tool_server === 'trace-mcp' || 'trace_mcp'`. TRA-614's "Migrate to trace"
   button is merged to master and is **not** in v3.11.0 — so the window is
   still open. The moment the release carrying it ships, a user clicks
   Migrate, their sessions log `trace`, and `get_optimization_report` /
   `get_real_savings` attribute **zero savings** — the product's headline
   number, silently wrong, with no error. Land the shared-constant fix before
   the next release.
2. **Then TRA-611 (#730)** — server identity, config paths, client
   auto-migration.
3. **Then TRA-615 (#717)** — docs. Rewrite it to describe the boundary, not a
   rename.
4. **TRA-650** — migrate the tool-name references users wrote themselves
   (allowlists, hook matchers, prose). Not a blocker for #730; the failure
   mode is an interruption, not data loss.
5. **Never: TRA-636** — bundle rename. Cancelled.

**Nothing in this program is irreversible.** That is the whole point of the
boundary: every changed surface is on a user's own disk, dual-named, and
migrated by code we control.

## No human-only doors

This decision needs no browser login, no purchase, no paid listing edit, no
domain and no registry re-identification. The batched ask for Nikolai that
TRA-644 anticipated is **empty** — that is the result, not an omission.

## First-party confirmation: the string is the traffic (added 2026-09-05, TRA-879)

The table above decided the domain, the package and the on-page titles on the
argument that we have no index coverage to spend. GSC now says something
stronger — those surfaces are not merely cheap to keep, they are the entire
funnel.

Search Analytics, `sc-domain:trace-mcp.com`, 2026-08-06 → 2026-09-04:

| Query | Impressions | Clicks | Avg position |
|---|---|---|---|
| `trace-mcp` | 89 | 24 | 1.5 |
| `trace mcp` | 38 | 17 | 1.4 |
| `trayce mcp` | 10 | 1 | 3.1 |
| `"codegraphcontext"` | 2 | 2 | 1.5 |
| `traceix mcp` | 61 | 0 | 6.0 |
| `mcp tracing` | 54 | 0 | 13.7 |
| everything else (10 queries) | ~21 | 0 | — |

53 clicks total. 41 (77%) from the two exact strings `trace-mcp` / `trace mcp`,
44 (83%) from some spelling of the name. **Zero** from any query describing what
the product does — nothing containing "code graph", "context", "token" or
"MCP server for…" earned a click.

The two largest impression sources are both name collisions we already lose:
`traceix mcp` (61 impressions, position 6.0) is a different product with the
same prefix, and `mcp tracing` (54 impressions, position 13.7) is the
observability category. 115 impressions, no clicks — and that is what the
late-August impression spike was made of (10–20/day → 48 on 08-29 → 93 on
09-02, clicks flat at 2–3, CTR ~15% → 2.2%). More impressions here is not
growth.

So `-mcp` is doing load-bearing work in the SERP: it is the token that
disambiguates us from `traceix` and from tracing/observability, *and we are
losing both collisions while still carrying it*. Dropping it from anything
searchable removes the disambiguator from the only string that converts.

Nothing in the disposition table changes — this is the confirmation, not a
revision. What changes is that the three surfaces are now guarded in CI rather
than by this document alone: `tests/docs/searchable-name.test.ts` fails if
`site.title`, `site.url`, the home page `<title>`/`og:title`, the JSON-LD
Organization/WebSite `name`, the npm `name`/`mcpName`/`homepage`, the
`server.json` identity or the `trace-mcp` bin loses the string. A rename sweep
that reaches them now breaks the build instead of the funnel.

**PLAUSIBLE, not confirmed:** that a rename would cost clicks — a name cannot
be A/B tested. Confirmed is that 100% of current clicks depend on the current
string and that a semantically adjacent name already collides badly in this
same SERP. No independent search-volume figure for `trace` vs `trace-mcp`
(DataForSEO was unreachable on that runtime); GSC is first-party and enough for
the claim above.

*Measured by the SEO Agent autopilot, TRA-876 → TRA-879.*

### Second window, wider: 90 days says the same thing (added 2026-09-05, TRA-907)

An independent GSC read on the same property over 2026-06-05 → 2026-09-02 —
three months, not one — lands on the same ratio: 101 clicks, of which 98 (97%)
came from `trace-mcp`, `trace mcp`, `trayce mcp` or `mcp trace`. Non-brand
clicks in a full quarter: two, both `"codegraphcontext"` → `/comparisons.html`.
The one-month and three-month windows agreeing rules out the reading that the
77–83% brand share was an artefact of the late-August impression spike.

It also sharpens what a redirect can and cannot buy, which is the part worth
remembering on cutover day: a 301 preserves link equity for a URL, it does not
make anyone type a new name into Google. The asset here is query demand for a
string, and nothing on our side controls that. Under the boundary above the
question does not arise — the domain, the package and the on-page copy all keep
the string, and `tests/docs/searchable-name.test.ts` now also asserts the
*visible* home page copy carries it, not only the metadata. Should a domain
move ever be reopened, the new host must be verified in Search Console and the
Change of Address tool used **before** the cutover; it does not work
retroactively.

*Measured by the SEO Agent autopilot, TRA-907.*

## If someone reopens this

The two facts that close it are checkable in under a minute and should be
re-checked rather than argued with:

```
curl -s https://registry.npmjs.org/trace | jq '.name, .["dist-tags"]'   # taken
man 1 trace                                                            # Apple's
```

Reopen only if `trace` frees up on npm **and** the token figure moves by an
order of magnitude. Neither has an obvious path.
