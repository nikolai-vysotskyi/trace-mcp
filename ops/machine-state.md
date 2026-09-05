# What trace-mcp changes on a machine — the whole list, and who was asked

Every persistent change trace-mcp makes outside its own working memory: what
triggers it, whether the user is told at the moment it happens, and how it is
undone. Not a public page — `ops/` is outside the Jekyll site in `docs/`. The
user-facing half of this (a privacy page, a first-run notice) is TRA-887's
deliverable; this file is the source it is written from.

Written for TRA-937, because three separate findings turned out to be the same
finding:

- [#936](https://github.com/nikolai-vysotskyi/trace-mcp/issues/936) — the daemon
  registers and indexes every project root an MCP client connects from. Measured
  by [@axisrow](https://github.com/axisrow/trace-mcp-plugin/issues/4): 9 roots in
  the registry within a day of one install, `trace-mcp add` never run.
- TRA-887 — the first telemetry ping goes out before a user could have read that
  there is telemetry.
- [`axisrow/trace-mcp-plugin#5`](https://github.com/axisrow/trace-mcp-plugin/issues/5)
  — guard hooks land in `.claude/settings.local.json` and intercept
  `Read|Grep|Glob|Bash|Agent` in every later session of that project.

Each was found by a different route, a month apart, and each was about to get
its own locally-invented answer to the same question. The answer is below, once.

**Read this before adding anything that writes outside `~/.trace/`, and update
it in the same change.** A row missing here is a change nobody decided to make.

---

## The three tiers

The classifying question is not "is this dangerous" — almost none of it is. It
is **whose expectation does this violate if they find out later.**

| Tier | Rule | What it costs us |
|---|---|---|
| **Consent** — ask before, remember the answer | The change persists after trace-mcp is gone, or it changes how *another* program behaves, or it leaves the machine | A prompt, and a flag for non-interactive use |
| **Notice** — do it, say so once, name the undo | Reversible, confined to trace-mcp's own state, but a reasonable user would not predict it from what they typed | One line of output |
| **Silent** — just do it | The user asked for exactly this, or it is trace-mcp's own bookkeeping inside `~/.trace/` | Nothing |

Two rules that follow from the tiers and are worth stating separately, because
each of the three findings broke one of them:

1. **Non-interactive is not consent.** `--yes` may skip a prompt; it may not
   invent an answer more invasive than the interactive default. Today
   `init --yes` picks the *most* invasive tier available (below) — that is
   backwards.
2. **Every Consent-tier row needs one command that undoes it**, and the notice
   must name that command. Not "documented somewhere": named at the moment.

The precedent for all of this already exists in two places in our own tree and
should be copied rather than redesigned:

- `trace-mcp consent grant|revoke|list` (`src/cli/consent.ts`, records in
  `~/.trace/consent.json`) — outbound LLM traffic is already gated this way.
- `applyStartupRecommendations` (`src/analytics/apply-recommendations.ts`) —
  `dryRun` defaults to true, and every write is preceded by an undo manifest
  flushed to disk *before* the write it covers.

---

## The inventory

`~/.trace` is `TRACE_MCP_HOME` (`src/global.ts`), overridable with
`TRACE_MCP_DATA_DIR`. Paths are canonical in `src/shared/paths.ts`; an
invariant test fails the build if a fresh `homedir()` literal appears outside
it, which is why that file doubles as the checklist for this one.

### A. Our own state — inside `~/.trace/`

| What | Trigger | Told? | Undo | Tier |
|---|---|---|---|---|
| `~/.trace/` + `.config.json` created | any command (`ensureGlobalDirs`) | no | `rm -rf ~/.trace` | Silent |
| `index/<project>.db` | `add` / `init --index` / **auto-registration** | only when the user asked | `remove <path>`, `prune` | Silent *when asked* |
| `registry.json` entry | `add`, `init`, **and any MCP client connecting from a new root** (`src/cli.ts:2409`, gated only by `isDangerousProjectRoot`) | **no** | `remove <path> --keep-db` | **Consent** — #936 |
| `topology.db`, `decisions.db`, `state.db`, `sessions/`, `corpora/`, `bundles/`, `locks/`, `status/`, `embed-watermarks.json`, `startup-watch.json` | normal operation | no | `rm -rf ~/.trace` | Silent |
| `startup-backups/` | `apply_startup_recommendations` | yes, it is the undo manifest | `rollback…` | Silent |
| `telemetry-state.json` (install UUID) | first server start | **no** | `TRACE_MCP_TELEMETRY=off` | Notice (state) / **Consent** (the ping — below) |
| `daemon.log`, `postinstall.log`, `launcher.log` | daemon / install | no | `rm` | Silent |
| `daemon.disabled` sentinel | `daemon stop` | yes | `daemon start` | Silent |
| `~/.trace-mcp` → `~/.trace` rename | first run after TRA-611 | no | — (compat symlink kept) | Notice |

### B. Leaves the machine

| What | Trigger | Told? | Undo | Tier |
|---|---|---|---|---|
| Anonymous daily usage ping → GA4 | `sendUsagePing`, fire-and-forget at server construction (`src/server/server.ts:743`) | **no — the first ping precedes any surface a user could read it on** | `TRACE_MCP_TELEMETRY=off` (suppressed under `CI`) | **Consent** — TRA-887 |
| Desktop-app / legacy-bundle download from GitHub Releases | `init` (default yes), `install-app`, `postinstall-app.mjs` | partially | — | Notice |
| Outbound LLM provider calls | `ask`, embeddings with a remote provider | yes | `consent revoke` | Consent — **already correct** |

### C. Changes how another program behaves

This is the row-set that matters. Everything here keeps working after
`npm uninstall -g trace-mcp`.

| What | Trigger | Told? | Undo | Tier |
|---|---|---|---|---|
| Guard hook in `.claude/settings.local.json` (project) or `~/.claude/settings.json` (`--global`) — intercepts `Read/Grep/Glob/Bash/Agent` on every later session | `init` (Standard+), `setup-hooks` — which applies the tier it is given, **with no prompt of its own** | `init` asks the tier; `setup-hooks` does not | `setup-hooks --uninstall` | **Consent** — plugin#5 |
| Lifecycle hooks (SessionStart / UserPromptSubmit / Stop / SessionEnd / PreCompact / reindex / worktree) | same | same | `setup-hooks --lifecycle --uninstall` | Consent |
| Routing block in **`~/.claude/CLAUDE.md`** — `init`'s `claudeMdScope` default is `global`, not the project (`src/init/claude-md.ts:18`) | `init` | in the summary, not as a question | delete the marked block | **Consent** — global instruction files are shared |
| `AGENTS.md` block, `.cursor/rules/`, `.windsurfrules` | `init` | in the summary | delete the marked block | Notice |
| MCP server entry in `~/.claude.json`, `~/.codex`, `~/.cursor`, `~/.windsurf`, `~/.continue`, `~/.junie`, `~/.factory` | `init`, `clients update` | yes — it is what the user asked for | edit the file | Silent |
| Hermes `pre_tool_call` hook in `~/.hermes/config.yaml` | `init` | in the summary | — **no uninstall path** | Consent |
| tweakcc prompts written to `~/.tweakcc`, then **`npx tweakcc --apply` patches the installed Claude Code bundle** (`src/init/tweakcc.ts:280`) — installing tweakcc via npx if absent | `init` Max tier, **and `init --yes` unconditionally** | the tier prompt says "patches Claude's system prompts"; `--yes` says nothing | tweakcc's own restore | **Consent** — this is the one place we cross the line `ops/context-block-levers.md` draws |
| Competing tools' marker blocks removed from the user's `CLAUDE.md`; skills moved aside into `.trace-mcp-disabled-skills` | `init` (`fixConflicts = true` unconditionally when non-interactive) | interactive asks; `--yes` does not | manual / `rollbackStartupRecommendations` | **Consent** — we delete text the user did not write for us |

### D. Changes the machine

| What | Trigger | Told? | Undo | Tier |
|---|---|---|---|---|
| `~/Library/LaunchAgents/com.trace-mcp.server.plist` + `launchd bootstrap` | **`npm install -g trace-mcp` postinstall** (`scripts/postinstall-control-plane.mjs`), and `daemon start` | no | `daemon stop` (writes `daemon.disabled`) | **Consent** — a background service from a package install |
| `~/.trace/bin/trace` launcher shim, `launcher.env`, legacy `~/.trace-mcp/bin/trace-mcp` symlink | postinstall, `init` | no | `rm` | Notice |
| App installed into `~/Applications` (or `%LOCALAPPDATA%`), version marker, Windows Start-Menu shortcut | `init` (interactive default yes; **`--yes` = yes**) | interactive asks | delete the bundle | Notice |
| **`defaults write com.apple.dock persistent-apps` + `killall Dock`** (`pinToDock`, `src/cli/install-app.ts:411`) | every app install, including `init --yes` | **no, at any tier** | unpin manually | **Consent** — we restart a UI process the user did not mention |
| Project-local `.trace-mcp/` dir; stray 0-byte `.trace-mcp/index.db` deleted | `add` / setup | no | `rm -rf` | Silent |

---

## What this says to do

Not a fourth fix. Four decisions, then the existing issues implement them:

1. **One consent store, reusing `~/.trace/consent.json`** and the
   `consent grant|revoke|list` surface that already exists. Every Consent-tier
   row above records its answer there. #936, TRA-887 and the hooks work all
   read the same file instead of each inventing a setting.
2. **`--yes` means "the interactive default", never more.** Today it means
   tweakcc + strict `agent_behavior` + Dock pin + conflict deletion, none of
   which the interactive path picks without a keystroke. That inversion
   (`src/cli/init.ts:336–347`) is one commit and it is the highest-value one
   here.
3. **`setup-hooks` gets a prompt of its own** — or, when non-interactive, prints
   what it installed and the uninstall command. A downstream packager reached
   "installed without asking" through our command without doing anything wrong;
   that is our defect, not theirs.
4. **`trace-mcp uninstall`.** There is no command that undoes an install today —
   the pieces exist (`remove`, `prune`, `setup-hooks --uninstall`,
   `daemon stop`, `consent revoke`) and nothing composes them, and the Hermes
   hook has no remover at all. Every Notice line that names an undo command
   needs that command to exist.

The cheap version of the value: the auto-registration report sat in a stranger's
repository for a month. Any of the above would have surfaced it on his machine,
at the moment it happened, without either of us finding it.

---

*Verified against `main` at v3.18.0 on 2026-09-05 by reading the source, not the
docs. Tier assignments are decisions, not observations — argue with them in
TRA-937 and change them here.*
