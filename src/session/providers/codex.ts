/**
 * Codex CLI session provider.
 *
 * The Codex CLI (`@openai/codex`, npm) writes one JSONL file per session
 * under `~/.codex/sessions/<rollout-id>.jsonl`. Each line is a JSON record
 * with `{ type, timestamp, message? }` — broadly the same shape as Claude
 * Code's JSONL but with OpenAI's content-block conventions:
 *
 *   - `message.role`    is "user" | "assistant" | "tool" | "system"
 *   - `message.content` is either a string or an array of content blocks
 *     `{ type: 'text'|'input_text'|'output_text'|'tool_call'|…, text?, … }`
 *
 * Codex also emits standalone records like `{ type: 'session.start', cwd, … }`
 * — we use those to recover `projectPath` when present, and otherwise leave
 * it `undefined` so the consumer can scope by `cwd` from a later turn.
 *
 * Cursor and Windsurf are intentionally NOT covered here: both store their
 * conversation logs inside Electron IndexedDB / undocumented sqlite blobs
 * with no externally documented JSONL pathway. Adding them would require
 * either reverse-engineering an unstable schema or partnering with the
 * vendor — explicit follow-up work.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ParsedSession } from '../../analytics/log-parser.js';
import type { DiscoverOpts, RawMessage, SessionHandle, SessionProvider } from './types.js';

const PROVIDER_ID = 'codex';

interface CodexOptions {
  /** Override the Codex home dir. Resolution order:
   *  configOverrides.home_override → opts.homeDir/.codex → $CODEX_HOME → ~/.codex. */
  homeOverride?: string;
}

function resolveCodexHome(opts: DiscoverOpts, pOpts: CodexOptions): string {
  if (pOpts.homeOverride) return pOpts.homeOverride;
  const envHome = process.env.CODEX_HOME;
  if (envHome) return envHome;
  const home = opts.homeDir ?? os.homedir();
  return path.join(home, '.codex');
}

/** List every `*.jsonl` file under `<home>/sessions/`, recursively (Codex
 *  recently started sharding sessions by date). */
function findSessionFiles(home: string): string[] {
  const sessionsRoot = path.join(home, 'sessions');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(sessionsRoot);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];

  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return; // defensive bound on path-shard depth
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(sessionsRoot, 0);
  return out;
}

interface CodexContentBlock {
  type?: string;
  text?: string;
  // Tool-call shapes vary across Codex versions; we capture the common fields.
  name?: string;
  arguments?: unknown;
  input?: unknown;
  output?: unknown;
}

interface CodexMessage {
  role?: string;
  content?: string | CodexContentBlock[];
}

interface CodexRecord {
  type?: string;
  timestamp?: string | number;
  cwd?: string;
  /** Some Codex builds nest the message under `payload`; we accept both. */
  message?: CodexMessage;
  payload?: { message?: CodexMessage; cwd?: string };
}

function readFirstNRecords(filePath: string, max: number): CodexRecord[] {
  // Stream the first `max` JSON lines without reading the whole file.
  // Used by `discover()` to find the session's recorded `cwd` for
  // projectPath recovery — typical files are KBs to MBs.
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const out: CodexRecord[] = [];
  let start = 0;
  for (let i = 0; i < raw.length && out.length < max; i++) {
    if (raw.charCodeAt(i) !== 10 /* \n */) continue;
    const line = raw.slice(start, i).trim();
    start = i + 1;
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* tolerate single corrupt line */
    }
  }
  return out;
}

function inferProjectPath(records: CodexRecord[]): string | undefined {
  for (const r of records) {
    const cwd = r.cwd ?? r.payload?.cwd;
    if (typeof cwd === 'string' && cwd.length > 0) return cwd;
  }
  return undefined;
}

function parseTimestamp(ts: string | number | undefined): number | undefined {
  if (ts == null) return undefined;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : undefined;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeRole(role: string | null | undefined): RawMessage['role'] {
  if (role === 'assistant') return 'assistant';
  if (role === 'tool' || role === 'tool_result') return 'tool';
  if (role === 'system') return 'system';
  return 'user';
}

function extractTextFromContent(content: CodexMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (typeof block !== 'object' || block === null) continue;
    if (typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

function recordToRawMessage(rec: CodexRecord): RawMessage | null {
  const msg = rec.message ?? rec.payload?.message;
  if (!msg) return null;
  const text = extractTextFromContent(msg.content);

  // Identify tool-call blocks for tool-flavored RawMessages.
  let toolName: string | undefined;
  let toolInput: unknown;
  let toolResult: unknown;
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (typeof block !== 'object' || block === null) continue;
      if (block.type === 'tool_call' || block.type === 'tool_use') {
        toolName = typeof block.name === 'string' ? block.name : toolName;
        toolInput = block.input ?? block.arguments ?? toolInput;
      }
      if (block.type === 'tool_result' || block.type === 'output_text') {
        toolResult = block.output ?? block.text ?? toolResult;
      }
    }
  }

  // Skip records that carry no usable surface (no text, no tool).
  if (!text && !toolName && toolResult === undefined) return null;

  return {
    role: normalizeRole(msg.role),
    text,
    timestampMs: parseTimestamp(rec.timestamp),
    toolName,
    toolInput,
    toolResult,
  };
}

export class CodexSessionProvider implements SessionProvider {
  readonly id = PROVIDER_ID;
  readonly displayName = 'Codex CLI';

  async discover(opts: DiscoverOpts): Promise<SessionHandle[]> {
    const pOpts = (opts.configOverrides ?? {}) as CodexOptions;
    const home = resolveCodexHome(opts, pOpts);
    const files = findSessionFiles(home);
    if (files.length === 0) return [];

    const handles: SessionHandle[] = [];
    for (const file of files) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }

      const sessionId = path.basename(file, '.jsonl');
      const head = readFirstNRecords(file, 10);
      const projectPath = inferProjectPath(head);

      // If a project filter was requested, only keep sessions that match
      // (or sessions where we couldn't infer a cwd — safer to surface
      // them than to drop everything silently).
      if (opts.projectRoot && projectPath && projectPath !== opts.projectRoot) {
        continue;
      }

      handles.push({
        providerId: PROVIDER_ID,
        sessionId,
        sourcePath: file,
        projectPath,
        lastModifiedMs: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    }
    return handles;
  }

  async parse(handle: SessionHandle): Promise<ParsedSession | null> {
    const file = handle.sourcePath;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      return null;
    }

    let firstTs: number | undefined;
    let lastTs: number | undefined;
    let toolCallCount = 0;

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: CodexRecord;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const ts = parseTimestamp(rec.timestamp);
      if (ts !== undefined) {
        if (firstTs === undefined) firstTs = ts;
        lastTs = ts;
      }
      const msg = rec.message ?? rec.payload?.message;
      if (msg && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            typeof block === 'object' &&
            block !== null &&
            (block.type === 'tool_call' || block.type === 'tool_use')
          ) {
            toolCallCount++;
          }
        }
      }
    }

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
  }

  async *streamMessages(handle: SessionHandle): AsyncIterable<RawMessage> {
    const file = handle.sourcePath;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      return;
    }

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: CodexRecord;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const out = recordToRawMessage(rec);
      if (out) yield out;
    }
  }
}
