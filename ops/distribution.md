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

| Surface | Listed | What it shows | How to change it | Verified |
|---|---|---|---|---|
| [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io) | Yes — `io.github.nikolai-vysotskyi/trace-mcp` | Current: 3.1.1, correct counts | Automatic: `.github/workflows/publish-mcp-registry.yml` republishes `server.json` on every release (GitHub OIDC, no secret) | 2026-08-29 |
| [glama.ai](https://glama.ai/mcp/servers/nikolai-vysotskyi/trace-mcp) | Yes | Correct — scrapes README/npm live | Nothing to do; fix the README and it follows | 2026-08-29 |
| [pulsemcp.com](https://www.pulsemcp.com/servers/nikolai-vysotskyi-trace) | Yes | **Stale: "44+ tools"** — their hand-written `server.json`, kept "until the maintainer publishes to the official registry" | Their submissions are **paused**; their own submit page says publishing to the official registry is the fix. Done 2026-08-29 — waiting on their next sync | 2026-08-29 |
| [mcpservers.org](https://mcpservers.org/servers/nikolai-vysotskyi/trace-mcp) | Yes | Body correct; **header stale**: "53 framework integrations across 68 languages, 100+ tools" | Free form at `/submit` (no account, needs a contact email). Correction submitted 2026-08-29, review ≤12h — but it said "80 languages … up to 99% fewer tokens", and master has since moved to 81 languages and a 40–50% claim, so re-submit once it lands. Premium $39 — declined | 2026-08-29 |
| [mcpmarket.com](https://mcpmarket.com/server/trace) | Yes, as **"Trace"** | Same stale "53 frameworks / 68 languages" copy | No self-serve edit. $29 paid listing, or email support@mcpmarket.com. Free queue re-submit answers "already listed" | 2026-08-29 |
| [mcp.so](https://mcp.so) | **No** | — | **Free submission no longer exists** — `/submit` offers only "Pay and submit automatically", $39. They ingest the official registry, so expect a free pickup | 2026-08-29 |
| [smithery.ai](https://smithery.ai) | **No** | — | Two blockers, not one: the account needs GitHub OAuth (an agent must not authorize that on Nikolai's behalf), **and** a stdio server is published as an MCPB bundle — `smithery mcp publish ./server.mcpb -n <org>/<name>`, per `smithery.ai/docs/build/publish.md`. There is **no `smithery.yaml`** in their current docs; older writeups describing one are stale. They also ingest the official registry | 2026-08-29 |
| [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) | **Yes** | Listed under `Developer Tools`, alphabetical, with the Glama badge and an accurate description | PR to README. Their CONTRIBUTING asks automated agents to append `🤖🤖🤖` to the PR title. Nothing to submit — only re-read the entry when the product's shape changes | 2026-09-01 |
| [hashgraph-online/awesome-ai-plugins](https://github.com/hashgraph-online/awesome-ai-plugins) | **Yes** | Listed under `Community Plugins → Development & Workflow` | PR to README. PR #182 merged 2026-08-31 by `kantorcodes` without requiring third-party scanner action | 2026-09-01 |
| [wong2/awesome-mcp-servers](https://github.com/wong2/awesome-mcp-servers) | **No** | — | **Not a separate door.** Its README refuses PRs outright and redirects to `mcpservers.org/submit` — the same form as the mcpservers.org row above. Treat the two as one channel | 2026-08-29 |
| [Cline MCP Marketplace](https://github.com/cline/mcp-marketplace) | **No** — checked their live catalog API (`api.cline.bot/v1/mcp/marketplace`, 199 entries), not a web search | — | Closest thing to an open door left. Open an issue on `cline/mcp-marketplace` with their `mcp-server-submission` template: repo URL, a **400×400 PNG** logo, reason for addition. `llms-install.md` is optional — their FAQ says a well-written README is usually enough (there is no crawler; Cline itself reads the README at install time). Their step 3 also asks the submitter to confirm they have watched Cline set the server up from the README alone. The logo is now in-repo at `docs/icon-400x400.png`. No account or payment — but that step-3 checkbox is **required**, so this is not an agent-alone submission; see "Next door to try" | 2026-08-29 |
| [Docker MCP Catalog](https://github.com/docker/mcp-registry) | **No** — listed all 328 entries of `servers/` via the GitHub contents API | — | **Blocked on an artifact we don't have.** Both paths need something trace-mcp isn't: "Local" wants a Dockerfile in our repo, "Remote" wants a reachable streamable-http/SSE endpoint. A plain npm/stdio package qualifies for neither. Adding a Dockerfile is a product decision, not a listings one — don't smuggle it in as distribution work | 2026-08-29 |
| Continue.dev Hub | — | — | **Dead product, not a gap.** Continue was acquired by Cursor (June 2026), the final release shipped 2026-06-19, cloud data was deleted after 2026-07-15, `hub.continue.dev` no longer resolves. The GitHub repo is **not** archived and is still public — do not describe it as read-only — but it has shipped nothing since (last commit 2026-07-21). Re-check only if Cursor stands a successor up | 2026-08-29 |
| [LobeHub](https://lobehub.com/mcp) | **No** — the `trace-mcp` listing there is `Mnehmos/trace-mcp`, an unrelated project with the same name | — | Publishing is `npx @lobehub/market-cli`, and it requires `lhm login` (browser OIDC) plus `lhm github connect` (browser ownership check). There is no token-only path: verified in `@lobehub/market-cli@0.0.41` itself, because their docs pages under `lobehub.com/docs/market/*` are content-free stubs. `plugin publish` and `plugin claim` both go through `createUserSDK()`, which aborts with "Not logged in. Run `lhm login` first" unless a user OAuth token is on disk; the `MARKET_CLIENT_ID`/`MARKET_CLIENT_SECRET` env pair is never used for publishing. Human-only, like Smithery | 2026-08-29 |
| GitHub repo topics | **Yes** — always on, the surface is ours | **20 of 20 slots used** — the cap. Changed 2026-08-30: dropped `token` and `tokens` (3,892 / 1,572 repos, almost all auth or crypto — wrong audience for a word we only meant one way) and `claude-skill` (near-duplicate of `claude-skills`, which is the bigger of the two: 7,662 vs 4,841); added `code-graph` (208 repos), `dependency-graph` (901) and `static-analysis` (8,072) | The one listing surface we own outright: `gh api -X PUT repos/:r/topics --input <json>`, instant, reversible, no review. Topic pages are a browse surface, so a *small* exact topic like `code-graph` is worth more than a big vague one. Sizes via `gh api "search/repositories?q=topic:<t>&per_page=1" --jq .total_count`. Before rebalancing again: 7 of the 20 slots are `claude-*` variants (8 before this change), which is defensible but is where the next slot comes from; `rag` (43,793) is the other weak slot — we retrieve, but we are not a RAG pipeline | 2026-08-30 |

The repo's own `description` and `homepage` are part of that surface and were
left alone — the description already leads with the clients and a concrete
number, which is what a GitHub search result needs.

Community channels (Hacker News, Reddit) are not in this table because they are
not listings — nothing there is maintained, only posted once. The drafted
material lives in `ops/launch-hn.md` and `ops/launch-reddit.md`, and posting it
is Nikolai's call. What those channels currently *say about us* — and which of
them can actually be read from a run — is tracked in `ops/user-signal.md`.

## macOS code signing and notarization

**Signed and notarized from the first release after 2026-08-29** (TRA-436).
Before that the app was ad-hoc signed (`Signature=adhoc`,
`TeamIdentifier=not set`), so a browser download picked up
`com.apple.quarantine` and Gatekeeper called it damaged — confirmed on
Nikolai's machine. The macOS release now ships a **DMG per architecture** for
humans plus the zip the staged-zip updater consumes, both built from a
Developer ID Application-signed, notarized, stapled `.app`.

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

**`hesreallyhim/awesome-claude-code` requires web UI issue form submission** (verified 2026-09-01).
Requires ≥14 days active development or ≥100 stars; accepts only web issue templates.

**`korchasa/awesome-mcp` is an automatically compiled list** (verified 2026-09-01).
Compiles automatically from GitHub `mcp` topic and indexed repositories.


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

Every directory in the table has now been checked at least once, and **none of
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

So the remaining doors sort into: needs a browser login (Smithery, LobeHub),
needs money (mcp.so, mcpmarket), needs a product decision (Docker's Dockerfile),
or needs someone to witness an install (Cline). The last is by far the cheapest.

**Do not run `trace-mcp daemon stop` while testing on a developer machine.** It
does not just stop the daemon — it writes `~/.trace-mcp/daemon.disabled`, which
persistently disables auto-spawn for every later stdio session on that machine,
including the user's own. Undo with `trace-mcp daemon start`. Learned the hard
way while verifying the install above.
