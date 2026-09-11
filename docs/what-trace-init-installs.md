---
title: "What trace init installs — guard hooks, Read/Bash mirrors and client config"
description: "What trace init writes to your machine and how to audit it: guard hooks, opt-in Read/Bash mirrors, the routing block, client config, tweakcc tiers."
updated: 2026-09-08
---

# What `trace init` installs

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": {{ page.title | jsonify }},
  "description": {{ page.description | jsonify }},
  "url": "https://trace-mcp.com/what-trace-init-installs.html",
  "datePublished": "2026-09-06",
  "dateModified": {{ page.updated | jsonify }},
  "author": {
    "@type": "Person",
    "name": "Nikolai Vysotskyi",
    "url": "https://github.com/nikolai-vysotskyi"
  },
  "publisher": {
    "@type": "Person",
    "name": "Nikolai Vysotskyi",
    "url": "https://github.com/nikolai-vysotskyi"
  },
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "https://trace-mcp.com/what-trace-init-installs.html"
  }
}
</script>

trace-mcp arrives through two doors, and which door a thing comes through is
decided by **how it is installed**, not by what it does.

Door one is the tool surface: the code graph, decision memory, the state
tools, the startup audit. You install it by adding an MCP server, and a
preset governs how much of it your client sees — [tools
reference](tools-reference.md).

Door two is this page. `trace init` writes files to your machine: hooks your
agent harness runs, a routing block in your instruction file, and an MCP entry
per detected client. None of that is reachable through `tools/list`, so a reader
who installed us as "an MCP server" never finds out it is there. The startup
audit below is a door-one tool — it is here because it is where to start, not
because `init` installs it.

**The rule the whole door runs on:** we change configuration you could change
yourself, and we tell you what we changed. We do not patch your client's binary,
intercept its traffic, or rewrite files we do not own. The one thing that goes
past that line is the Max tier's `tweakcc` pairing, which patches Claude Code's
system prompts through a third-party tool that `init` invokes for you — it has
[its own section](#the-tweakcc-pairing-and-the-line-it-sits-next-to) rather than
a footnote, and you can decline it.

---

## Start here: audit the block you already pay for

Every session pays for its startup block before you type anything — the
harness system prompt, tool schemas, every MCP server's instructions, the skill
and agent listings, `CLAUDE.md`, and whatever your `SessionStart` hooks print.
You are billed for it on the first turn and again on every cache rebuild.

`get_startup_context_audit` measures **yours**. Not a decomposition we took on
our machine and asked you to generalise from — your own logs, read locally from
`~/.claude/projects/*.jsonl`, nothing leaving the machine.

It answers four things:

- **What the block is made of**, by source, with hooks named individually.
- **What it costs** — its share of the input-side bill, plus the mid-session
  cache rebuilds that make you pay for it twice.
- **What went unused** — an MCP server whose instructions loaded into every
  start and whose tools were never called; a skill listed at every start and
  never invoked.
- **Where it says the same thing twice** — `textCompression` compares your
  `CLAUDE.md` / `AGENTS.md` / `MEMORY.md` against the instruction text other
  sources actually sent, and proposes deletions with a diff.

Every recommendation rests on **evidence of non-use over a stated window**,
never on size. A tool missing from the startup block is a tool the agent will
not call, so a suggestion made because something is big can cost its reader far
more than it saves.

`apply_startup_recommendations` applies one, backed up first — the desktop app
puts a button on it — and `rollback_startup_recommendations` restores the exact
prior bytes in one action. Backups live under `~/.trace/startup-backups/` and
are never deleted automatically.

Full parameters and payload shape: [analytics and token
tracking](analytics.md#get_startup_context_audit).

---

## The guard: routing that survives a long session

The failure mode with tool routing is not forgetting, it is skipping. The
`CLAUDE.md` block says "use the graph"; the agent reaches for `Grep` anyway
under load, or after compression drops the block out of context.

`trace-mcp-guard` is a `PreToolUse` hook on `Read|Grep|Glob|Bash|Agent`. It
does not intervene on an isolated call — routing a one-question lookup through
us was measured as a regression, not a saving. It waits for the session to
actually be crawling: navigation-class calls are redirected from the third
attempt inside a five-minute window (`TRACE_MCP_GUARD_NAV_MIN`,
`TRACE_MCP_GUARD_NAV_WINDOW`). Relationship questions — who calls this, what
breaks if I change it, which tests cover it — bypass the gate and route from
the first call.

**When trace-mcp is not reachable, the guard stops routing.** No heartbeat, a
stale one, a stalled channel: every navigation-cost branch — `Read`, `Grep`,
`Glob` and guarded `Bash` exploration — degrades to allow-with-warning rather
than denying a call the tools cannot answer either. Two rules stay outside that
fallback because they are not cost tradeoffs: the `.env` secrets rule, and the
`Agent(Explore)` rule.

---

## The mirrors: cheaper output, and an honest result

`trace-mcp-mirror` is a `PostToolUse` hook on `Read|Bash`. The native tool runs
untouched; the hook compresses its output before the model sees it and spills
the full result to disk, referenced by path — so the agent can pull the whole
thing back when the window is not enough.

The compression is deterministic and model-free: collapse repeated lines, drop
build and install progress noise, keep a head/tail window of what is left. The
same output always produces the same replacement, and the hook only ever
rewrites the message being appended, never one already in the prompt prefix.

**The result, stated plainly: cost down, capability flat.** The 24/12-line
window compresses 52% of the paid band offline, and across 108 live runs it
moved the solve rate by **0 percentage points**. That is a real measurement of
a real saving, and it is not a capability claim — we are not going to dress it
up as one. The wider character cap that takes the band to 62.6% has not been
through a live gate yet, so it stays behind `TRACE_MCP_MIRROR_CAP`.

Because it is the one hook that changes what the model reads, **it is opt-in**:
`trace init --mirror` installs it, and a plain `trace init` never opts you in.
Once you have opted in, later `init` runs refresh the installed hook without the
flag, so a fix to the script reaches you without your having to remember it. It
is a `bash` + `jq` pipeline, so it is not available on Windows yet.

---

## What else `init` writes

| What | Where | Notes |
|---|---|---|
| MCP server entry | each detected client's native config | JSON, TOML or YAML depending on the client — see [supported MCP clients](configuration.md#supported-mcp-clients) |
| Tool routing block | `CLAUDE.md` / `AGENTS.md` | Only the block it generated; your own prose is not rewritten |
| IDE rules file | `.cursor/rules/trace.mdc`, `.windsurfrules` | The Cursor and Windsurf equivalent of the routing block |
| Lifecycle hooks | `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd` | Inject decision memory across the session lifecycle instead of waiting for the agent to ask |
| Reindex hook | `PostToolUse` on `Edit|Write|MultiEdit` | Keeps the graph current as the agent edits |
| Precompact hook | `PreCompact` | Injects the session snapshot into the compacted context, so a compaction does not lose the thread |
| Allowlist and matcher rewrites | `settings.json`, `settings.local.json` | Renaming `trace-mcp` → `trace` also renames the tool prefix a hook matcher or permission entry references |

Three enforcement tiers pick how much of this you get: **Base** is the
instruction block alone, **Standard** adds the guard hooks, **Max** adds the
`tweakcc` pairing below. Each tier adds to the one before it; nothing is
removed.

---

## The `tweakcc` pairing, and the line it sits next to

**`tweakcc` is a third-party tool, and the Max tier runs it for you.** It is not
ours: it is [`tweakcc`](https://github.com/Piebald-AI/tweakcc), and what it does
is patch Claude Code's system prompts. What trace-mcp does is write prompt files
into `~/.tweakcc/system-prompts/` and then shell out to
`npx -y tweakcc@4.3.3 --apply`. The patching is tweakcc's; the decision to
invoke it, at the Max tier, is ours, and saying anything softer than that would
be untrue of the code.

The version is **pinned**, not `latest`: the exact spec lives in
`src/init/tweakcc.ts` (`TWEAKCC_VERSION`), is mirrored into `package.json` so it
appears in the dependency graph, the release SBOM and dependabot, and
`tests/ci/supply-chain-pins.test.ts` fails the build if the two drift apart or if
any `npx` in `src/` loses its version. A bump is therefore a reviewable PR, not
something the registry can decide on your machine after our release.

Deciding whether you already have tweakcc is a **filesystem check** — the config
directory, then the `PATH`. It used to be `npx tweakcc --version`, which is not a
check: npx installs a missing package, and with the output piped it does so
without prompting. Nothing is downloaded and no third-party binary is run before
you answer the tier question.

**Max is the default when `init` runs non-interactively** against Claude Code,
Claw Code or Claude Desktop. Interactively it is the preselected option and the
prompt says so. `--skip-hooks` turns it off, as does picking Base or Standard.
Know which tier you are agreeing to before you agree to it.

That is the one place the rest of this page's boundary is under strain, so it is
stated here rather than smoothed over: everything else `init` touches is
configuration you own and could edit yourself, and system prompts are not that.
`tweakcc` is an optional amplifier on one client, not a foundation. If the
distinction ever stopped being drawable, the honest move would be to drop the
pairing, not to soften the boundary.

What it is for and how to apply it: [system prompt routing via
tweakcc](tweakcc.md).

---

## How much of this reaches your client

Door two is mostly Claude-Code-shaped, and the page would be lying by omission
if it did not say so.

| Client | What door two gives it |
|---|---|
| Claude Code | Everything on this page: hooks, the guard, the mirrors, the routing block, the `tweakcc` pairing |
| Claw Code, Claude Desktop | The same hooks and tiers. `tweakcc` patches Claude Code's own installation, so the Max tier is offered here but the patch lands there |
| Cursor, Windsurf | A rules file and the MCP entry — there is no hook equivalent in these tools |
| Every other supported client | The MCP entry, plus whatever the tool descriptions carry |

The startup audit itself is door one — it is an MCP tool, so any client that
speaks MCP can call it, but it reads Claude Code and Claw Code session logs and
has nothing to read elsewhere.

Nothing on this page has been measured on a client other than Claude Code.

---

## Undoing it

- `rollback_startup_recommendations` — reverses one apply, byte-for-byte.
- `TRACE_MCP_MIRROR_DISABLE` — any non-empty value passes tool output through
  untouched, without uninstalling anything.
- `trace setup-hooks --uninstall --global` — removes the guard hook. The
  lifecycle four are a separate flag:
  `trace setup-hooks --uninstall --lifecycle --global`. Pass `--global` on both:
  `init` writes to `~/.claude/settings.json`, and without the flag these
  commands operate on the project-level file instead.

**Re-running `init` at a lower tier does not remove what a higher tier
installed.** The tier decides what gets written, and there is no inverse branch:
pick Base after a Standard or Max run and the guard, the lifecycle hooks and the
`tweakcc` prompt files stay where they are. Uninstalling is the separate command
above, and the `tweakcc` prompt files come out through `tweakcc` itself.

Nothing here deletes a config key it did not write. An entry you configured
yourself on the MCP server object survives a rename or a re-init. For the
complete reference of configuration settings, paths, environment variables,
and local storage policies, see [configuration](configuration.md), the
[config index](config-index.md), and [privacy](privacy.md).
