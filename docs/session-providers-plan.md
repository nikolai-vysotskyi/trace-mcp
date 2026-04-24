# Session Providers — Implementation Plan

**Issue:** [#76 — Support for AMP, KiloCode, Cline, Cursor, Antigravity, Kimi, Warp](https://github.com/nikolai-vysotskyi/trace-mcp/issues/76)
**Status:** Partially shipped — Hermes provider landed ahead of Phase 0 (see §A3+ note below)
**Owner:** TBD
**Target release:** phased across 1.30 – 1.34

## A3+ — Hermes Agent landed ahead of Phase 0 (2026-04-24)

Phase 0 (refactor the existing Claude Code / Claw Code JSONL paths behind `SessionProvider`) is deferred. Hermes Agent support shipped first via an additive pathway that does NOT rewrite the legacy paths:

- The `SessionProvider` interface (`src/session/providers/types.ts`) and `SessionProviderRegistry` (`src/session/providers/registry.ts`) exist per §4.2 – 4.3.
- `HermesSessionProvider` implements the interface against a read-only SQLite source (`sqlite-source.ts`, plan §4.5).
- `mineSessions` iterates the registry AFTER its existing Claude/Claw loop via `mineProviderSessions` in `src/memory/conversation-miner-providers.ts`. The legacy loop was not modified.
- A golden-file lockdown test (`tests/analytics/list-all-sessions.snapshot.test.ts`) pins the existing `listAllSessions()` output against a committed fixture tree — the same tripwire Phase 0 would have needed.
- No DB migration yet. The `providerId` column on session chunks remains deferred to Phase 0; for Hermes we encode provider in the `session_id` string (`hermes:<id>`) and attribute decisions to the caller-supplied `project_root`. Hermes mining is a no-op when `project_root` is absent — we do not guess.

When Phase 0 lands it should collapse the Claude/Claw branches into the registry loop, drop the separate `conversation-miner-providers.ts` hook, and add the `providerId` column properly. The golden test should remain the acceptance gate.

---

## 1. Goal

Extend trace-mcp's session mining / session indexing / session discovery pipeline beyond the current two-format hardcoding (`claude-code` + `claw-code` JSONL) so that conversation logs from other AI coding assistants become first-class inputs for:

- [`discover_claude_sessions`](../src/tools/advanced/claude-sessions.ts#L37) — project-level discovery
- [`index_sessions`](../src/memory/session-indexer.ts#L145) — embed conversation chunks for cross-session semantic search
- [`mine_sessions`](../src/memory/conversation-miner.ts#L316) — extract decisions / bug root causes / user preferences
- [`get_session_analytics`](../src/tools/register/session.ts#L125) — token / cost / tool usage breakdown

After this work, adding support for a new AI assistant should require implementing a single `SessionProvider` interface in isolation, without editing the indexer, miner, or analytics code paths.

## 2. Non-goals

- Building UI affordances in `packages/app` for the new providers (can be follow-up).
- Writing converters *from* trace-mcp into the other tools' formats.
- Real-time session ingestion (polling/file-watch). Keep the current batch model.
- Feature parity where upstream doesn't expose the data (e.g., token counts missing from Cursor's SQLite means `get_session_analytics` yields partial rows — documented, not faked).

## 3. Current state (reference)

All session-aware code is JSONL-only and inlines both formats with `if` branches:

| Concern | File | Notes |
|---|---|---|
| Discovery | [src/tools/advanced/claude-sessions.ts](../src/tools/advanced/claude-sessions.ts) | Scans `~/.claude/projects/`; `countSessionFiles` matches `*.jsonl` / `*.json` |
| Parse | [src/analytics/log-parser.ts:152](../src/analytics/log-parser.ts#L152) | `ClientType = 'claude-code' \| 'claw-code'`; format-branching inline in `parseSessionFile` |
| Enumerate | [src/analytics/log-parser.ts:334](../src/analytics/log-parser.ts#L334) | `listAllSessions()` hardcodes Claude path + `.claw/sessions/` |
| Index | [src/memory/session-indexer.ts](../src/memory/session-indexer.ts) | Walks the same JSONL lines; branches on `record.type` |
| Mine | [src/memory/conversation-miner.ts](../src/memory/conversation-miner.ts) | Same JSONL walk, different extraction |

**Consequence:** adding a 3rd format means a 3rd branch in *four* different files. Seven more providers via this pattern is a non-starter — and some (Cursor, Warp) aren't even JSONL.

## 4. Architecture

### 4.1 Where the code lives

New internal module at `src/session/providers/`, siblings to the existing `src/ai/`, `src/lsp/`, `src/memory/` modules. This is not a new service and not a new package — it's parsing code that the MCP server calls from `indexSessions`, `mineSessions`, `listAllSessions`. No reason it would ever be extracted: its only consumers are other parts of `src/`. `packages/` stays as-is: `packages/app` (Electron) is the only thing that lives there and has its own lifecycle.

### 4.2 `SessionProvider` interface

New file: `src/session/providers/types.ts`

```ts
export interface SessionProvider {
  /** Stable provider id used in DB, config, logs. e.g. "claude-code", "cline", "cursor". */
  readonly id: string;
  /** Human label for UI / analytics. */
  readonly displayName: string;

  /**
   * Locate sessions on disk. Return raw handles — parsing happens later.
   * `projectRoot` is the absolute path of the project being analyzed;
   * providers that store per-project data use it to scope the search.
   */
  discover(opts: DiscoverOpts): Promise<SessionHandle[]>;

  /**
   * Parse one session handle into the canonical ParsedSession shape.
   * Must not throw for malformed inputs — log + return null.
   */
  parse(handle: SessionHandle): Promise<ParsedSession | null>;

  /**
   * Iterator over raw conversation chunks for indexing/mining.
   * Separate from parse() because indexer/miner don't need ToolCall aggregation.
   */
  streamMessages(handle: SessionHandle): AsyncIterable<RawMessage>;
}

export interface DiscoverOpts {
  projectRoot?: string;
  homeDir?: string;            // injectable for tests
  configOverrides?: Record<string, unknown>;
}

export interface SessionHandle {
  providerId: string;
  sessionId: string;
  sourcePath: string;          // file path, or "sqlite://<db>?row=<id>"
  projectPath?: string;        // best-effort; null if provider doesn't track
  lastModifiedMs: number;
  sizeBytes?: number;
}

export interface RawMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  timestampMs?: number;
  referencedFiles?: string[];
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  tokenUsage?: Partial<TokenUsage>;
}
```

`ParsedSession`, `ToolCallEvent`, `ToolResultEvent`, `TokenUsage` stay where they are ([src/analytics/log-parser.ts:8](../src/analytics/log-parser.ts#L8)-L48), with `ParsedSession.summary` gaining a `providerId: string` field.

### 4.3 Registry

`src/session/providers/registry.ts`

```ts
export class SessionProviderRegistry {
  private providers = new Map<string, SessionProvider>();
  register(p: SessionProvider): void;
  get(id: string): SessionProvider | undefined;
  all(): SessionProvider[];
  enabledFor(config: TraceMcpConfig): SessionProvider[];
}
```

Config wiring in [src/config.ts](../src/config.ts):

```ts
session_providers: {
  enabled: z.array(z.enum([
    "claude-code", "claw-code", "cline", "kilocode",
    "cursor", "amp", "antigravity", "kimi", "warp"
  ])).default(["claude-code", "claw-code"]),
  provider_overrides: z.record(z.unknown()).optional(), // per-provider config
}
```

Default keeps the two existing providers so this is a zero-breakage refactor.

### 4.4 Consumers (indexer, miner, analytics)

Rewrite to iterate over `registry.enabledFor(config)`:

```ts
for (const provider of registry.enabledFor(config)) {
  for (const handle of await provider.discover({ projectRoot })) {
    if (decisionStore.isSessionIndexed(handle.sessionId)) continue;
    for await (const msg of provider.streamMessages(handle)) {
      // same chunking logic as today
    }
  }
}
```

The current [extractTextFromMessage](../src/memory/session-indexer.ts) logic becomes provider-agnostic because `RawMessage.text` is already normalized.

### 4.5 SQLite providers (Cursor, Warp)

New helper: `src/session/providers/sqlite-source.ts` — wraps `better-sqlite3` (already a transitive dep via the Electron app; add as direct dep if not present at the server side). Responsibilities:

- Open DB read-only (`readonly: true, fileMustExist: true`).
- Expose `queryRows<T>(sql: string, params: unknown[]): T[]`.
- Surface a stable `SessionHandle` with `sourcePath = "sqlite://<abs-db-path>?row=<pk>"`.

This isolates SQLite concerns from the JSONL stream providers and keeps `npm install` for users who only want JSONL cheap — lazy-load `better-sqlite3` only when a SQLite provider is actually enabled.

## 5. Phase breakdown

Each phase is one PR. Phases are sequential — each depends on the prior. Early phases keep semantics byte-identical; later phases change behavior only by adding new data sources.

### Phase 0 — Refactor scaffolding (**no behavior change**)

**Goal:** `SessionProvider` interface + registry exist, existing code still runs via two providers behind the interface. No new format support.

Tasks:
1. Create `src/session/providers/{types,registry}.ts` with the shapes from §4.2–4.3.
2. Create `ClaudeCodeProvider` and `ClawCodeProvider` classes wrapping current logic from `log-parser.ts` / `session-indexer.ts` / `conversation-miner.ts`. Move the `type === 'assistant'` vs `type === 'message'` branch into each provider's `parse` / `streamMessages`.
3. Add registry initialization in [src/server.ts](../src/server.ts) and wire it into `ctx: ServerContext`.
4. Rewrite `indexSessions`, `mineSessions`, `listAllSessions` to iterate via the registry. Keep public tool signatures unchanged.
5. Add `providerId` column to the session chunks table in `decisionStore` (ALTER TABLE + migration); backfill to `"claude-code"` for existing rows heuristically by checking `.claw/` presence.
6. Extend existing tests in [tests/tools/claude-sessions.test.ts](../tests/tools/claude-sessions.test.ts) to also cover the provider abstraction contract.

Acceptance:
- `npm test` green.
- Output of `index_sessions` on a real `~/.claude/projects/` tree byte-matches pre-refactor output (lockdown test via fixture).
- New provider registry exposed on `ServerContext`.

Estimated size: ~800 LoC net (mostly moved).

### Phase 1 — Cline provider (+ KiloCode re-use)

**Why first:** Cline and KiloCode are forks of the same codebase — shared JSON-based storage format, most similar to the existing JSONL path, minimum new territory after Phase 0. Highest ROI per risk unit.

Storage (macOS reference; Linux/Windows mapped below):
- Cline: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/<taskId>/`
  - `api_conversation_history.json` — Anthropic-shaped messages array
  - `ui_messages.json` — display-side annotations
  - `task_metadata.json` — project root, timestamps
- KiloCode: same layout under `kilocode.kilo-code` (or current extension id — must verify at implementation time, fork rebranded at least once).
- Linux: `~/.config/Code/User/globalStorage/...`
- Windows: `%APPDATA%/Code/User/globalStorage/...`
- Plus `Code - Insiders`, `VSCodium`, `Cursor` (yes, VSCode forks re-nest) — provider probes all known VSCode-derivative paths.

Tasks:
1. Implement `ClineProvider` in `src/session/providers/cline.ts`. Format spec below in §9.1.
2. Implement `KiloCodeProvider` extending Cline with only a different `extensionId` constant.
3. Project-path association: `task_metadata.json` contains `cwd` — use that as `handle.projectPath`.
4. `streamMessages`: walk `api_conversation_history.json` → emit `RawMessage`. Content blocks of type `tool_use` → `toolName/toolInput`; `tool_result` → `toolResult` with correlation by block id.
5. Register both providers. Config key enables independently.
6. Fixtures: check in three sanitized sample task dirs under [tests/fixtures/providers/cline/](../tests/fixtures/providers/cline/).
7. Tests: `discover` returns handles only for tasks whose `cwd` matches `projectRoot`; `parse` produces a valid `ParsedSession`; `streamMessages` emits expected roles & tool events.

Acceptance:
- Manual: point trace-mcp at a real Cline task dir; `index_sessions` populates chunks; `search_sessions` returns them.
- Edge case: malformed `api_conversation_history.json` returns `null` from `parse`, doesn't crash the pipeline.

Risk: Cline schema is undocumented and changes across extension versions. Mitigation: version-tag fixtures (`v3.0`, `v3.8`, `v4.0`), parser tolerates unknown fields, regression suite runs all fixture versions.

### Phase 2 — AMP (Sourcegraph)

Storage:
- macOS: `~/.config/amp/` (CLI) or VSCode extension path for the IDE variant.
- Threads stored as JSON files per thread (current public info; verify before building).
- Format: JSON document with `messages[]` — roles `human`/`assistant`, tool calls inline.

Tasks: implement `AmpProvider`. Format spec skeleton in §9.2 — must be filled in during a discovery spike before writing code.

Acceptance: same shape as Phase 1 but against AMP fixtures.

Risk: AMP is evolving quickly; expect format churn. Pin to a version range in the provider's README block and document unsupported versions.

### Phase 3 — Cursor (first SQLite provider)

Storage: `~/Library/Application Support/Cursor/User/workspaceStorage/<workspace-hash>/state.vscdb` (SQLite).

- Chat data lives in `ItemTable` under keys like `workbench.panel.aichat.view.aichat.chatdata` (JSON blob) and `composerData:<id>`.
- Global chats: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`.
- Table: `ItemTable(key TEXT, value BLOB)`; value is JSON.

Tasks:
1. Add `better-sqlite3` as a direct dep (or reuse the one `packages/app` already pulls) — lazy-load so it's only required if Cursor/Warp providers are enabled.
2. Implement `sqlite-source.ts` wrapper.
3. Implement `CursorProvider`. Workspace hash → project path resolved via `workspace.json` adjacent to the vscdb.
4. Map Cursor's message schema to `RawMessage`. Cursor chats don't carry tool_use blocks in the same shape as Claude/Cline — synthesize `toolName` from Cursor's "capability" field if present, else emit text-only messages. Document the loss in the provider README.
5. Token usage: **not available** from Cursor storage. `tokenUsage` on `RawMessage` stays undefined. `get_session_analytics` returns `tokens: null` for Cursor sessions — verify the tool handles null without NaN-ing totals.

Risk: Cursor's SQLite schema is the most volatile target in this plan (observed to change across minor releases). Mitigation: on unknown schema, log + skip the workspace rather than crashing. Ship with a `cursor.schema_version` config override for users on older builds.

### Phase 4 — Warp (second SQLite provider)

Storage: `~/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite`.
- AI Agent conversations in tables around `ai_*` prefix (verify at implementation).
- Warp's terminal context (commands, output) is separate from AI conversations — the provider should only ingest AI conversations; commands-as-context is out of scope.

Tasks: implement `WarpProvider` on top of `sqlite-source.ts`. Discovery does not depend on `projectRoot` — Warp doesn't track per-project; all conversations are global. Handle this by surfacing all conversations and filtering by `referencedFiles` heuristic, or by letting user scope via config `warp.project_pattern`.

Risk: Warp ships frequent updates; schema not stable. Consider gating the provider behind `experimental: true` until we get a stable release we've tested against.

### Phase 5 — Antigravity

Google Antigravity is new (public ~late 2025). Storage format not yet reverse-engineered as of this plan date (2026-04-23).

Before starting: 2-hour discovery spike — install the tool, create a session, inspect storage on disk, document findings back here in §9.5. If the format is opaque (encrypted, remote-only), mark the provider as **unsupported** and close that part of the issue.

### Phase 6 — Kimi (Moonshot)

Moonshot's `kimi-code` CLI. Likely JSONL under `~/.kimi/` or similar. Discovery spike required (§9.6).

If format matches Claude Code's structure closely enough, this may reduce to a thin subclass of `ClaudeCodeProvider` with a different `scanRoot`.

### Phase 7 — Rollup & docs

Tasks:
1. Update [README.md](../README.md) session section.
2. Update [docs/comparisons.md](./comparisons.md) "vs. AI session memory" table.
3. Add [docs/session-providers.md](./session-providers.md): per-provider storage paths, known limitations, how to enable, known format version tested.
4. Update `CHANGELOG.md` (the tool, not the individual PRs — release-please handles per-PR entries).
5. Close issue #76 with a comment listing shipped providers + any marked unsupported.

## 6. Testing strategy

- **Unit**: each provider has a `tests/session/providers/<id>.test.ts` with fixture-driven coverage of `discover`, `parse`, `streamMessages`. Fixtures live under `tests/fixtures/providers/<id>/v<schema-version>/`.
- **Contract**: a shared `tests/session/providers/_contract.ts` that every provider runs against. Asserts invariants: `discover` is idempotent, `parse` returns `null` (not throws) on garbage input, `streamMessages` is exhaustively consumable, etc.
- **Integration**: one end-to-end test per provider: fake home dir → full `index_sessions` → assert decision-store rows. Gated by an env var for providers whose fixtures aren't checkable in (licensing/PII).
- **Lockdown**: Phase 0 ships a golden-file test of `listAllSessions()` output against a committed fixture tree. Any post-refactor drift fails the test.

## 7. Risks & decisions to revisit

| Risk | Impact | Mitigation | Decision needed |
|---|---|---|---|
| Closed/undocumented formats change between releases | Silent data loss on upgrade | Version-pinned fixtures + regression suite | — |
| `better-sqlite3` bumps install size + requires native build | Install friction for users who don't use Cursor/Warp | Lazy-load; put behind optional peer dep? | Yes — peer-dep vs direct-dep |
| Cross-platform path handling (VSCode extensions on Linux vs macOS vs Windows) | Provider works only on author's OS | Path resolution helper + CI matrix covers 3 OSes | — |
| PII in committed fixtures | Leaking user data | Scrub script + CI check that fixtures have no emails/tokens/paths | — |
| Phase 0 DB migration on existing users | Broken indexes on upgrade | Migration is additive (new nullable column); backfill job runs lazily | — |
| Antigravity / Kimi formats may be closed | Can't implement at all | Spike-first gate; willing to mark as unsupported in issue | Yes — acceptance of partial closure |

## 8. Per-provider format notes (to be filled in during discovery spikes)

### 8.1 Cline

- Storage root (macOS): `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/`
- Per-task dir contents (observed up to Cline 3.x — **verify for current release**):
  - `api_conversation_history.json`: JSON array of Anthropic messages. Each element is `{ role: "user" | "assistant", content: string | ContentBlock[] }`.
  - `ui_messages.json`: UI-layer annotations including diffs and checkpoint markers.
  - `task_metadata.json`: `{ id, cwd, createdAt, completedAt? }`.
- Token usage is **not** recorded per-message; it's aggregated in `ui_messages.json` cost summaries.
- Tool use: ContentBlock `tool_use` / `tool_result` follow Anthropic's shape — correlation by `id`/`tool_use_id` matches what trace-mcp already does.

### 8.2 AMP

TBD — spike before Phase 2.

### 8.3 Cursor

- `state.vscdb` → table `ItemTable(key, value)`, value is JSON blob.
- Known keys containing chat data:
  - `workbench.panel.aichat.view.aichat.chatdata` — sidebar chat history
  - `composerData:<uuid>` — composer sessions
  - `cursorAIWorkspaceStorage:<...>` — per-workspace metadata
- Each chat JSON: `{ tabs: [{ tabId, bubbles: [{ type, text, ... }] }] }` (subject to verification — Cursor reshuffles keys regularly).
- Project path: workspace folder derivable from sibling `workspace.json` in the same `workspaceStorage/<hash>/` directory.

### 8.4 Warp

TBD — spike before Phase 4. Known: SQLite DB at `~/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite`, WAL mode, contains `command_history`, `block_history`, `ai_*` tables (names approximate).

### 8.5 Antigravity

TBD — spike before Phase 5. Unknown if format is local at all.

### 8.6 Kimi

TBD — spike before Phase 6.

### 8.7 KiloCode

Fork of Cline — expected identical to §9.1 under extension id `kilocode.kilo-code` (verify current id at implementation; the fork has rebranded before).

## 9. Sign-off checklist

- [ ] §4 architecture approved (interface shape)
- [ ] §5 phasing approved (or reordered — e.g., user may want Cursor before AMP for popularity reasons)
- [ ] §7 open decisions resolved (`better-sqlite3` peer-dep, Antigravity partial-close acceptance)
- [ ] Discovery spikes booked for §8.2, 8.4, 8.5, 8.6 before their phases start

Once all boxes are ticked, file Phase 0 PR.
