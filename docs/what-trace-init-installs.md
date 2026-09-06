---
title: "What trace init installs — startup audit, guard hooks and Read/Bash mirrors"
description: "The half of trace-mcp that is not an MCP tool: what trace init writes to your machine — a startup-block audit, guard hooks, opt-in mirrors, client config."
updated: 2026-09-06
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
per detected client. None of it is reachable through `tools/list`, so a reader
who installed us as "an MCP server" never finds out it is there.

**The rule the whole door runs on:** we change configuration you could change
yourself, and we tell you what we changed. We do not patch your client's
binary, intercept its traffic, or rewrite files we do not own.

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

**When trace-mcp is not reachable, the guard gets out of the way.** No
heartbeat, a stale one, a stalled channel: every branch degrades to
allow-with-warning rather than denying a call the tools cannot answer either.

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
`trace init --mirror` installs it, a plain `trace init` never does. It is a
`bash` + `jq` pipeline, so it is not available on Windows yet.

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

**`tweakcc` is a third-party tool that you install and run yourself.** It
patches Claude Code's system prompts. trace-mcp patches nothing — we document
the pairing and generate the text you can choose to apply, and the patching is
an action you take with someone else's tool on your own machine.

We draw that distinction every time this comes up, because the boundary above
is what makes the rest of this page safe to install: changing a config file you
own is a product, patching a binary you did not build breaks at the vendor's
next update. `tweakcc` is an optional amplifier on one client, not a
foundation. If we ever could not draw the distinction honestly, the pairing
would leave the public surfaces before the boundary moved.

What it is for and how to apply it: [system prompt routing via
tweakcc](tweakcc.md).

---

## How much of this reaches your client

Door two is mostly Claude-Code-shaped, and the page would be lying by omission
if it did not say so.

| Client | What door two gives it |
|---|---|
| Claude Code, Claw Code | Everything on this page: hooks, the guard, the mirrors, the routing block, the `tweakcc` pairing |
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
- Re-run `trace init` and pick a lower tier to drop the hooks and keep the
  instruction block.

Nothing here deletes a config key it did not write. An entry you configured
yourself on the MCP server object survives a rename or a re-init.
