/**
 * Startup-context audit (TRA-759, from the TRA-726 measurement).
 *
 * Every session pays for a block of context before the user's first word:
 * the harness system prompt, native tool schemas, MCP server schemas and
 * instructions, the skill and agent listings, SessionStart hook output, and
 * the user's own instruction files. On the machine TRA-726 measured, that
 * block was ~62K tokens at the median and ~29% of the whole bill — and no
 * shell shows what it is made of.
 *
 * This module reconstructs the block from session logs alone. Nothing leaves
 * the machine and nothing is sent anywhere: `~/.claude/projects/*.jsonl` is
 * read, measured, and thrown away.
 *
 * What the logs can and cannot say — the honest boundary, kept visible in the
 * payload's `notes` so a reader never mistakes an estimate for a measurement:
 *
 *  - MEASURED EXACTLY: the total startup block (the first API call's
 *    input + cache_creation + cache_read), and every injection the harness
 *    writes to the log as an `attachment` — hook output by hook name, the
 *    skill listing, the deferred-tool and agent listings, MCP instructions.
 *  - NOT ITEMISED: the system prompt, the native and MCP tool schemas, and
 *    CLAUDE.md. The harness never logs them, so they can only be reported
 *    together, as the residual. Splitting them further needs a proxy in front
 *    of the API — out of scope here, and not something we would ship.
 *
 * Token counts for logged text are chars/4. That is the standard estimate
 * used elsewhere in this package; the residual is exact by subtraction, so
 * the estimate's error lands on the itemised rows, never on the total.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { listAllSessions } from './log-parser.js';

// --- Pricing (USD per million tokens, sonnet-class — same table the rest of
// this package prices with, see analytics-store.ts). ---
const USD_PER_MTOK_INPUT = 3.0;
const USD_PER_MTOK_CACHE_WRITE_5M = 3.75;
const USD_PER_MTOK_CACHE_WRITE_1H = 6.0;
const USD_PER_MTOK_CACHE_READ = 0.3;

const CHARS_PER_TOKEN = 4;
/** cache_creation big enough mid-session to mean the prefix was rebuilt, not grown. */
const PREFIX_REBUILD_MIN_TOKENS = 20_000;
/** Files below this are handshakes and aborted runs, not sessions. */
const MIN_SESSION_BYTES = 20_000;
/** A gap longer than the longest cache TTL explains a rebuild on its own. */
const CACHE_TTL_SECONDS = 3600;

export interface StartupSourceRow {
  /** `hook:<name>`, `skills`, `mcpInstructions`, `systemPromptToolSchemasAndInstructions`, … */
  source: string;
  /** Mean tokens per fresh session. Means, not medians, so the rows sum to the total. */
  meanTokens: number;
  /** Share of the mean startup block. */
  pctOfStartup: number;
  /** How many fresh sessions carried this source at all. */
  sessions: number;
  /** False for the residual row, which is a subtraction rather than a measurement. */
  itemised: boolean;
}

export interface CacheBreakerRow {
  /** `compact`, `ttlExpiry`, `modelSwitch`, `toolsChanged`, `listingChanged`, `unexplained` */
  cause: string;
  events: number;
  /** Tokens re-written to the cache across those events. */
  tokens: number;
  /** What the rebuild cost beyond reading the same tokens from cache. */
  extraUsd: number;
}

export interface McpServerRow {
  server: string;
  /** Fresh sessions whose startup block announced this server. */
  sessionsPresent: number;
  /** Tool calls actually made to it across the scanned corpus. */
  toolCalls: number;
}

export interface InstructionFileRow {
  path: string;
  tokens: number;
}

export interface StartupContextAudit {
  days: number;
  sessions: { scanned: number; fresh: number };
  /** Distribution of the whole startup block across fresh sessions, in tokens. */
  startupTokens: { p10: number; median: number; p90: number; max: number };
  sources: StartupSourceRow[];
  cost: {
    /** Startup's share of the input-side bill over the period. */
    startupUsd: number;
    inputSideUsd: number;
    pctOfInputBill: number;
    /** What writing the block into the cache cost on fresh sessions alone. */
    firstCallCacheWriteUsd: number;
  };
  cacheBreakers: CacheBreakerRow[];
  mcpServers: McpServerRow[];
  /** Instruction files on disk right now — paid once per session, forever. */
  instructionFiles: InstructionFileRow[];
  notes: string[];
  scanMs: number;
}

// --- Attachment measurement ---

/**
 * Which fields of an attachment are the payload the model actually reads.
 * Everything else in the record is bookkeeping (hook name, tool-use id) that
 * never reaches the context window. Attachment types outside this map fall
 * back to measuring every string in the record, which over-counts slightly —
 * hence `other`, where the over-count is visible rather than smeared.
 */
const ATTACHMENT_PAYLOAD_KEYS: Record<string, string[]> = {
  hook_success: ['stdout', 'content'],
  hook_additional_context: ['content'],
  deferred_tools_delta: ['addedLines'],
  agent_listing_delta: ['addedLines'],
  mcp_instructions_delta: ['addedBlocks'],
  skill_listing: ['content'],
  total_tokens_reminder: ['text'],
  nested_memory: ['content'],
  command_permissions: ['content'],
};

const BOOKKEEPING_KEYS = new Set(['type', 'hookName', 'hookEvent', 'toolUseID', 'command']);

function deepChars(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + deepChars(v), 0);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (n, v) => n + deepChars(v),
      0,
    );
  }
  return 0;
}

function attachmentChars(att: Record<string, unknown>): number {
  const keys = ATTACHMENT_PAYLOAD_KEYS[String(att.type)];
  if (!keys) {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(att)) if (!BOOKKEEPING_KEYS.has(k)) rest[k] = v;
    return deepChars(rest);
  }
  return keys.reduce((n, k) => n + deepChars(att[k]), 0);
}

/**
 * The label a source gets in the table. Hooks keep their own name: "a plugin
 * that loads a hook on every start" is only actionable if the hook is named.
 */
function attachmentSource(att: Record<string, unknown>): string {
  const type = String(att.type ?? 'unknown');
  switch (type) {
    case 'hook_success':
    case 'hook_additional_context':
      return `hook:${String(att.hookName ?? 'unnamed')}`;
    case 'skill_listing':
      return 'skills';
    case 'deferred_tools_delta':
      return 'deferredToolListing';
    case 'agent_listing_delta':
      return 'agentListing';
    case 'mcp_instructions_delta':
      return 'mcpInstructions';
    case 'nested_memory':
      return 'memory';
    default:
      return 'other';
  }
}

// --- Small stats helpers ---

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const k = Math.max(0, Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[k];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function inputCostUsd(input: number, write5m: number, write1h: number, read: number): number {
  return (
    (input * USD_PER_MTOK_INPUT +
      write5m * USD_PER_MTOK_CACHE_WRITE_5M +
      write1h * USD_PER_MTOK_CACHE_WRITE_1H +
      read * USD_PER_MTOK_CACHE_READ) /
    1e6
  );
}

// --- Per-file scan ---

interface ApiCall {
  ctx: number;
  cacheCreate: number;
  cacheCreate1h: number;
  costUsd: number;
  model: string;
  epochSeconds: number;
  events: Set<string>;
}

interface FreshSession {
  projectPath: string;
  startupTokens: number;
  cacheCreate: number;
  cacheCreate1h: number;
  /** source label → tokens */
  bySource: Map<string, number>;
  mcpServers: Set<string>;
}

interface FileScan {
  calls: ApiCall[];
  fresh: FreshSession | null;
  mcpToolCalls: Map<string, number>;
}

function timestampSeconds(ts: unknown): number {
  if (typeof ts !== 'string') return 0;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : ms / 1000;
}

/**
 * One streaming pass over a session file.
 *
 * Only lines that can carry usage, an attachment or a compact boundary are
 * parsed — a substring test first, `JSON.parse` second. On a 45-day corpus
 * that is the difference between parsing every line and parsing half of them,
 * and the report is one the user waits on.
 */
async function scanSessionFile(filePath: string, projectPath: string): Promise<FileScan> {
  const calls: ApiCall[] = [];
  const mcpToolCalls = new Map<string, number>();
  const seenMessageIds = new Set<string>();

  const preFirstBySource = new Map<string, number>();
  const startupMcpServers = new Set<string>();
  let preFirstUserChars = 0;
  let assistantBeforeFirstCall = false;
  let firstCall: { ctx: number; cacheCreate: number; cacheCreate1h: number } | null = null;
  let pendingEvents = new Set<string>();
  let lastTimestamp: unknown = null;

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    if (
      !line.includes('"usage"') &&
      !line.includes('"attachment"') &&
      !line.includes('compact_boundary') &&
      // User records only matter before the first call, and `"user"` matches
      // every tool_result line — testing for it after that would parse the
      // whole file for nothing.
      !(firstCall === null && line.includes('"user"'))
    ) {
      continue;
    }
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.timestamp) lastTimestamp = rec.timestamp;
    const type = rec.type;

    if (type === 'system' && rec.subtype === 'compact_boundary') {
      if (!rec.isSidechain) pendingEvents.add('compact');
      continue;
    }

    if (type === 'attachment') {
      const att = (rec.attachment ?? {}) as Record<string, unknown>;
      const attType = String(att.type ?? '');
      if (attType === 'mcp_instructions_delta') {
        for (const name of (att.addedNames as unknown[]) ?? []) {
          if (typeof name === 'string' && firstCall === null) startupMcpServers.add(name);
        }
      }
      if (firstCall === null) {
        const source = attachmentSource(att);
        preFirstBySource.set(source, (preFirstBySource.get(source) ?? 0) + attachmentChars(att));
      } else if (
        attType === 'deferred_tools_delta' ||
        attType === 'mcp_instructions_delta' ||
        attType === 'agent_listing_delta' ||
        attType === 'skill_listing'
      ) {
        pendingEvents.add(
          attType === 'agent_listing_delta' || attType === 'skill_listing'
            ? 'listingChanged'
            : 'toolsChanged',
        );
      }
      continue;
    }

    if (type === 'user') {
      if (firstCall !== null) continue;
      const content = (rec.message as { content?: unknown } | undefined)?.content;
      if (typeof content === 'string') {
        preFirstUserChars += content.length;
      } else if (Array.isArray(content)) {
        for (const item of content) {
          const it = item as { type?: string; text?: string };
          if (it?.type === 'text' && typeof it.text === 'string')
            preFirstUserChars += it.text.length;
        }
      }
      continue;
    }

    if (type !== 'assistant') continue;

    const message = (rec.message ?? {}) as {
      id?: string;
      model?: string;
      usage?: Record<string, unknown>;
      content?: unknown;
    };

    for (const block of (message.content as unknown[]) ?? []) {
      const b = block as { type?: string; name?: string };
      if (b?.type !== 'tool_use' || typeof b.name !== 'string' || rec.isSidechain) continue;
      if (b.name.startsWith('mcp__')) {
        const server = b.name.split('__')[1] ?? 'unknown';
        mcpToolCalls.set(server, (mcpToolCalls.get(server) ?? 0) + 1);
      }
      if (b.name === 'ToolSearch' || b.name.endsWith('load_tools'))
        pendingEvents.add('toolsChanged');
    }

    const usage = message.usage ?? {};
    const input = Number(usage.input_tokens ?? 0);
    const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0);
    const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
    const cacheCreate1h = Number(
      (usage.cache_creation as { ephemeral_1h_input_tokens?: number } | undefined)
        ?.ephemeral_1h_input_tokens ?? 0,
    );
    const ctx = input + cacheCreate + cacheRead;
    if (ctx === 0 && !usage.output_tokens) {
      if (firstCall === null && !rec.isSidechain) assistantBeforeFirstCall = true;
      continue;
    }

    const id = String(message.id ?? rec.requestId ?? rec.uuid ?? '');
    if (id && seenMessageIds.has(id)) continue;
    if (id) seenMessageIds.add(id);

    // A sidechain (subagent) pays its own, much smaller prefix. It is neither
    // this session's startup block nor a rebuild of it.
    if (rec.isSidechain) continue;

    calls.push({
      ctx,
      cacheCreate,
      cacheCreate1h,
      costUsd: inputCostUsd(input, cacheCreate - cacheCreate1h, cacheCreate1h, cacheRead),
      model: String(message.model ?? ''),
      epochSeconds: timestampSeconds(lastTimestamp),
      events: pendingEvents,
    });
    pendingEvents = new Set<string>();

    if (firstCall === null) firstCall = { ctx, cacheCreate, cacheCreate1h };
  }

  let fresh: FreshSession | null = null;
  if (firstCall && !assistantBeforeFirstCall) {
    const startupTokens = Math.round(firstCall.ctx - preFirstUserChars / CHARS_PER_TOKEN);
    if (startupTokens > 0) {
      const bySource = new Map<string, number>();
      let itemised = 0;
      for (const [source, chars] of preFirstBySource) {
        const tokens = Math.round(chars / CHARS_PER_TOKEN);
        if (tokens <= 0) continue;
        bySource.set(source, tokens);
        itemised += tokens;
      }
      bySource.set('systemPromptToolSchemasAndInstructions', Math.max(0, startupTokens - itemised));
      fresh = {
        projectPath,
        startupTokens,
        cacheCreate: firstCall.cacheCreate,
        cacheCreate1h: firstCall.cacheCreate1h,
        bySource,
        mcpServers: startupMcpServers,
      };
    }
  }

  return { calls, fresh, mcpToolCalls };
}

// --- Instruction files on disk ---

/**
 * The instruction files that are re-read into every session's prefix. Measured
 * on disk as they are today, not as they were when a logged session ran —
 * which is the number that matters for "should I trim this file".
 */
function readInstructionFiles(projectRoot?: string): InstructionFileRow[] {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.claude', 'CLAUDE.md'),
    path.join(home, '.claude', 'AGENTS.md'),
    ...(projectRoot
      ? [path.join(projectRoot, 'CLAUDE.md'), path.join(projectRoot, 'AGENTS.md')]
      : []),
  ];
  const rows: InstructionFileRow[] = [];
  for (const file of candidates) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      rows.push({ path: file, tokens: Math.round(stat.size / CHARS_PER_TOKEN) });
    } catch {
      /* absent — nothing to report */
    }
  }
  return rows.sort((a, b) => b.tokens - a.tokens);
}

// --- Cache-breaker classification ---

/**
 * Why the prefix was rebuilt mid-session. Order matters: a compact boundary or
 * an expired cache explains the rebuild on its own, so they are checked before
 * anything the session did.
 */
function classifyRebuild(call: ApiCall, previous: ApiCall): string {
  if (call.events.has('compact')) return 'compact';
  const gap = call.epochSeconds - previous.epochSeconds;
  if (previous.epochSeconds > 0 && gap > CACHE_TTL_SECONDS) return 'ttlExpiry';
  if (previous.model !== call.model) return 'modelSwitch';
  if (call.events.has('toolsChanged')) return 'toolsChanged';
  if (call.events.has('listingChanged')) return 'listingChanged';
  return 'unexplained';
}

// --- Entry point ---

export interface StartupContextOptions {
  /** Look-back window. Default 30; the TRA-726 study used 45. */
  days?: number;
  /** Scope the instruction-file listing to a project. Log scanning stays machine-wide. */
  projectRoot?: string;
  /** Session discovery, injectable so tests can point at a fixture directory. */
  listSessions?: typeof listAllSessions;
}

export async function analyzeStartupContext(
  opts: StartupContextOptions = {},
): Promise<StartupContextAudit> {
  const startedAt = Date.now();
  const days = Math.max(1, Math.min(365, opts.days ?? 30));
  const cutoffMs = Date.now() - days * 86_400_000;

  const files = (opts.listSessions ?? listAllSessions)().filter((s) => {
    if (s.mtime < cutoffMs) return false;
    try {
      return fs.statSync(s.filePath).size >= MIN_SESSION_BYTES;
    } catch {
      return false;
    }
  });

  const freshSessions: FreshSession[] = [];
  /** project → [ctx, inputCostUsd] for every main-chain call, for cost attribution. */
  const callsByProject = new Map<string, Array<[number, number]>>();
  const rebuilds = new Map<string, { events: number; tokens: number; extraUsd: number }>();
  const mcpToolCalls = new Map<string, number>();
  let inputSideUsd = 0;
  let scanned = 0;

  for (const file of files) {
    let scan: FileScan;
    try {
      scan = await scanSessionFile(file.filePath, file.projectPath);
    } catch {
      continue;
    }
    if (scan.calls.length < 3) continue;
    scanned++;

    if (scan.fresh) freshSessions.push(scan.fresh);
    for (const [server, n] of scan.mcpToolCalls) {
      mcpToolCalls.set(server, (mcpToolCalls.get(server) ?? 0) + n);
    }

    let bucket = callsByProject.get(file.projectPath);
    if (!bucket) {
      bucket = [];
      callsByProject.set(file.projectPath, bucket);
    }
    for (const call of scan.calls) {
      inputSideUsd += call.costUsd;
      bucket.push([call.ctx, call.costUsd]);
    }

    for (let i = 1; i < scan.calls.length; i++) {
      const call = scan.calls[i];
      if (call.cacheCreate < PREFIX_REBUILD_MIN_TOKENS) continue;
      const cause = classifyRebuild(call, scan.calls[i - 1]);
      const row = rebuilds.get(cause) ?? { events: 0, tokens: 0, extraUsd: 0 };
      const writeRate =
        call.cacheCreate1h > 0 ? USD_PER_MTOK_CACHE_WRITE_1H : USD_PER_MTOK_CACHE_WRITE_5M;
      row.events++;
      row.tokens += call.cacheCreate;
      row.extraUsd += (call.cacheCreate * (writeRate - USD_PER_MTOK_CACHE_READ)) / 1e6;
      rebuilds.set(cause, row);
    }
  }

  // Startup size per project, for attributing each call's input cost.
  const startupByProject = new Map<string, number>();
  for (const [project, sessions] of groupBy(freshSessions, (s) => s.projectPath)) {
    startupByProject.set(project, median(sessions.map((s) => s.startupTokens)));
  }
  const globalStartup = median(freshSessions.map((s) => s.startupTokens));

  let startupUsd = 0;
  for (const [project, calls] of callsByProject) {
    const size = startupByProject.get(project) ?? globalStartup;
    if (size <= 0) continue;
    for (const [ctx, cost] of calls) {
      if (ctx <= 0) continue;
      startupUsd += cost * Math.min(1, size / ctx);
    }
  }

  const sortedStartup = freshSessions.map((s) => s.startupTokens).sort((a, b) => a - b);
  const meanStartup = sortedStartup.length
    ? sortedStartup.reduce((a, b) => a + b, 0) / sortedStartup.length
    : 0;

  // Means over ALL fresh sessions (absent source counts as zero), so the rows
  // add up to the mean block. A median per row would be more robust and would
  // not sum — and a decomposition whose parts do not sum is not a decomposition.
  const sourceTotals = new Map<string, { tokens: number; sessions: number }>();
  for (const session of freshSessions) {
    for (const [source, tokens] of session.bySource) {
      const row = sourceTotals.get(source) ?? { tokens: 0, sessions: 0 };
      row.tokens += tokens;
      row.sessions++;
      sourceTotals.set(source, row);
    }
  }
  const n = Math.max(1, freshSessions.length);
  const sources: StartupSourceRow[] = [...sourceTotals]
    .map(([source, row]) => ({
      source,
      meanTokens: Math.round(row.tokens / n),
      pctOfStartup: meanStartup > 0 ? round((100 * (row.tokens / n)) / meanStartup, 1) : 0,
      sessions: row.sessions,
      itemised: source !== 'systemPromptToolSchemasAndInstructions',
    }))
    .sort((a, b) => b.meanTokens - a.meanTokens);

  const serversPresent = new Map<string, number>();
  for (const session of freshSessions) {
    for (const server of session.mcpServers) {
      serversPresent.set(server, (serversPresent.get(server) ?? 0) + 1);
    }
  }
  const mcpServers: McpServerRow[] = [
    ...new Set([...serversPresent.keys(), ...mcpToolCalls.keys()]),
  ]
    .map((server) => ({
      server,
      sessionsPresent: serversPresent.get(server) ?? 0,
      toolCalls: mcpToolCalls.get(server) ?? 0,
    }))
    .sort((a, b) => b.sessionsPresent - a.sessionsPresent || b.toolCalls - a.toolCalls);

  const firstCallCacheWriteUsd = freshSessions.reduce(
    (usd, s) =>
      usd +
      ((s.cacheCreate - s.cacheCreate1h) * USD_PER_MTOK_CACHE_WRITE_5M +
        s.cacheCreate1h * USD_PER_MTOK_CACHE_WRITE_1H) /
        1e6,
    0,
  );

  return {
    days,
    sessions: { scanned, fresh: freshSessions.length },
    startupTokens: {
      p10: percentile(sortedStartup, 10),
      median: Math.round(median(sortedStartup)),
      p90: percentile(sortedStartup, 90),
      max: sortedStartup.length ? sortedStartup[sortedStartup.length - 1] : 0,
    },
    sources,
    cost: {
      startupUsd: round(startupUsd),
      inputSideUsd: round(inputSideUsd),
      pctOfInputBill: inputSideUsd > 0 ? round((100 * startupUsd) / inputSideUsd, 1) : 0,
      firstCallCacheWriteUsd: round(firstCallCacheWriteUsd),
    },
    cacheBreakers: [...rebuilds]
      .map(([cause, row]) => ({
        cause,
        events: row.events,
        tokens: row.tokens,
        extraUsd: round(row.extraUsd),
      }))
      .sort((a, b) => b.extraUsd - a.extraUsd),
    mcpServers,
    instructionFiles: readInstructionFiles(opts.projectRoot),
    notes: [
      'Computed locally from session logs. Nothing is sent anywhere.',
      'The system prompt, tool schemas and CLAUDE.md are never written to the session log — they can only be reported together, as the residual row.',
      'Itemised rows estimate tokens as chars/4; the total and the residual are exact.',
      'Rows are means per fresh session so they sum to the mean block; the distribution above is medians.',
      'Prices are sonnet-class list rates and ignore any plan or discount.',
    ],
    scanMs: Date.now() - startedAt,
  };
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}
