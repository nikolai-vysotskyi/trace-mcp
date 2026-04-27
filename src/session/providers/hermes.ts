/**
 * Hermes Agent (NousResearch) session provider.
 *
 * Hermes stores conversations in a single SQLite DB (`state.db`) under
 * `$HERMES_HOME` (default `~/.hermes`). Profiles are supported via
 * `<root>/profiles/<name>/state.db`.
 *
 * Relevant properties (differ from Claude Code / Claw Code):
 *   - Sessions are GLOBAL — there is no `project_path` / `cwd` column. This
 *     provider surfaces every session it finds; scoping to the current
 *     project is out of scope here and must be performed by the consumer.
 *   - `sessions.source` encodes the transport ("cli" | "telegram" | "discord"
 *     | ...), not the project.
 *   - `parent_session_id` links compression-split chains; we treat each row
 *     as its own SessionHandle and leave chain stitching to the indexer.
 *
 * The schema is feature-detected at open time (PRAGMA table_info) so we
 * tolerate minor version drift between Hermes v8 and future revisions.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ParsedSession } from '../../analytics/log-parser.js';
import { SqliteSource } from './sqlite-source.js';
import type { DiscoverOpts, RawMessage, SessionHandle, SessionProvider } from './types.js';

/** Path-segment label used in sourcePath encoding. */
const PROVIDER_ID = 'hermes';

interface HermesSessionRow {
  id: string;
  source: string | null;
  parent_session_id: string | null;
  // Normalized to the earliest/latest timestamp regardless of which column
  // the current Hermes build uses (`started_at`/`ended_at` in v8, fell back
  // on `created_at`/`updated_at` in older schemas we guessed).
  start_ts: number | string | null;
  end_ts: number | string | null;
  title: string | null;
}

interface HermesMessageRow {
  id: string | number;
  session_id: string;
  role: string | null;
  content: string | null;
  tool_name: string | null;
  // Hermes v8 stores a JSON array on `tool_calls`; earlier drafts had
  // `tool_input` / `tool_result`. We normalize to whichever exists.
  tool_calls_json: string | null;
  tool_result_json: string | null;
  ts: number | string | null;
  in_tokens: number | null;
  out_tokens: number | null;
}

interface HermesOptions {
  /** Override for HERMES_HOME. Resolution order: configOverrides.home_override
   *  → opts.homeDir/.hermes → $HERMES_HOME → ~/.hermes. */
  homeOverride?: string;
  /** Restrict to a specific profile name. Default: scan root state.db + every
   *  profiles/*\/state.db that exists. */
  profile?: string;
}

interface ResolvedDb {
  dbPath: string;
  profile: string | null;
}

/** Resolve the Hermes home directory. */
function resolveHermesHome(opts: DiscoverOpts, pOpts: HermesOptions): string {
  if (pOpts.homeOverride) return pOpts.homeOverride;
  const envHome = process.env.HERMES_HOME;
  if (envHome) return envHome;
  const home = opts.homeDir ?? os.homedir();
  return path.join(home, '.hermes');
}

/** Find every `state.db` under the Hermes home — root + one per profile. */
function findHermesDbs(hermesHome: string, profileFilter: string | null): ResolvedDb[] {
  const results: ResolvedDb[] = [];

  const rootDb = path.join(hermesHome, 'state.db');
  if (fs.existsSync(rootDb) && !profileFilter) {
    results.push({ dbPath: rootDb, profile: null });
  }

  const profilesDir = path.join(hermesHome, 'profiles');
  if (fs.existsSync(profilesDir)) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(profilesDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (profileFilter && e.name !== profileFilter) continue;
      const db = path.join(profilesDir, e.name, 'state.db');
      if (fs.existsSync(db)) results.push({ dbPath: db, profile: e.name });
    }
  }

  return results;
}

/** Convert Hermes timestamp (ms-since-epoch number or ISO string) to ms. */
function toMs(v: number | string | null | undefined, fallback: number): number {
  if (v == null) return fallback;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000; // seconds → ms heuristic
  const parsed = Date.parse(v);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function _toIso(v: number | string | null | undefined): string {
  const ms = toMs(v, 0);
  return ms > 0 ? new Date(ms).toISOString() : '';
}

/** Pick the first column from `candidates` that exists in `cols`, else `'NULL'`.
 *  Lets the SELECT survive schema drift between Hermes releases without
 *  hard-coding a single expected shape. */
function pickCol(cols: string[], candidates: string[]): string {
  for (const c of candidates) if (cols.includes(c)) return c;
  return 'NULL';
}

/** Build a SELECT that normalizes Hermes's schema drift into a stable row
 *  shape (HermesSessionRow). */
function buildSessionsQuery(source: SqliteSource): string {
  const cols = source.queryRows<{ name: string }>(`PRAGMA table_info(sessions)`).map((r) => r.name);
  return `SELECT
      id,
      ${pickCol(cols, ['source'])} AS source,
      ${pickCol(cols, ['parent_session_id'])} AS parent_session_id,
      ${pickCol(cols, ['started_at', 'created_at'])} AS start_ts,
      ${pickCol(cols, ['ended_at', 'updated_at'])} AS end_ts,
      ${pickCol(cols, ['title'])} AS title
    FROM sessions`;
}

function buildMessagesQuery(source: SqliteSource): string {
  const cols = source.queryRows<{ name: string }>(`PRAGMA table_info(messages)`).map((r) => r.name);
  const orderBy = cols.includes('timestamp')
    ? 'timestamp'
    : cols.includes('created_at')
      ? 'created_at'
      : 'id';
  return `SELECT
      id,
      session_id,
      ${pickCol(cols, ['role'])} AS role,
      ${pickCol(cols, ['content'])} AS content,
      ${pickCol(cols, ['tool_name'])} AS tool_name,
      ${pickCol(cols, ['tool_calls', 'tool_input'])} AS tool_calls_json,
      ${pickCol(cols, ['tool_result'])} AS tool_result_json,
      ${pickCol(cols, ['timestamp', 'created_at'])} AS ts,
      ${pickCol(cols, ['input_tokens', 'token_count'])} AS in_tokens,
      ${pickCol(cols, ['output_tokens'])} AS out_tokens
    FROM messages
    WHERE session_id = ?
    ORDER BY ${orderBy} ASC`;
}

function parseJsonSafe(raw: string | null): unknown {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed; // fall back to raw text
  }
}

function normalizeRole(role: string | null): RawMessage['role'] {
  switch (role) {
    case 'user':
    case 'human':
      return 'user';
    case 'assistant':
    case 'model':
      return 'assistant';
    case 'tool':
    case 'tool_result':
    case 'function':
      return 'tool';
    default:
      return role === 'system' ? 'system' : 'assistant';
  }
}

/**
 * The provider itself.
 *
 * `discover` is cheap: it stat-checks state.db files and SELECTs session rows
 * without touching the `messages` table. `streamMessages` opens the DB lazily
 * and closes it when the iterator is exhausted so we don't hold a read lock
 * on another process's WAL for longer than necessary.
 */
export class HermesSessionProvider implements SessionProvider {
  readonly id = PROVIDER_ID;
  readonly displayName = 'Hermes Agent (NousResearch)';

  async discover(opts: DiscoverOpts): Promise<SessionHandle[]> {
    const pOpts = (opts.configOverrides ?? {}) as HermesOptions;
    const home = resolveHermesHome(opts, pOpts);
    const dbs = findHermesDbs(home, pOpts.profile ?? null);
    if (dbs.length === 0) return [];

    const handles: SessionHandle[] = [];

    for (const { dbPath, profile } of dbs) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(dbPath);
      } catch {
        continue;
      }

      const source = new SqliteSource(dbPath, { label: PROVIDER_ID });
      try {
        source.open();
        const sql = buildSessionsQuery(source);
        const rows = source.queryRows<HermesSessionRow>(sql);
        for (const row of rows) {
          if (!row.id) continue;
          const lastModifiedMs = toMs(row.end_ts ?? row.start_ts, stat.mtimeMs);
          handles.push({
            providerId: PROVIDER_ID,
            sessionId: profile ? `${profile}:${row.id}` : row.id,
            sourcePath: source.buildSourcePath(row.id),
            // Hermes does not track per-session project paths — leave undefined.
            projectPath: undefined,
            lastModifiedMs,
            sizeBytes: stat.size,
          });
        }
      } catch {
        // Malformed / locked DB — skip this profile but keep scanning others.
      } finally {
        source.close();
      }
    }

    return handles;
  }

  async parse(handle: SessionHandle): Promise<ParsedSession | null> {
    // Hermes does not expose per-message model/token breakdowns consistently.
    // We return a minimal ParsedSession that downstream analytics can degrade
    // on gracefully (tokens=0, toolCallCount counted as we stream).
    const dbPath = extractDbPathFromSourcePath(handle.sourcePath);
    if (!dbPath) return null;

    const source = new SqliteSource(dbPath, { label: PROVIDER_ID });
    try {
      source.open();
      const rows = Array.from(this.streamMessagesSync(source, handle));
      const firstTs = rows.find((m) => m.timestampMs)?.timestampMs;
      const lastTs = [...rows].reverse().find((m) => m.timestampMs)?.timestampMs;
      const toolCallCount = rows.filter((m) => m.toolName).length;

      return {
        summary: {
          sessionId: handle.sessionId,
          projectPath: handle.projectPath ?? '',
          startedAt: firstTs ? new Date(firstTs).toISOString() : '',
          endedAt: lastTs ? new Date(lastTs).toISOString() : '',
          model: '',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
          },
          toolCallCount,
        },
        toolCalls: [],
        toolResults: new Map(),
      } as ParsedSession;
    } catch {
      return null;
    } finally {
      source.close();
    }
  }

  async *streamMessages(handle: SessionHandle): AsyncIterable<RawMessage> {
    const dbPath = extractDbPathFromSourcePath(handle.sourcePath);
    if (!dbPath) return;

    const source = new SqliteSource(dbPath, { label: PROVIDER_ID });
    try {
      source.open();
      for (const msg of this.streamMessagesSync(source, handle)) {
        yield msg;
      }
    } finally {
      source.close();
    }
  }

  private *streamMessagesSync(source: SqliteSource, handle: SessionHandle): Iterable<RawMessage> {
    const sql = buildMessagesQuery(source);
    // Strip a leading profile prefix we added in discover() (profile:id → id).
    const sessionKey = handle.sessionId.includes(':')
      ? handle.sessionId.slice(handle.sessionId.indexOf(':') + 1)
      : handle.sessionId;

    let rows: HermesMessageRow[];
    try {
      rows = source.queryRows<HermesMessageRow>(sql, [sessionKey]);
    } catch {
      return;
    }

    for (const row of rows) {
      const text = row.content ?? '';
      // `tool_calls_json` is an array in Hermes v8 — pass it through as-is;
      // older shapes stored a single input object. parseJsonSafe preserves
      // either form or falls back to raw text.
      const toolInput = parseJsonSafe(row.tool_calls_json);
      const toolResult = parseJsonSafe(row.tool_result_json);
      const tokenUsage =
        row.in_tokens != null || row.out_tokens != null
          ? {
              inputTokens: row.in_tokens ?? 0,
              outputTokens: row.out_tokens ?? 0,
            }
          : undefined;

      yield {
        role: normalizeRole(row.role),
        text,
        timestampMs: toMs(row.ts, 0) || undefined,
        toolName: row.tool_name ?? undefined,
        toolInput,
        toolResult,
        tokenUsage,
      };
    }
  }
}

function extractDbPathFromSourcePath(sourcePath: string): string | null {
  // Re-parse without taking a dep on sqlite-source's parser to keep this
  // method decoupled — our handle format is `sqlite://<abs>?row=…&via=…`.
  if (!sourcePath.startsWith('sqlite://')) return null;
  const rest = sourcePath.slice('sqlite://'.length);
  const qIdx = rest.indexOf('?');
  return qIdx < 0 ? rest : rest.slice(0, qIdx);
}
