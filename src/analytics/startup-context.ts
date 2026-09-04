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
import { claudeHome } from '../shared/paths.js';
import { listAllSessions } from './log-parser.js';
import { type StartupTextCompression, analyzeStartupText } from './startup-text.js';

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
  /** Mean tokens its instruction block costs in a startup that carries it. */
  instructionTokens: number;
  /** Tool calls actually made to it across the scanned corpus. */
  toolCalls: number;
}

export interface Recommendation {
  /** `unusedMcpServer` | `unusedSkill` | `duplicateInstructions` */
  kind: string;
  /** The server, skill or file the suggestion is about. */
  target: string;
  /** What was observed, in the user's terms — the proof, not the guess. */
  evidence: string;
  /** Tokens this would take off every session's startup block. */
  tokensPerSession: number;
  /** What those tokens cost over the observation window, at the same rate the headline uses. */
  usdOverWindow: number;
  /** Fresh sessions this was observed in — the denominator behind `evidence`. */
  sessionsObserved: number;
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
  /**
   * Suggestions, each backed by evidence of NON-USE over the stated window —
   * never by size alone. A tool that is not in the startup block is a tool the
   * agent will not call, so trimming by size is how a report like this costs
   * its reader more than it saves.
   */
  recommendations: Recommendation[];
  /**
   * The other half of the optimisation question (TRA-770): of the text that is
   * NEEDED and stays, where does the block say the same thing twice?
   *
   * Deliberately part of this payload rather than a tool of its own. It is the
   * same question — what is this block costing me and what can go — and a
   * second parameterless tool would add schema chars to every session that
   * lists tools while diluting the compact_schemas reduction the docs promise,
   * for a report nobody asks for separately from this one.
   */
  textCompression: StartupTextCompression;
  /** The window `recommendations` observed, said out loud rather than implied. */
  observationWindow: string;
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

/**
 * An MCP server appears in the log under two different spellings.
 *
 * `mcp_instructions_delta.addedNames` carries the configured name verbatim —
 * `claude.ai Cloudflare Developer Platform`. A tool call carries it folded into
 * a tool id that has to satisfy the API's `^[a-zA-Z0-9_-]+$`, so it arrives as
 * `mcp__claude_ai_Cloudflare_Developer_Platform__<tool>`.
 *
 * Matching the two spellings by string equality silently fails for every server
 * whose name has a space or a dot in it: the configured name shows zero calls,
 * the folded name shows every call, and a server in constant use is reported as
 * never called — which this module would then recommend switching off. Fold both
 * sides before comparing.
 */
export function normalizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

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

/**
 * Split the startup skill listing into its per-skill lines.
 *
 * The listing is one blob of `- <name>: <description>` lines, and the
 * description is where the tokens are — skill authors write them with no token
 * budget in mind, and every session reads all of them. Pricing a skill needs
 * its own line, not the blob's total. A continuation line (a description that
 * wrapped) belongs to the skill above it.
 */
export function splitSkillListing(content: string): Map<string, number> {
  const perSkill = new Map<string, number>();
  let current: string | null = null;
  for (const line of content.split('\n')) {
    const head = /^-\s+([A-Za-z0-9_.:-]+):\s/.exec(line);
    if (head) current = head[1];
    if (!current) continue;
    perSkill.set(current, (perSkill.get(current) ?? 0) + line.length + 1);
  }
  for (const [skill, chars] of perSkill) {
    perSkill.set(skill, Math.round(chars / CHARS_PER_TOKEN));
  }
  return perSkill;
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
  /** MCP server → tokens its instruction block cost in THIS session's startup. */
  mcpServers: Map<string, number>;
  /** Skill → tokens its line of the startup listing cost. */
  skills: Map<string, number>;
}

interface FileScan {
  calls: ApiCall[];
  fresh: FreshSession | null;
  mcpToolCalls: Map<string, number>;
  skillInvocations: Set<string>;
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
  const skillInvocations = new Set<string>();
  const seenMessageIds = new Set<string>();

  const preFirstBySource = new Map<string, number>();
  const startupMcpServers = new Map<string, number>();
  const startupSkills = new Map<string, number>();
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
      if (firstCall === null && attType === 'mcp_instructions_delta') {
        // `addedNames[i]` and `addedBlocks[i]` are the same server, so the
        // instruction text can be priced per server rather than in one lump.
        const names = (att.addedNames as unknown[]) ?? [];
        const blocks = (att.addedBlocks as unknown[]) ?? [];
        names.forEach((name, i) => {
          if (typeof name !== 'string') return;
          const tokens = Math.round(deepChars(blocks[i]) / CHARS_PER_TOKEN);
          startupMcpServers.set(name, (startupMcpServers.get(name) ?? 0) + tokens);
        });
      }
      if (firstCall === null && attType === 'skill_listing') {
        for (const [skill, tokens] of splitSkillListing(String(att.content ?? ''))) {
          startupSkills.set(skill, (startupSkills.get(skill) ?? 0) + tokens);
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
        // Already folded by the client — the map is keyed on the folded form.
        const server = b.name.split('__')[1] ?? 'unknown';
        mcpToolCalls.set(server, (mcpToolCalls.get(server) ?? 0) + 1);
      }
      if (b.name === 'Skill') {
        const skill = (block as { input?: { skill?: unknown } }).input?.skill;
        if (typeof skill === 'string') skillInvocations.add(skill);
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
        skills: startupSkills,
      };
    }
  }

  return { calls, fresh, mcpToolCalls, skillInvocations };
}

// --- Instruction files on disk ---

/**
 * The instruction files that are re-read into every session's prefix. Measured
 * on disk as they are today, not as they were when a logged session ran —
 * which is the number that matters for "should I trim this file".
 */
function readInstructionFiles(projectRoot?: string): InstructionFileRow[] {
  const home = claudeHome();
  const candidates = [
    path.join(home, 'CLAUDE.md'),
    path.join(home, 'AGENTS.md'),
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

// --- Recommendations ---

/**
 * A suggestion is only made when the window is wide enough to mean something.
 * Below this many fresh sessions carrying the candidate, "never called" is a
 * small sample rather than evidence, and the cost of a wrong suggestion — a
 * tool the agent then cannot call — is higher than the tokens it would save.
 *
 * The bar is on the candidate's OWN observations, not on its share of all
 * startups: a server configured for one project is present in a minority of
 * sessions and is no less proven unused within them.
 */
const MIN_SESSIONS_FOR_EVIDENCE = 20;

interface RecommendationInputs {
  mcpServers: McpServerRow[];
  skillsPresent: Map<string, { sessions: number; tokens: number }>;
  skillInvocations: Set<string>;
  instructionFiles: InstructionFileRow[];
  freshSessions: number;
  /** Fresh sessions in the project the instruction files were read from. */
  projectFreshSessions: number;
  meanStartup: number;
  startupUsd: number;
  days: number;
}

/**
 * Turn the measurements into suggestions — strictly on evidence of NON-USE
 * over the observed window, never on size.
 *
 * The asymmetry is the whole design: a tool missing from the startup block is
 * a tool the agent will not call, so a suggestion made because something is
 * big can cost its reader far more than it saves. "Big" is therefore never a
 * reason here; "loaded into N startups and called zero times" is.
 *
 * That rule is also why SessionStart hooks get no suggestion even though they
 * are among the largest itemised sources. A hook's output goes into the
 * prompt, and nothing in the log says whether the model used it — so there is
 * no evidence of non-use to stand on. Hooks stay in the decomposition, where
 * the reader sees what they cost and decides for themselves.
 *
 * Money uses the same attribution as the headline: a token's share of the
 * startup block is its share of what the block cost over the window.
 */
function buildRecommendations(input: RecommendationInputs): Recommendation[] {
  const out: Recommendation[] = [];
  if (input.freshSessions < MIN_SESSIONS_FOR_EVIDENCE || input.meanStartup <= 0) return out;
  /* What this many tokens cost over the window: their share of the mean
     startup block, times what the block cost, times the share of sessions
     that actually carried them. Summing the per-session tokens across
     sessions and dividing by ONE block's size would double-count the
     sessions — it priced an 86-token skill at more than the whole block. */
  const usdFor = (tokensPerSession: number, sessionsObserved: number) =>
    round(
      (tokensPerSession / input.meanStartup) *
        input.startupUsd *
        (sessionsObserved / Math.max(1, input.freshSessions)),
    );

  for (const server of input.mcpServers) {
    if (server.toolCalls > 0) continue;
    if (server.sessionsPresent < MIN_SESSIONS_FOR_EVIDENCE || server.instructionTokens <= 0)
      continue;
    out.push({
      kind: 'unusedMcpServer',
      target: server.server,
      evidence: `Its instructions were in ${server.sessionsPresent} of ${input.freshSessions} startups over ${input.days} days, and not one of its tools was called.`,
      tokensPerSession: server.instructionTokens,
      usdOverWindow: usdFor(server.instructionTokens, server.sessionsPresent),
      sessionsObserved: server.sessionsPresent,
    });
  }

  for (const [skill, row] of input.skillsPresent) {
    if (input.skillInvocations.has(skill)) continue;
    if (row.sessions < MIN_SESSIONS_FOR_EVIDENCE) continue;
    const perSession = Math.round(row.tokens / row.sessions);
    if (perSession <= 0) continue;
    out.push({
      kind: 'unusedSkill',
      target: skill,
      evidence: `Listed in ${row.sessions} of ${input.freshSessions} startups over ${input.days} days and never invoked.`,
      tokensPerSession: perSession,
      usdOverWindow: usdFor(perSession, row.sessions),
      sessionsObserved: row.sessions,
    });
  }

  /* Text that appears in both the global and the project instruction file is
     read twice in every session that loads both. This one is not evidence of
     non-use — it is evidence of duplication, the same claim made about the same
     bytes twice — so it needs no usage proof.

     Both files must be named, not merely "the first two on the list": the list
     is sorted by size and holds up to two GLOBAL files, so picking the largest
     and then "any other" pairs ~/.claude/AGENTS.md against ~/.claude/CLAUDE.md
     and never looks at the project at all. Pair by basename, with one file
     inside ~/.claude and the other outside it. */
  const home = claudeHome();
  const isGlobal = (f: InstructionFileRow) => f.path.startsWith(home + path.sep);
  for (const basename of ['CLAUDE.md', 'AGENTS.md']) {
    const named = input.instructionFiles.filter((f) => path.basename(f.path) === basename);
    const global = named.find(isGlobal);
    const project = named.find((f) => !isGlobal(f));
    if (!global || !project) continue;
    const shared = sharedLineTokens(global.path, project.path);
    if (shared <= 0) continue;
    out.push({
      kind: 'duplicateInstructions',
      target: project.path,
      evidence: `${shared} tokens of text appear in both this file and ${global.path}; every session in this project reads them twice.`,
      tokensPerSession: shared,
      // Sessions in THIS project, not on the whole machine: a project file is
      // read by its own project's sessions, and pricing it against every
      // session on the machine multiplies the number by however many other
      // projects the user works in.
      usdOverWindow: usdFor(shared, input.projectFreshSessions),
      sessionsObserved: input.projectFreshSessions,
    });
  }

  return out.sort((a, b) => b.usdOverWindow - a.usdOverWindow);
}

/** Tokens worth of non-trivial lines present in both instruction files. */
function sharedLineTokens(a: string, b: string): number {
  const linesOf = (file: string): string[] => {
    try {
      return fs.readFileSync(file, 'utf8').split('\n');
    } catch {
      return [];
    }
  };
  // Short lines are headings, bullets and blanks that collide by accident;
  // counting them would invent duplication that is not there.
  const meaningful = (line: string) => line.trim().length >= 40;
  const first = new Set(
    linesOf(a)
      .filter(meaningful)
      .map((l) => l.trim()),
  );
  let chars = 0;
  for (const line of linesOf(b)) {
    const t = line.trim();
    if (meaningful(t) && first.has(t)) chars += t.length + 1;
  }
  return Math.round(chars / CHARS_PER_TOKEN);
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
  const skillInvocations = new Set<string>();
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
    for (const skill of scan.skillInvocations) skillInvocations.add(skill);

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

  /* Keyed by the folded name so a startup announcement and a tool call to the
     same server land in the same row; `display` keeps the name the user
     configured, which is the one worth showing. See normalizeServerName. */
  const serversPresent = new Map<string, { display: string; sessions: number; tokens: number }>();
  for (const session of freshSessions) {
    for (const [server, tokens] of session.mcpServers) {
      const key = normalizeServerName(server);
      const row = serversPresent.get(key) ?? { display: server, sessions: 0, tokens: 0 };
      row.sessions++;
      row.tokens += tokens;
      serversPresent.set(key, row);
    }
  }
  const mcpServers: McpServerRow[] = [
    ...new Set([...serversPresent.keys(), ...mcpToolCalls.keys()]),
  ]
    .map((key) => {
      const present = serversPresent.get(key);
      return {
        server: present?.display ?? key,
        sessionsPresent: present?.sessions ?? 0,
        instructionTokens: Math.round((present?.tokens ?? 0) / Math.max(1, present?.sessions ?? 1)),
        toolCalls: mcpToolCalls.get(key) ?? 0,
      };
    })
    .sort((a, b) => b.sessionsPresent - a.sessionsPresent || b.toolCalls - a.toolCalls);

  const skillsPresent = new Map<string, { sessions: number; tokens: number }>();
  for (const session of freshSessions) {
    for (const [skill, tokens] of session.skills) {
      const row = skillsPresent.get(skill) ?? { sessions: 0, tokens: 0 };
      row.sessions++;
      row.tokens += tokens;
      skillsPresent.set(skill, row);
    }
  }

  const instructionFiles = readInstructionFiles(opts.projectRoot);

  /* Cheap next to the scan above — it reads a handful of recent sessions, not
     the corpus — so it rides along rather than making the user ask twice. */
  const textCompression = await analyzeStartupText({
    projectRoot: opts.projectRoot,
    listSessions: opts.listSessions,
  });

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
    instructionFiles,
    recommendations: buildRecommendations({
      mcpServers,
      skillsPresent,
      skillInvocations,
      instructionFiles,
      freshSessions: freshSessions.length,
      projectFreshSessions: opts.projectRoot
        ? freshSessions.filter((s) => s.projectPath === opts.projectRoot).length
        : 0,
      meanStartup,
      startupUsd,
      days,
    }),
    textCompression,
    observationWindow: `${days} days, ${freshSessions.length} fresh sessions`,
    notes: [
      'Computed locally from session logs. Nothing is sent anywhere.',
      'textCompression proposes deletions only, and only where another source in the same startup block still says the same thing. Nothing is reworded and nothing is written.',
      'Every recommendation rests on evidence of non-use over the stated window — never on size. A tool missing from the startup block is a tool the agent will not call.',
      "SessionStart hooks get no recommendation on purpose: nothing in the log says whether the model used a hook's output, so there is no evidence of non-use to stand on.",
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
