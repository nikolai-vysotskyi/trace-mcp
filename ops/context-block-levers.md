# Start-block levers — what can actually be turned off in the client, measured

Every mechanism a *user* can use to shrink the tokens their coding agent sends
before the first question, with the token price measured rather than described.
Not a public page: `ops/` is outside the Jekyll site in `docs/`.

**Read this before promising, building or documenting any start-block
optimisation. Update it in the same change that touched a mechanism.** Written
for TRA-771 because TRA-759 recorded the two largest items — native tool schemas
(41%) and the shell's system prompt (14%) — as "not our lever", and that is
wrong: both have supported, user-facing switches.

Rules for keeping it honest:

- Record what you **measured**, with the date and the harness. A flag's help
  text is not a number.
- Record the **traps** too. `--tools ""` looks like the biggest saving available
  and is in fact a 25% *increase* (below).
- The line we do not cross: we change **configuration the user could change
  themselves** — flags, settings files, SDK options. We do not patch the
  client's binary, intercept its traffic or rewrite its files. The first is a
  product; the second breaks the user's environment at their next client update.

## Harness

`claude -p "Reply with the single word: ok" --output-format json
--no-session-persistence --model sonnet`, tokens =
`usage.input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
Script kept out of the repo (four lines); reproduce from that sentence.

- Claude Code **2.1.239**, native build, macOS, owner's machine, **2026-09-04**.
- Repeats are bit-exact: the baseline measured 53,617 twice, once cold and once
  fully cache-read. Numbers below are single runs unless stated.
- Every run was made in the **same empty subdirectory of a live agent
  workspace** — empty of files, but inheriting that workspace's `CLAUDE.md` from
  a parent directory. So "empty directory" here means no repo content, not no
  configuration.
- "Baseline" = that directory with this machine's real config: global +
  inherited `CLAUDE.md`, two `SessionStart` hooks, ~60 skills, several plugins,
  trace-mcp and other MCP servers connected. Your baseline differs; the *deltas*
  are what transfers.

## The baseline, decomposed

| Layer | Tokens | How it was isolated |
|---|---:|---|
| Built-in tool schemas (no skills catalog) | **16,271** | `--safe-mode` 21,179 − `--safe-mode --tools ""` 4,908 |
| Skills catalog (this machine's ~60 skills) | **11,822** | rides inside the `Skill` tool description — see below |
| `CLAUDE.md` + hooks + plugin/skill loading | **~14,653** | 47,654 − 21,179 − 11,822 |
| Claude Code default system prompt | **4,618** bare | `--safe-mode --tools ""` 4,908 − same with a one-line `--system-prompt` 290 |
| …the same prompt with this machine's dynamic sections | **8,637** | `--strict-mcp-config --tools ""` 20,779 − same with a one-line `--system-prompt` 12,142 |
| Everything else (the user turn, framing) | 290 | the floor below |
| MCP servers (with client deferral active) | **5,963** | 53,617 − 47,654 (`--strict-mcp-config`) |
| **Total baseline** | **53,617** | rows sum to 53,327 + the 290 floor; the ~4K spread between the two system-prompt rows is inside the layers above, not additional |

Absolute floor — one-line system prompt, no tools, no MCP, no config:
**290 tokens**. Everything above it is configuration.

Two corrections to the TRA-759 split this implies:

- The system prompt is **4.6K bare, 8.6K with per-machine dynamic sections**
  (cwd, memory paths, git status) — not 14% of 62K. It is the *smallest* of the
  five layers, not the second largest.
- The 41% "native tools" bucket is really two things: 16.3K of actual tool
  schemas and 11.8K of **the user's own skills catalog**, which the client
  merely delivers through the `Skill` tool. The second half is entirely the
  user's to shrink.

## 1. Native tool schemas — the mechanisms

### `--tools <names…>` / SDK `tools: string[]`

Sets the base set of built-in tools. Verified 2026-09-04: the excluded tools'
schemas are **absent from the request**, not merely blocked.

Per-tool price, measured as the delta over `--strict-mcp-config --tools ""`
(20,779):

| Tool | Tokens | Breaks, if removed |
|---|---:|---|
| `Skill` | **11,822** | no skills at all. The number is this machine's catalog, not the tool |
| `Task` | 5,755 | no subagents; carries the agent-type listing, so it also scales with your config |
| `Bash` | 4,366 | no shell. On a native build this is also your only search |
| `Grep` | 1,791 | *not in the default set on native builds* — costs only if you opt in |
| `Read` | 1,260 | no file reads |
| `WebFetch` | 1,053 | not in the default set here |
| `WebSearch` | 1,013 | not in the default set here |
| `NotebookEdit` | 986 | no `.ipynb` edits |
| `Edit` | 933 | no in-place edits |
| `BashOutput` | 897 | no background-shell reads |
| `Write` | 714 | no file creation |
| `Glob` | 709 | *not in the default set on native builds* |
| `TodoWrite`, `ExitPlanMode`, `SlashCommand`, `ToolSearch` | 0 delta | not gated by `--tools` — naming them adds nothing |

Deltas are **sub-additive by ~16.5%**: `Read,Edit,Bash,Grep,Glob` together cost
7,562, against 9,059 summed individually. Budget with the combined number.

### The `--tools ""` trap — measured, do not repeat it

| Config | Tokens |
|---|---:|
| Baseline | 53,617 |
| `--tools ""` (all built-ins off, MCP servers still connected) | **67,093** |
| `--tools "ToolSearch"` | **27,774** |
| `--tools "Read,Edit,Write,Bash,ToolSearch"` | **32,677** |
| `--tools ""` `--strict-mcp-config` | 20,779 |

Emptying the built-in set costs **+13,476 tokens**, a 25% increase. With the
built-ins gone the client stops deferring MCP tool schemas and loads all ~170
eagerly. Naming `ToolSearch` in the set restores deferral and turns the same
move into **−25,843 (−48%)**.

Inference, not measurement: the causal link between the empty set and lost
deferral is the only explanation consistent with the three numbers, but we have
not read the client code. The effect itself is measured and exactly reproducible.

**Rule: never recommend disabling built-in tools wholesale while MCP servers are
connected. Any recommended set must contain `ToolSearch`.**

### `--disallowedTools` / `permissions.deny` / SDK `disallowedTools`

Also removes schemas from the request, not just permission to call
(2026-09-04, all against the `--strict-mcp-config` baseline of 47,654):

| Denied | Result | Saved |
|---|---:|---:|
| `Read,Write,Edit,WebFetch,WebSearch,NotebookEdit` | 45,747 | 1,907 |
| `Read` | 46,748 | 906 |
| `Read,Grep,Glob` | 46,748 | 906 — identical, see below |
| `WebFetch,WebSearch` | 47,642 | 12 |

Denying a tool that is not in the default set is a no-op. The savings also run
consistently *below* the same tools' add-cost in the `--tools` table (`Read`:
906 denied vs 1,260 added), and the four effective tools in the first row saved
1,907 against 3,893 summed — a bigger gap than the ~16.5% sub-additivity
measured above, and unexplained. Use `--tools` for budgeting (explicit set, and
its numbers are the ones that reconcile) and deny for exceptions.

### `--disable-slash-commands`

Removes the skills catalog: `--tools "Skill" --disable-slash-commands` measured
20,779 — exactly the no-tools baseline, i.e. **the whole 11,822 is the catalog,
and none of it is the tool**. Breaks every skill. Prefer the SDK `skills` filter
(below) where a run needs three skills rather than sixty.

Measured 2026-09-04: adding this flag to a set that already omits `Skill`
changed nothing useful (32,677 → 33,643, +966 unexplained). Only worth using
when `Skill` is in the set.

### What of this does trace-mcp duplicate?

`Read`, `Grep`, `Glob` — the tools `get_outline` / `get_symbol` / `search`
replace without losing capability. On a native build that argument is worth
**~1,260 tokens** (`Read` only): `Grep` and `Glob` are **not in the default set**
— denying `Read,Grep,Glob` measured 46,748, identical to denying `Read` alone
(both above). The SDK types confirm it ("native builds may provide search via Bash
`find`/`grep` instead of the dedicated Grep/Glob tools").

So the honest version of the "swap duplicates for ours" pitch: it is real but
small. The money in this layer is the skills catalog (11.8K), `Task` (5.8K) and
`Bash` (4.4K) — none of which we replace.

### SDK `toolAliases` — capability-preserving removal

`toolAliases: { Bash: 'mcp__workspace__bash' }` redirects a built-in tool name
to an MCP tool, so a dropped built-in still resolves when a skill instructs the
model to call it by name. On the type signature this is what would make "drop
`Read`, keep reading files" safe in SDK runs — untested, see Open below. Present in `@anthropic-ai/claude-agent-sdk`
**0.3.259**, verified from the shipped `sdk.d.ts` 2026-09-04. Not measured.

### Other clients

- **Codex CLI 0.144.6** (2026-09-04): config keys `tools.web_search`,
  `tools.view_image` exist upstream; **token cost not measured — no local way to
  dump Codex's tool schemas**. `codex debug prompt-input` renders the
  model-visible *message* list only (23,996 bytes here), tools excluded, and it
  is byte-identical with `-c tools.web_search=false`. Re-check when Codex adds a
  schema dump; do not re-run `prompt-input` expecting one.

## 2. The system prompt

In an interactive session the client assembles it. We are not rewriting it
inside someone else's binary — that is the line above.

In **SDK / agent runs the caller owns it outright**, and on this machine
**1,899 of 2,537 session files created in the last 30 days (74.9%,
`~/.claude/projects`, 2026-09-04) sit under agent workspace paths**. That is a
different counting method from the 79% in TRA-759 and does not verify it; it is
a second, cruder count landing in the same range. Either way the lever applies
to roughly three quarters of fresh starts on this machine.

`@anthropic-ai/claude-agent-sdk` **0.3.259**, `systemPrompt` option
(from the shipped `sdk.d.ts`, 2026-09-04):

| Form | What it does | Price |
|---|---|---|
| `string` / `string[]` | replaces the prompt entirely | measured floor **290 tokens** total, vs 4,908 for the preset with no tools — i.e. **−4,618** |
| `{ type:'preset', preset:'claude_code' }` | Claude Code's default | 4,618 bare / 8,637 with dynamic sections |
| `…, append: '…'` | default + your text | + your text |
| `…, excludeDynamicSections: true` | moves cwd / memory paths / git status out of the system prompt into the first user message | **not a size lever** — CLI equivalent measured 47,654 → 47,395 (−259). It buys **cross-user prompt-cache reuse**, which is the actual win for a fleet |
| `…, snapshot: true` | records the rendered prompt once per conversation and replays it verbatim | no start-block saving; prevents cache-prefix invalidation when the CLI updates mid-session. SDK docs recommend it |
| `string[]` + `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` | marks the static/dynamic split in a custom prompt so the prefix stays cacheable | — |

Note the SDK default: `systemPrompt` omitted means **no system prompt**, not the
Claude Code preset. An SDK run that never sets it is already paying zero here.

CLI equivalents for agent runs launched as a subprocess: `--system-prompt`,
`--append-system-prompt`, `--exclude-dynamic-system-prompt-sections`.

Verdict: the system prompt is worth **4.6K on an SDK run that opts into the
preset without needing it**, and roughly nothing on one that already sets its
own. Real, applicable to ~75% of starts on this machine, and the smallest of the
five layers. Do not lead with it.

## 3. Adjacent switches measured on the way

| Switch | Effect on this machine | Verdict |
|---|---|---|
| `--strict-mcp-config` | 53,617 → 47,654 (−5,963) | the whole MCP layer, deferral already applied |
| `--safe-mode` | 53,617 → 21,179 (−32,438) | everything user-configured off, built-ins kept. Diagnostic, not a working config |
| `--setting-sources ""` | 53,617 → 33,221 (−20,396) | drops user/project/local settings files |
| `--bare` | **unusable here** | requires `ANTHROPIC_API_KEY` or `apiKeyHelper`; OAuth and keychain are never read. Run returned no usage at all on this machine |
| SDK `skills: string[]` | not measured | the surgical form of `--disable-slash-commands`: enables only named skills, so a run pays for three skills instead of sixty. Highest-value untested item on this list |

## What to do with this

Ranked by measured tokens on this machine, for a recommendation engine:

1. **Skills catalog, 11,822** — the single biggest user-owned item, and it is
   not even in the TRA-759 table. SDK `skills: [...]`, or drop `Skill`.
2. **Named tool set with `ToolSearch`, up to −20,940** — `Read,Edit,Write,Bash,
   ToolSearch` measured 32,677 against a 53,617 baseline.
3. **`CLAUDE.md` + hooks, ~14,653** — already the plan of record in TRA-759.
4. **MCP servers, 5,963** — already the plan of record.
5. **System prompt, 4,618** — SDK runs only.

The risk rule from TRA-759 applies to all of it and hardest to item 2: a tool
absent from the start block is a tool the agent will not call. Every removal
needs evidence of non-use over a named window, and `ToolSearch` must survive.

## Open, not yet measured

- SDK `skills: string[]` — expected to be most of the 11,822, unverified.
- `toolAliases` — no token measurement, and no test that a redirected `Read`
  actually round-trips to a trace-mcp tool.
- Codex tool-schema cost — blocked on a schema dump, see above.
- Whether `--tools` deltas hold on Opus. All numbers here are Sonnet; a spot
  check with no `--model` came out 5.4K lower on a comparable config, so the
  per-model prompt differs and these figures should not be quoted as
  model-independent.
