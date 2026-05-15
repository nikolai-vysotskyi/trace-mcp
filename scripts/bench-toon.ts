#!/usr/bin/env tsx
/**
 * Bench TOON token savings on real tool outputs.
 *
 * Methodology:
 *   - Invoke the actual registered MCP tool handler closures via the
 *     same fake-server pattern that the wiring tests in
 *     `src/tools/register/__tests__/*-toon.test.ts` use. This guarantees
 *     the EXACT shape that the production handlers emit, while sidestepping
 *     the MCP transport.
 *   - For tools that can run against the live trace-mcp self-index DB
 *     (search, get_outline, find_usages, search_text), we open that DB
 *     read-only via a temporary copy so the bench measures realistic
 *     codebase-scale payloads.
 *   - For tools that need bespoke fixtures (query_decisions, get_artifacts,
 *     get_changed_symbols, get_feature_context, get_context_bundle) we
 *     seed minimal but representative stores.
 *   - Each payload is serialised twice: `JSON.stringify(...)` and
 *     `encodeResponse(..., 'toon')`. We then tokenise both with
 *     gpt-tokenizer (cl100k_base) and roundtrip the TOON output via
 *     `@toon-format/toon`'s `decode()` to assert lossless equivalence.
 *
 * Run:
 *   pnpm exec tsx scripts/bench-toon.ts
 *
 * Output:
 *   - Markdown tables to stdout (overall + search_text grouping detail).
 *   - JSON object on the last stdout line for programmatic capture.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encode as tokenEncode } from 'gpt-tokenizer';
import { decode as toonDecode } from '@toon-format/toon';
import { z } from 'zod';

import { initializeDatabase } from '../src/db/schema.js';
import { Store } from '../src/db/store.js';
import { DecisionStore } from '../src/memory/decision-store.js';

import { registerNavigationTools } from '../src/tools/register/navigation.js';
import { registerAdvancedTools } from '../src/tools/register/advanced.js';
import { registerAnalysisTools } from '../src/tools/register/analysis.js';
import { registerFrameworkTools } from '../src/tools/register/framework.js';
import { registerGitTools } from '../src/tools/register/git.js';
import { registerMemoryTools } from '../src/tools/register/memory.js';
import { registerQualityTools } from '../src/tools/register/quality.js';
import { registerSessionTools } from '../src/tools/register/session.js';

import { encodeResponse } from '../src/tools/_common/output-format.js';
import { upsertPin } from '../src/scoring/pins.js';

import type { ServerContext, MetaContext } from '../src/server/types.js';

// ── Stub server helpers ─────────────────────────────────────────────────────

type Handler = (
  args: Record<string, unknown>,
  extra?: unknown,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface CapturedTool {
  name: string;
  description: string;
  schemaShape: Record<string, z.ZodTypeAny>;
  handler: Handler;
}

function makeCapturingServer(): { server: unknown; captured: CapturedTool[] } {
  const captured: CapturedTool[] = [];
  const server = {
    tool: (
      name: string,
      description: string,
      schemaShape: Record<string, z.ZodTypeAny>,
      handler: Handler,
    ) => {
      captured.push({ name, description, schemaShape, handler });
    },
    // Some register* functions (session.ts) also register MCP resources and
    // prompts. The bench doesn't exercise those code paths, so swallow them.
    resource: (..._args: unknown[]) => undefined,
    prompt: (..._args: unknown[]) => undefined,
  };
  return { server, captured };
}

function findTool(captured: CapturedTool[], name: string): CapturedTool {
  const tool = captured.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} was not registered`);
  return tool;
}

function baseCtxStub(overrides: Record<string, unknown>): ServerContext {
  const stub = {
    projectRoot: '/tmp/fake-project',
    config: {},
    registry: { getAllFrameworkPlugins: () => [] },
    embeddingService: null,
    vectorStore: null,
    reranker: null,
    rankingLedger: null,
    decisionStore: null,
    telemetrySink: null,
    topoStore: null,
    progress: null,
    aiProvider: null,
    journal: null,
    savings: {
      getSessionStats: () => ({ total_calls: 0, total_raw_tokens: 0 }),
      getLatencyPerTool: () => ({}) as Record<string, unknown>,
    },
    has: () => false,
    guardPath: () => null,
    j: (v: unknown) => JSON.stringify(v),
    jh: (_tool: string, v: unknown) => JSON.stringify(v),
    markExplored: () => undefined,
    onPipelineEvent: () => undefined,
    ...overrides,
  };
  return stub as unknown as ServerContext;
}

function metaCtxStub(overrides: Record<string, unknown>): MetaContext {
  const base = baseCtxStub(overrides) as unknown as Record<string, unknown>;
  const meta = {
    ...base,
    _originalTool: () => undefined,
    registeredToolNames: [] as string[],
    toolHandlers: new Map<string, unknown>(),
    presetName: 'bench',
  };
  return meta as unknown as MetaContext;
}

// ── Token / byte counting ───────────────────────────────────────────────────

function countTokens(text: string): number {
  return tokenEncode(text).length;
}

function pct(baseline: number, compact: number): number {
  if (baseline <= 0) return 0;
  return Math.round((1 - compact / baseline) * 1000) / 10;
}

// ── Payload extraction from handler responses ──────────────────────────────

interface PayloadPair {
  /** Same logical payload, JSON-serialised. */
  jsonText: string;
  /** Same logical payload, TOON-serialised. */
  toonText: string;
  /** Parsed JSON, for roundtrip assertion. */
  parsedJson: unknown;
}

/**
 * Loose equality that tolerates float-precision loss from TOON's number
 * formatting. The TOON encoder rounds high-precision floats (e.g.
 * PageRank scores like 0.6591564078703704 → 0.6591564075810186). The
 * payload is logically identical to within ~7-8 significant digits.
 * Returns true when corresponding numbers are within `tol`, all keys
 * match, and all strings/booleans are exactly equal.
 */
function looselyEqual(a: unknown, b: unknown, tol = 1e-6): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
    const diff = Math.abs(a - b);
    const mag = Math.max(1, Math.abs(a), Math.abs(b));
    return diff / mag < tol;
  }
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!looselyEqual(a[i], b[i], tol)) return false;
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!looselyEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tol))
        return false;
    }
    return true;
  }
  return false;
}

async function callBoth(tool: CapturedTool, args: Record<string, unknown>): Promise<PayloadPair> {
  const jsonRes = await tool.handler({ ...args }, {});
  const toonRes = await tool.handler({ ...args, output_format: 'toon' }, {});
  if (jsonRes.isError) {
    throw new Error(`tool ${tool.name} returned isError on json call: ${jsonRes.content[0].text}`);
  }
  if (toonRes.isError) {
    throw new Error(`tool ${tool.name} returned isError on toon call: ${toonRes.content[0].text}`);
  }
  const jsonText = jsonRes.content[0].text;
  const toonText = toonRes.content[0].text;
  const parsedJson = JSON.parse(jsonText);
  // Roundtrip assertion — TOON must be lossless against the JSON output,
  // modulo float-precision quantization (~7 significant digits).
  const decoded = toonDecode(toonText);
  if (!looselyEqual(decoded, parsedJson)) {
    throw new Error(`TOON roundtrip mismatch for tool ${tool.name}`);
  }
  return { jsonText, toonText, parsedJson };
}

interface Row {
  scenario: string;
  json_tokens: number;
  toon_tokens: number;
  savings_pct: number;
  json_bytes: number;
  toon_bytes: number;
  bytes_savings_pct: number;
  notes?: string;
}

interface Wave2Row extends Row {
  /** "table" or "list" — derived from the TOON header regex. */
  mode: 'table' | 'list';
  /** Item count exposed in the response payload (best-effort). */
  items: number;
}

/**
 * Detect TOON encoding mode. Table mode emits a `[N]{f1,f2,f3}:` header
 * line; list mode does not. This is the proven detector from
 * `scripts/toon-diagnostic-2.ts`.
 */
function detectToonMode(toonText: string): 'table' | 'list' {
  return /\[\d+\]\{[^}]+\}:/.test(toonText) ? 'table' : 'list';
}

/**
 * Bench an *unwired* tool by:
 *   1. Calling the handler with JSON args (no output_format).
 *   2. Parsing the JSON response payload.
 *   3. Re-encoding the same payload via `encodeResponse(payload, 'toon')`.
 *   4. Tokenising both, asserting loose roundtrip, and detecting mode.
 *
 * This is the measurement path for tools that have not been wired with the
 * `output_format` schema. Wave 2 candidates all flow through this helper.
 */
async function benchUnwired(
  tool: CapturedTool,
  args: Record<string, unknown>,
  scenario: string,
  itemPath: (payload: unknown) => number,
  notes?: string,
): Promise<Wave2Row> {
  const res = await tool.handler({ ...args }, {});
  if (res.isError) {
    throw new Error(`tool ${tool.name} returned isError: ${res.content[0].text}`);
  }
  const jsonText = res.content[0].text;
  const parsed = JSON.parse(jsonText);
  // Re-encode the same logical payload as TOON. We round-trip through
  // JSON.parse so the input matches what the existing handlers would feed to
  // `encodeResponse` if they were wired with `output_format: 'toon'`.
  const toonText = encodeResponse(parsed, 'toon');
  // Verify lossless (loose-float). If TOON falls back to JSON it is still
  // valid — but a `decode` over JSON text would throw; in that case we
  // detect the fallback below and treat the row as "JSON-equivalent".
  let decoded: unknown;
  let toonFellBackToJson = false;
  try {
    decoded = toonDecode(toonText);
  } catch {
    // encodeResponse fell back to JSON.stringify (encoder threw). The row is
    // effectively JSON, so report a 0% delta rather than a false win.
    decoded = JSON.parse(toonText);
    toonFellBackToJson = true;
  }
  if (!looselyEqual(decoded, parsed)) {
    throw new Error(`TOON roundtrip mismatch for tool ${tool.name} scenario ${scenario}`);
  }
  const items = itemPath(parsed);
  const jsonTokens = countTokens(jsonText);
  const toonTokens = countTokens(toonText);
  const jsonBytes = Buffer.byteLength(jsonText, 'utf8');
  const toonBytes = Buffer.byteLength(toonText, 'utf8');
  const mode = toonFellBackToJson ? 'list' : detectToonMode(toonText);
  const noteParts: string[] = [];
  if (typeof notes === 'string' && notes.length) noteParts.push(notes);
  noteParts.push(`${items} items`);
  if (toonFellBackToJson) noteParts.push('TOON encoder fell back to JSON');
  return {
    scenario,
    json_tokens: jsonTokens,
    toon_tokens: toonTokens,
    savings_pct: pct(jsonTokens, toonTokens),
    json_bytes: jsonBytes,
    toon_bytes: toonBytes,
    bytes_savings_pct: pct(jsonBytes, toonBytes),
    notes: noteParts.join(' — '),
    mode,
    items,
  };
}

function rowFromPair(scenario: string, pair: PayloadPair, notes?: string): Row {
  const jsonTokens = countTokens(pair.jsonText);
  const toonTokens = countTokens(pair.toonText);
  const jsonBytes = Buffer.byteLength(pair.jsonText, 'utf8');
  const toonBytes = Buffer.byteLength(pair.toonText, 'utf8');
  return {
    scenario,
    json_tokens: jsonTokens,
    toon_tokens: toonTokens,
    savings_pct: pct(jsonTokens, toonTokens),
    json_bytes: jsonBytes,
    toon_bytes: toonBytes,
    bytes_savings_pct: pct(jsonBytes, toonBytes),
    notes,
  };
}

function renderTable(rows: Row[]): string {
  const header =
    '| scenario | json_tokens | toon_tokens | savings_pct | json_bytes | toon_bytes | bytes_savings_pct | notes |';
  const sep = '|---|---:|---:|---:|---:|---:|---:|---|';
  const body = rows
    .map(
      (r) =>
        `| ${r.scenario} | ${r.json_tokens} | ${r.toon_tokens} | ${r.savings_pct}% | ${r.json_bytes} | ${r.toon_bytes} | ${r.bytes_savings_pct}% | ${r.notes ?? ''} |`,
    )
    .join('\n');
  return `${header}\n${sep}\n${body}`;
}

// ── Live index access ──────────────────────────────────────────────────────

function findSelfIndexDb(): string | null {
  const indexDir = path.join(os.homedir(), '.trace-mcp', 'index');
  if (!fs.existsSync(indexDir)) return null;
  // The trace-mcp self index is named trace-mcp-<hash>.db (no -session suffix).
  // Pick the biggest non-session file as a tiebreaker if multiple exist.
  const candidates = fs
    .readdirSync(indexDir)
    .filter(
      (f) =>
        f.startsWith('trace-mcp-') &&
        f.endsWith('.db') &&
        !f.includes('-session-') &&
        !f.includes('-fk-'),
    )
    .map((f) => path.join(indexDir, f));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return candidates[0];
}

/**
 * Copy the self-index DB to a tmp location and open it. We never write to the
 * canonical DB — the live MCP server may also hold it open.
 */
function openLiveIndexCopy(): { store: Store; projectRoot: string; cleanup: () => void } | null {
  const src = findSelfIndexDb();
  if (!src) return null;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-toon-'));
  const dst = path.join(tmpDir, 'index.db');
  fs.copyFileSync(src, dst);
  // WAL sidecars may be needed when the source has uncommitted pages — copy if present.
  for (const ext of ['-wal', '-shm']) {
    const sidecar = src + ext;
    if (fs.existsSync(sidecar)) {
      try {
        fs.copyFileSync(sidecar, dst + ext);
      } catch {
        /* best effort */
      }
    }
  }
  const db = initializeDatabase(dst);
  const store = new Store(db);
  const cleanup = () => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };
  return { store, projectRoot: process.cwd(), cleanup };
}

// ── Scenario builders ──────────────────────────────────────────────────────

interface ScenarioOut {
  rows: Row[];
  /** Optional sub-tables (e.g. search_text grouping breakdown). */
  subRows?: { title: string; rows: Row[] };
}

async function benchSearch(): Promise<Row | null> {
  const live = openLiveIndexCopy();
  if (!live) {
    process.stderr.write('[bench-toon] skipping search — no live self-index DB found\n');
    return null;
  }
  try {
    const { server, captured } = makeCapturingServer();
    registerNavigationTools(
      server as Parameters<typeof registerNavigationTools>[0],
      baseCtxStub({ store: live.store, projectRoot: live.projectRoot }),
    );
    const tool = findTool(captured, 'search');
    // "register" hits many register* symbols; FTS5 stemming on short tokens
    // like "encode" can collapse to a single item, so we pick a token that
    // produces a realistic K-result payload.
    const pair = await callBoth(tool, { query: 'register', limit: 30 });
    const itemCount = Array.isArray((pair.parsedJson as Record<string, unknown>)?.items)
      ? ((pair.parsedJson as { items: unknown[] }).items?.length ?? 0)
      : 0;
    return rowFromPair('search query=register limit=30', pair, `${itemCount} items`);
  } finally {
    live.cleanup();
  }
}

async function benchOutline(): Promise<Row | null> {
  const live = openLiveIndexCopy();
  if (!live) return null;
  try {
    const { server, captured } = makeCapturingServer();
    registerNavigationTools(
      server as Parameters<typeof registerNavigationTools>[0],
      baseCtxStub({ store: live.store, projectRoot: live.projectRoot }),
    );
    const tool = findTool(captured, 'get_outline');
    // store.ts has ~92 symbols — a meaty outline payload that exercises
    // homogeneous-array TOON encoding well. register/navigation.ts has only
    // one top-level symbol in the indexed shape, so it under-represents.
    const pair = await callBoth(tool, { path: 'src/db/store.ts' });
    const symCount = Array.isArray((pair.parsedJson as Record<string, unknown>)?.symbols)
      ? ((pair.parsedJson as { symbols: unknown[] }).symbols?.length ?? 0)
      : 0;
    return rowFromPair('get_outline store.ts', pair, `${symCount} symbols`);
  } finally {
    live.cleanup();
  }
}

async function benchFindUsages(): Promise<Row | null> {
  const live = openLiveIndexCopy();
  if (!live) return null;
  try {
    const { server, captured } = makeCapturingServer();
    registerFrameworkTools(
      server as Parameters<typeof registerFrameworkTools>[0],
      baseCtxStub({ store: live.store, projectRoot: live.projectRoot }),
    );
    const tool = findTool(captured, 'find_usages');
    // Use FQN — picks up references regardless of symbol-id form. `Store`
    // is heavily referenced (~hundreds of refs in this repo).
    const pair = await callBoth(tool, { fqn: 'Store' });
    const refs = (pair.parsedJson as { references?: unknown[] }).references;
    const refCount = Array.isArray(refs) ? refs.length : 0;
    return rowFromPair('find_usages fqn=Store', pair, `${refCount} references`);
  } finally {
    live.cleanup();
  }
}

async function benchSearchText(): Promise<{
  flat: Row;
  byFile: Row;
  flatToon: Row;
  byFileToon: Row;
} | null> {
  const live = openLiveIndexCopy();
  if (!live) return null;
  try {
    const { server, captured } = makeCapturingServer();
    registerAdvancedTools(
      server as Parameters<typeof registerAdvancedTools>[0],
      baseCtxStub({ store: live.store, projectRoot: live.projectRoot }),
    );
    const tool = findTool(captured, 'search_text');
    // Common query — many hits, many files.
    const baseArgs = {
      query: 'import',
      file_pattern: 'src/**/*.ts',
      max_results: 50,
    };

    // Flat × json
    const flatJsonRes = await tool.handler({ ...baseArgs, grouping: 'flat' }, {});
    // Flat × toon
    const flatToonRes = await tool.handler(
      { ...baseArgs, grouping: 'flat', output_format: 'toon' },
      {},
    );
    // By-file × json
    const byFileJsonRes = await tool.handler({ ...baseArgs, grouping: 'by_file' }, {});
    // By-file × toon
    const byFileToonRes = await tool.handler(
      { ...baseArgs, grouping: 'by_file', output_format: 'toon' },
      {},
    );

    for (const r of [flatJsonRes, flatToonRes, byFileJsonRes, byFileToonRes]) {
      if (r.isError) throw new Error(`search_text returned isError: ${r.content[0].text}`);
    }

    const flatJsonText = flatJsonRes.content[0].text;
    const flatToonText = flatToonRes.content[0].text;
    const byFileJsonText = byFileJsonRes.content[0].text;
    const byFileToonText = byFileToonRes.content[0].text;

    // Roundtrip assertions
    const flatJsonParsed = JSON.parse(flatJsonText);
    const byFileJsonParsed = JSON.parse(byFileJsonText);
    if (JSON.stringify(toonDecode(flatToonText)) !== JSON.stringify(flatJsonParsed)) {
      throw new Error('search_text flat toon roundtrip mismatch');
    }
    if (JSON.stringify(toonDecode(byFileToonText)) !== JSON.stringify(byFileJsonParsed)) {
      throw new Error('search_text by_file toon roundtrip mismatch');
    }

    const flatMatches = Array.isArray((flatJsonParsed as { matches?: unknown[] }).matches)
      ? ((flatJsonParsed as { matches: unknown[] }).matches.length ?? 0)
      : 0;
    const byFileFiles = Array.isArray((byFileJsonParsed as { files?: unknown[] }).files)
      ? ((byFileJsonParsed as { files: unknown[] }).files.length ?? 0)
      : 0;

    const flat: Row = {
      scenario: 'search_text flat (json)',
      json_tokens: countTokens(flatJsonText),
      toon_tokens: countTokens(flatJsonText),
      savings_pct: 0,
      json_bytes: Buffer.byteLength(flatJsonText, 'utf8'),
      toon_bytes: Buffer.byteLength(flatJsonText, 'utf8'),
      bytes_savings_pct: 0,
      notes: `${flatMatches} hits — baseline`,
    };
    const flatToon: Row = {
      scenario: 'search_text flat (toon)',
      json_tokens: countTokens(flatJsonText),
      toon_tokens: countTokens(flatToonText),
      savings_pct: pct(countTokens(flatJsonText), countTokens(flatToonText)),
      json_bytes: Buffer.byteLength(flatJsonText, 'utf8'),
      toon_bytes: Buffer.byteLength(flatToonText, 'utf8'),
      bytes_savings_pct: pct(
        Buffer.byteLength(flatJsonText, 'utf8'),
        Buffer.byteLength(flatToonText, 'utf8'),
      ),
      notes: `${flatMatches} hits — toon vs flat-json`,
    };
    const byFile: Row = {
      scenario: 'search_text by_file (json)',
      json_tokens: countTokens(flatJsonText),
      toon_tokens: countTokens(byFileJsonText),
      savings_pct: pct(countTokens(flatJsonText), countTokens(byFileJsonText)),
      json_bytes: Buffer.byteLength(flatJsonText, 'utf8'),
      toon_bytes: Buffer.byteLength(byFileJsonText, 'utf8'),
      bytes_savings_pct: pct(
        Buffer.byteLength(flatJsonText, 'utf8'),
        Buffer.byteLength(byFileJsonText, 'utf8'),
      ),
      notes: `${byFileFiles} files — by_file-json vs flat-json`,
    };
    const byFileToon: Row = {
      scenario: 'search_text by_file (toon)',
      json_tokens: countTokens(flatJsonText),
      toon_tokens: countTokens(byFileToonText),
      savings_pct: pct(countTokens(flatJsonText), countTokens(byFileToonText)),
      json_bytes: Buffer.byteLength(flatJsonText, 'utf8'),
      toon_bytes: Buffer.byteLength(byFileToonText, 'utf8'),
      bytes_savings_pct: pct(
        Buffer.byteLength(flatJsonText, 'utf8'),
        Buffer.byteLength(byFileToonText, 'utf8'),
      ),
      notes: `${byFileFiles} files — by_file-toon vs flat-json`,
    };
    return { flat, byFile, flatToon, byFileToon };
  } finally {
    live.cleanup();
  }
}

async function benchQueryDecisions(): Promise<Row | null> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-toon-decisions-'));
  const decisionStore = new DecisionStore(path.join(tmpDir, 'decisions.db'));
  try {
    // Seed 20 realistic decisions.
    for (let i = 0; i < 20; i++) {
      decisionStore.addDecision({
        title: `Decision ${i}: adopt strategy ${i}`,
        content: `We decided to use approach ${i} because of measured improvements in latency and clarity. Trade-off: slightly higher memory.`,
        type: i % 2 === 0 ? 'architecture_decision' : 'tech_choice',
        project_root: '/tmp/fake-project',
        tags: ['perf', i % 2 === 0 ? 'arch' : 'tooling'],
        valid_from: `2024-${String((i % 12) + 1).padStart(2, '0')}-01T00:00:00.000Z`,
      });
    }
    const store = new Store(initializeDatabase(':memory:'));
    const { server, captured } = makeCapturingServer();
    registerMemoryTools(
      server as Parameters<typeof registerMemoryTools>[0],
      baseCtxStub({ store, decisionStore }),
    );
    const tool = findTool(captured, 'query_decisions');
    const pair = await callBoth(tool, { limit: 20 });
    const dCount = Array.isArray((pair.parsedJson as { decisions?: unknown[] }).decisions)
      ? ((pair.parsedJson as { decisions: unknown[] }).decisions.length ?? 0)
      : 0;
    return rowFromPair('query_decisions limit=20', pair, `${dCount} decisions`);
  } finally {
    decisionStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function benchGetArtifacts(): Promise<Row | null> {
  const store = new Store(initializeDatabase(':memory:'));
  // Seed routes (artifacts).
  const fileId = store.insertFile('src/routes.ts', 'typescript', 'h1', 100);
  void fileId;
  for (let i = 0; i < 30; i++) {
    store.insertRoute({
      uri: `/api/resource-${i}/{id}`,
      method: i % 2 === 0 ? 'GET' : 'POST',
      handler: `Controller${i}@handle`,
      filePath: 'src/routes.ts',
    });
  }
  const { server, captured } = makeCapturingServer();
  registerGitTools(
    server as Parameters<typeof registerGitTools>[0],
    baseCtxStub({ store, projectRoot: '/tmp/fake-project' }),
  );
  const tool = findTool(captured, 'get_artifacts');
  const pair = await callBoth(tool, { limit: 50 });
  const arts = (pair.parsedJson as { artifacts?: unknown[] }).artifacts;
  const aCount = Array.isArray(arts) ? arts.length : 0;
  return rowFromPair('get_artifacts limit=50', pair, `${aCount} artifacts`);
}

async function benchChangedSymbols(): Promise<Row | null> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-toon-changed-'));
  try {
    const run = (cmd: string) =>
      execSync(cmd, {
        cwd: repoDir,
        encoding: 'utf-8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@test.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@test.com',
        },
      });

    run('git init -b main');
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    // Five files, each with a function — gives us five symbols to mark as changed.
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        path.join(repoDir, `src/mod${i}.ts`),
        [`export function fn${i}() {`, '  return 1;', '}'].join('\n'),
      );
    }
    run('git add -A');
    run('git commit -m "initial"');
    const baseSha = run('git rev-parse HEAD').trim();

    // Modify each.
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        path.join(repoDir, `src/mod${i}.ts`),
        [`export function fn${i}() {`, `  const data = fetch${i}();`, '  return data;', '}'].join(
          '\n',
        ),
      );
    }
    run('git add -A');
    run('git commit -m "modify"');

    const store = new Store(initializeDatabase(':memory:'));
    for (let i = 0; i < 5; i++) {
      const fid = store.insertFile(`src/mod${i}.ts`, 'typescript', `h${i}`, 200);
      store.insertSymbol(fid, {
        symbolId: `src/mod${i}.ts::fn${i}#function`,
        name: `fn${i}`,
        kind: 'function',
        fqn: `fn${i}`,
        byteStart: 0,
        byteEnd: 80,
        lineStart: 1,
        lineEnd: 4,
      });
    }

    const { server, captured } = makeCapturingServer();
    registerQualityTools(
      server as Parameters<typeof registerQualityTools>[0],
      baseCtxStub({ store, projectRoot: repoDir }),
    );
    const tool = findTool(captured, 'get_changed_symbols');
    const pair = await callBoth(tool, { since: baseSha });
    const chg = (pair.parsedJson as { changes?: unknown[] }).changes;
    const cCount = Array.isArray(chg) ? chg.length : 0;
    return rowFromPair('get_changed_symbols since=HEAD~1', pair, `${cCount} changes`);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

async function benchFeatureContext(): Promise<Row | null> {
  const live = openLiveIndexCopy();
  if (!live) return null;
  try {
    const { server, captured } = makeCapturingServer();
    registerNavigationTools(
      server as Parameters<typeof registerNavigationTools>[0],
      baseCtxStub({ store: live.store, projectRoot: live.projectRoot }),
    );
    const tool = findTool(captured, 'get_feature_context');
    const pair = await callBoth(tool, {
      description: 'output format encoding for tool responses',
      token_budget: 2000,
    });
    const items = (pair.parsedJson as { items?: unknown[] }).items;
    const iCount = Array.isArray(items) ? items.length : 0;
    return rowFromPair('get_feature_context token_budget=2000', pair, `${iCount} items`);
  } finally {
    live.cleanup();
  }
}

async function benchContextBundle(): Promise<Row | null> {
  const live = openLiveIndexCopy();
  if (!live) return null;
  try {
    const { server, captured } = makeCapturingServer();
    registerNavigationTools(
      server as Parameters<typeof registerNavigationTools>[0],
      baseCtxStub({ store: live.store, projectRoot: live.projectRoot }),
    );
    const tool = findTool(captured, 'get_context_bundle');
    const pair = await callBoth(tool, {
      symbol_id: 'src/tools/_common/output-format.ts::encodeResponse#function',
      token_budget: 2000,
    });
    return rowFromPair('get_context_bundle encodeResponse', pair);
  } finally {
    live.cleanup();
  }
}

// ── Wave 2 scenarios (measurement only — these tools are not TOON-wired) ──

type Wave2Result = { kind: 'row'; row: Wave2Row } | { kind: 'skipped'; reason: string };

/**
 * Wave 2 scenarios that need the live self-index. Each one registers its
 * register* function against the live DB, invokes the handler with realistic
 * defaults, and computes both encodings via `benchUnwired`.
 */
async function benchWave2LiveIndex(): Promise<Wave2Result[]> {
  const live = openLiveIndexCopy();
  if (!live) {
    return [
      { kind: 'skipped', reason: 'no live self-index DB found — wave2 live scenarios skipped' },
    ];
  }
  const results: Wave2Result[] = [];
  try {
    // ----- analysis.ts toolset -----
    const analysis = makeCapturingServer();
    registerAnalysisTools(
      analysis.server as Parameters<typeof registerAnalysisTools>[0],
      baseCtxStub({ store: live.store, projectRoot: live.projectRoot }),
    );

    // get_pagerank: [{ file, score }]
    try {
      const tool = findTool(analysis.captured, 'get_pagerank');
      const row = await benchUnwired(tool, { limit: 50 }, 'get_pagerank limit=50', (p) =>
        Array.isArray(p) ? p.length : 0,
      );
      results.push({ kind: 'row', row });
    } catch (err) {
      results.push({ kind: 'skipped', reason: `get_pagerank: ${(err as Error).message}` });
    }

    // get_coupling: [{ file, ca, ce, instability, assessment }]
    try {
      const tool = findTool(analysis.captured, 'get_coupling');
      const row = await benchUnwired(tool, { limit: 50 }, 'get_coupling limit=50', (p) =>
        Array.isArray(p) ? p.length : 0,
      );
      results.push({ kind: 'row', row });
    } catch (err) {
      results.push({ kind: 'skipped', reason: `get_coupling: ${(err as Error).message}` });
    }

    // get_dead_exports: { dead_exports: [...], total_dead, total_exports, ... }
    try {
      const tool = findTool(analysis.captured, 'get_dead_exports');
      const row = await benchUnwired(tool, {}, 'get_dead_exports (project-wide)', (p) => {
        const arr = (p as { dead_exports?: unknown[] }).dead_exports;
        return Array.isArray(arr) ? arr.length : 0;
      });
      results.push({ kind: 'row', row });
    } catch (err) {
      results.push({ kind: 'skipped', reason: `get_dead_exports: ${(err as Error).message}` });
    }

    // get_untested_exports: { untested, total }
    try {
      const tool = findTool(analysis.captured, 'get_untested_exports');
      const row = await benchUnwired(tool, {}, 'get_untested_exports (project-wide)', (p) => {
        const arr = (p as { untested?: unknown[] }).untested;
        return Array.isArray(arr) ? arr.length : 0;
      });
      results.push({ kind: 'row', row });
    } catch (err) {
      results.push({ kind: 'skipped', reason: `get_untested_exports: ${(err as Error).message}` });
    }

    // get_untested_symbols: { untested, total }
    try {
      const tool = findTool(analysis.captured, 'get_untested_symbols');
      const row = await benchUnwired(
        tool,
        { max_results: 80 },
        'get_untested_symbols max_results=80',
        (p) => {
          const arr = (p as { untested?: unknown[] }).untested;
          return Array.isArray(arr) ? arr.length : 0;
        },
      );
      results.push({ kind: 'row', row });
    } catch (err) {
      results.push({ kind: 'skipped', reason: `get_untested_symbols: ${(err as Error).message}` });
    }

    // get_refactor_candidates: [{ symbol_id, name, file, cyclomatic, callerCount }]
    try {
      const tool = findTool(analysis.captured, 'get_refactor_candidates');
      const row = await benchUnwired(
        tool,
        { min_cyclomatic: 5, min_callers: 1, limit: 40 },
        'get_refactor_candidates limit=40',
        (p) => (Array.isArray(p) ? p.length : 0),
      );
      results.push({ kind: 'row', row });
    } catch (err) {
      results.push({
        kind: 'skipped',
        reason: `get_refactor_candidates: ${(err as Error).message}`,
      });
    }

    // get_implementations: { implementors: [...], total }
    // Each row has a `via: string | string[]` field — when any row resolves
    // to an array-valued `via` the encoder falls into list mode.
    try {
      const tool = findTool(analysis.captured, 'get_implementations');
      const row = await benchUnwired(
        tool,
        { name: 'LanguagePlugin' },
        'get_implementations name=LanguagePlugin',
        (p) => {
          const arr = (p as { implementors?: unknown[] }).implementors;
          return Array.isArray(arr) ? arr.length : 0;
        },
        'risky-control — `via` may be string OR array → list mode',
      );
      results.push({ kind: 'row', row });
    } catch (err) {
      results.push({ kind: 'skipped', reason: `get_implementations: ${(err as Error).message}` });
    }

    // list_pins: { pins, total, cap }
    // Seed two pins so the table mode is exercised.
    try {
      upsertPin(live.store.db, {
        scope: 'file',
        target_id: 'src/server.ts',
        weight: 1.5,
        created_by: 'agent',
      });
      upsertPin(live.store.db, {
        scope: 'symbol',
        target_id: 'src/db/store.ts::Store#class',
        weight: 2,
        created_by: 'user',
      });
      const tool = findTool(analysis.captured, 'list_pins');
      const row = await benchUnwired(tool, {}, 'list_pins (2 seeded)', (p) => {
        const arr = (p as { pins?: unknown[] }).pins;
        return Array.isArray(arr) ? arr.length : 0;
      });
      results.push({ kind: 'row', row });
    } catch (err) {
      results.push({ kind: 'skipped', reason: `list_pins: ${(err as Error).message}` });
    }

    // ----- git.ts toolset -----
    const git = makeCapturingServer();
    registerGitTools(
      git.server as Parameters<typeof registerGitTools>[0],
      baseCtxStub({ store: live.store, projectRoot: live.projectRoot }),
    );

    // get_complexity_report: { symbols: [...], total }
    try {
      const tool = findTool(git.captured, 'get_complexity_report');
      const row = await benchUnwired(
        tool,
        { limit: 50, min_cyclomatic: 5 },
        'get_complexity_report limit=50',
        (p) => {
          const arr = (p as { symbols?: unknown[] }).symbols;
          return Array.isArray(arr) ? arr.length : 0;
        },
      );
      results.push({ kind: 'row', row });
    } catch (err) {
      results.push({ kind: 'skipped', reason: `get_complexity_report: ${(err as Error).message}` });
    }

    // get_git_churn: { results: [...], total } — uses real project git history
    try {
      const tool = findTool(git.captured, 'get_git_churn');
      const row = await benchUnwired(
        tool,
        { limit: 50, since_days: 180 },
        'get_git_churn limit=50',
        (p) => {
          const arr = (p as { results?: unknown[] }).results;
          return Array.isArray(arr) ? arr.length : 0;
        },
      );
      results.push({ kind: 'row', row });
    } catch (err) {
      results.push({ kind: 'skipped', reason: `get_git_churn: ${(err as Error).message}` });
    }

    // get_risk_hotspots: { hotspots: [...], total }
    try {
      const tool = findTool(git.captured, 'get_risk_hotspots');
      const row = await benchUnwired(
        tool,
        { limit: 30, since_days: 180 },
        'get_risk_hotspots limit=30',
        (p) => {
          const arr = (p as { hotspots?: unknown[] }).hotspots;
          return Array.isArray(arr) ? arr.length : 0;
        },
      );
      results.push({ kind: 'row', row });
    } catch (err) {
      results.push({ kind: 'skipped', reason: `get_risk_hotspots: ${(err as Error).message}` });
    }

    // get_dead_code: { dead_symbols: [...], ... } — RISKY: signals nested obj.
    try {
      const tool = findTool(git.captured, 'get_dead_code');
      const row = await benchUnwired(
        tool,
        { limit: 30, threshold: 0.5 },
        'get_dead_code limit=30',
        (p) => {
          const arr = (p as { dead_symbols?: unknown[] }).dead_symbols;
          return Array.isArray(arr) ? arr.length : 0;
        },
        'risky-control — has nested signals object per row',
      );
      results.push({ kind: 'row', row });
    } catch (err) {
      results.push({ kind: 'skipped', reason: `get_dead_code: ${(err as Error).message}` });
    }

    // ----- framework.ts toolset -----
    const framework = makeCapturingServer();
    registerFrameworkTools(
      framework.server as Parameters<typeof registerFrameworkTools>[0],
      baseCtxStub({ store: live.store, projectRoot: live.projectRoot }),
    );

    // get_tests_for: { tests: [{ file, testName, symbol_id }], total }
    // Use a path that has corresponding test files in this repo.
    try {
      const tool = findTool(framework.captured, 'get_tests_for');
      const row = await benchUnwired(
        tool,
        { file_path: 'src/tools/_common/output-format.ts' },
        'get_tests_for output-format.ts',
        (p) => {
          const arr = (p as { tests?: unknown[] }).tests;
          return Array.isArray(arr) ? arr.length : 0;
        },
      );
      results.push({ kind: 'row', row });
    } catch (err) {
      results.push({ kind: 'skipped', reason: `get_tests_for: ${(err as Error).message}` });
    }

    // ----- advanced.ts toolset -----
    const advanced = makeCapturingServer();
    registerAdvancedTools(
      advanced.server as Parameters<typeof registerAdvancedTools>[0],
      baseCtxStub({ store: live.store, projectRoot: live.projectRoot }),
    );

    // predict_bugs: { predictions: [...] } — RISKY: signals array per row.
    try {
      const tool = findTool(advanced.captured, 'predict_bugs');
      const row = await benchUnwired(
        tool,
        { limit: 40 },
        'predict_bugs limit=40',
        (p) => {
          const arr = (p as { predictions?: unknown[] }).predictions;
          return Array.isArray(arr) ? arr.length : 0;
        },
        'risky-control — has signals array per row',
      );
      results.push({ kind: 'row', row });
    } catch (err) {
      results.push({ kind: 'skipped', reason: `predict_bugs: ${(err as Error).message}` });
    }

    // ----- session.ts toolset (analyze_perf, list_bundles, search_bundles) -----
    const session = makeCapturingServer();
    try {
      registerSessionTools(
        session.server as Parameters<typeof registerSessionTools>[0],
        metaCtxStub({ store: live.store, projectRoot: live.projectRoot }),
      );
    } catch (err) {
      results.push({
        kind: 'skipped',
        reason: `registerSessionTools threw: ${(err as Error).message}`,
      });
    }

    // analyze_perf: { tools: [{ tool, p50, p95, max, count, errors, error_rate }], ... }
    // Live perf stats are empty in this bench process — seed via the savings
    // stub so we exercise a non-trivial table-mode payload.
    try {
      // Re-register session tools with a richer savings stub so analyze_perf
      // returns a real table.
      const sessionWithStats = makeCapturingServer();
      const seededStats: Record<
        string,
        {
          p50: number;
          p95: number;
          max: number;
          count: number;
          errors: number;
          error_rate: number;
        }
      > = {};
      const toolNames = [
        'search',
        'get_outline',
        'get_symbol',
        'find_usages',
        'get_call_graph',
        'get_change_impact',
        'query_decisions',
        'get_feature_context',
        'get_artifacts',
        'get_tests_for',
        'get_dead_code',
        'predict_bugs',
        'analyze_perf',
        'list_pins',
        'get_pagerank',
      ];
      for (let i = 0; i < toolNames.length; i++) {
        seededStats[toolNames[i]] = {
          p50: 5 + i * 2,
          p95: 12 + i * 4,
          max: 40 + i * 7,
          count: 100 - i * 3,
          errors: i % 4,
          error_rate: Math.round(((i % 4) / Math.max(1, 100 - i * 3)) * 1000) / 1000,
        };
      }
      registerSessionTools(
        sessionWithStats.server as Parameters<typeof registerSessionTools>[0],
        metaCtxStub({
          store: live.store,
          projectRoot: live.projectRoot,
          savings: {
            getSessionStats: () => ({ total_calls: 0, total_raw_tokens: 0 }),
            getLatencyPerTool: () => seededStats,
          },
        }),
      );
      const tool = findTool(sessionWithStats.captured, 'analyze_perf');
      const row = await benchUnwired(tool, { top: 30 }, 'analyze_perf top=30', (p) => {
        const arr = (p as { tools?: unknown[] }).tools;
        return Array.isArray(arr) ? arr.length : 0;
      });
      results.push({ kind: 'row', row });
    } catch (err) {
      results.push({ kind: 'skipped', reason: `analyze_perf: ${(err as Error).message}` });
    }

    // list_bundles: returns empty on this corpus (no bundles installed).
    try {
      const tool = findTool(session.captured, 'list_bundles');
      const row = await benchUnwired(tool, {}, 'list_bundles', (p) => {
        const arr = (p as { bundles?: unknown[] }).bundles;
        return Array.isArray(arr) ? arr.length : 0;
      });
      if (row.items === 0) {
        results.push({
          kind: 'skipped',
          reason: 'list_bundles: empty corpus — no bundles installed locally, skipped',
        });
      } else {
        results.push({ kind: 'row', row });
      }
    } catch (err) {
      results.push({ kind: 'skipped', reason: `list_bundles: ${(err as Error).message}` });
    }

    // search_bundles: empty without installed bundles.
    try {
      const tool = findTool(session.captured, 'search_bundles');
      const row = await benchUnwired(
        tool,
        { query: 'Component', limit: 30 },
        'search_bundles query=Component',
        (p) => {
          const arr = (p as { results?: unknown[] }).results;
          return Array.isArray(arr) ? arr.length : 0;
        },
      );
      if (row.items === 0) {
        results.push({
          kind: 'skipped',
          reason: 'search_bundles: empty corpus — no bundles installed locally, skipped',
        });
      } else {
        results.push({ kind: 'row', row });
      }
    } catch (err) {
      results.push({ kind: 'skipped', reason: `search_bundles: ${(err as Error).message}` });
    }
  } finally {
    live.cleanup();
  }
  return results;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rows: Row[] = [];
  const errors: string[] = [];

  const scenarios: Array<{ name: string; run: () => Promise<Row | null> }> = [
    { name: 'search', run: benchSearch },
    { name: 'get_outline', run: benchOutline },
    { name: 'find_usages', run: benchFindUsages },
    { name: 'get_feature_context', run: benchFeatureContext },
    { name: 'get_context_bundle', run: benchContextBundle },
    { name: 'query_decisions', run: benchQueryDecisions },
    { name: 'get_artifacts', run: benchGetArtifacts },
    { name: 'get_changed_symbols', run: benchChangedSymbols },
  ];

  for (const s of scenarios) {
    try {
      const row = await s.run();
      if (row) rows.push(row);
      else errors.push(`${s.name}: skipped (no fixture available)`);
    } catch (err) {
      errors.push(`${s.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // search_text: separate sub-table.
  let searchTextSub: { flat: Row; byFile: Row; flatToon: Row; byFileToon: Row } | null = null;
  try {
    searchTextSub = await benchSearchText();
  } catch (err) {
    errors.push(`search_text: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Promote search_text flat-toon into the overall table so it's part of the headline numbers.
  if (searchTextSub) {
    rows.push({ ...searchTextSub.flatToon, scenario: 'search_text query=import (flat, toon)' });
  }

  // Wave 2 candidates: measurement-only, not wired in production.
  const wave2Rows: Wave2Row[] = [];
  const wave2Skipped: string[] = [];
  try {
    const wave2Results = await benchWave2LiveIndex();
    for (const r of wave2Results) {
      if (r.kind === 'row') wave2Rows.push(r.row);
      else wave2Skipped.push(r.reason);
    }
  } catch (err) {
    errors.push(`wave2: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Sort by savings_pct descending so winners surface first.
  wave2Rows.sort((a, b) => b.savings_pct - a.savings_pct);

  process.stdout.write('\n# TOON Token Savings Benchmark\n\n');
  process.stdout.write(
    `Tokenizer: gpt-tokenizer (cl100k_base, Claude/GPT-4 family approximation).\n`,
  );
  process.stdout.write(`Generated: ${new Date().toISOString()}\n\n`);
  process.stdout.write('## Overall — JSON vs TOON\n\n');
  process.stdout.write(`${renderTable(rows)}\n\n`);

  if (searchTextSub) {
    process.stdout.write('## search_text — flat vs by_file × json vs toon\n\n');
    process.stdout.write('All percentages are computed against the flat-json baseline.\n\n');
    process.stdout.write(
      `${renderTable([searchTextSub.flat, searchTextSub.byFile, searchTextSub.flatToon, searchTextSub.byFileToon])}\n\n`,
    );
  }

  // Wave 2 candidates table.
  process.stdout.write('## Wave 2 candidates — measurement only (not wired)\n\n');
  process.stdout.write(
    'Each row encodes the same payload that the JSON handler returns, then re-encodes it via TOON. The tools are NOT wired with `output_format` — this is a forecast for which Wave 2 candidates should be wired in a follow-up pass. Sorted by `savings_pct` descending.\n\n',
  );
  if (wave2Rows.length === 0) {
    process.stdout.write('_(no Wave 2 rows captured)_\n\n');
  } else {
    const header = '| scenario | items | json_tokens | toon_tokens | savings_pct | mode | notes |';
    const sep = '|---|---:|---:|---:|---:|:---:|---|';
    const body = wave2Rows
      .map(
        (r) =>
          `| ${r.scenario} | ${r.items} | ${r.json_tokens} | ${r.toon_tokens} | ${r.savings_pct}% | ${r.mode} | ${r.notes ?? ''} |`,
      )
      .join('\n');
    process.stdout.write(`${header}\n${sep}\n${body}\n\n`);
  }
  if (wave2Skipped.length) {
    process.stdout.write('Wave 2 skipped:\n');
    for (const s of wave2Skipped) process.stdout.write(`- ${s}\n`);
    process.stdout.write('\n');
  }

  if (errors.length) {
    process.stdout.write('## Issues\n\n');
    for (const e of errors) process.stdout.write(`- ${e}\n`);
    process.stdout.write('\n');
  }

  // Headline numbers.
  if (rows.length) {
    const savings = rows.map((r) => r.savings_pct);
    const avg = Math.round((savings.reduce((s, v) => s + v, 0) / savings.length) * 10) / 10;
    const min = Math.min(...savings);
    const max = Math.max(...savings);
    const best = rows[savings.indexOf(max)];
    const worst = rows[savings.indexOf(min)];
    process.stdout.write('## Headline\n\n');
    process.stdout.write(`- Scenarios measured: ${rows.length}\n`);
    process.stdout.write(`- Average TOON savings: ${avg}%\n`);
    process.stdout.write(
      `- Range: ${min}% (worst: ${worst.scenario}) → ${max}% (best: ${best.scenario})\n`,
    );
    if (searchTextSub) {
      process.stdout.write(
        `- search_text grouping: by_file vs flat (json) = ${searchTextSub.byFile.savings_pct}% savings\n`,
      );
      process.stdout.write(
        `- search_text grouping: by_file (toon) vs flat (json) = ${searchTextSub.byFileToon.savings_pct}% savings\n`,
      );
      process.stdout.write(
        `- search_text grouping: by_file (toon) vs flat (toon) on tokens = ${pct(
          searchTextSub.flatToon.toon_tokens,
          searchTextSub.byFileToon.toon_tokens,
        )}% additional savings from grouping on top of TOON\n`,
      );
    }
    process.stdout.write('\n');
  }

  // Machine-readable final line.
  const final = {
    rows,
    search_text_subtable: searchTextSub
      ? {
          flat_json: searchTextSub.flat,
          flat_toon: searchTextSub.flatToon,
          by_file_json: searchTextSub.byFile,
          by_file_toon: searchTextSub.byFileToon,
        }
      : null,
    wave2_rows: wave2Rows,
    wave2_skipped: wave2Skipped,
    errors,
  };
  process.stdout.write(`__BENCH_TOON_JSON__ ${JSON.stringify(final)}\n`);
}

main().catch((err) => {
  process.stderr.write(
    `bench-toon failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
