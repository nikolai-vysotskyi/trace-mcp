/**
 * Benchmark Lab runner (TRA-1951).
 *
 * Three arms over the same pinned battery — the recall-harness fixtures
 * (`tests/recall-harness/fixtures/*.json`, committed, content-hashed per run
 * so a re-run is comparable or visibly not). No network, no LLM, no API keys:
 * every arm drives local code only, and every token figure is exact
 * (`gpt-tokenizer`, o200k_base — the same counter `bench-response-tokens`
 * prices the wire with), never chars/4.
 *
 * What each arm does per fixture:
 *
 *   file-reading (control) — reads the raw files that answer the query from
 *     disk (defining files of the expected symbols, the expected files
 *     themselves, the seeded decision texts). Calls = file reads.
 *   minimal — one index call per fixture: `search` for symbols, `search_text`
 *     for files, `query_decisions` for decisions.
 *   standard — the wider surface per fixture: `search` + `get_symbol` source
 *     on the top hit, a packed context envelope for files, broader decision
 *     recall with content. More context, priced the same way.
 *
 * Success is recall@k >= the fixture's own baseline for the tool arms (the
 * same bar the recall harness enforces) and "every expected file read" for
 * the control. A run that cannot resolve its battery — no index DB, missing
 * fixtures dir — throws an honest error instead of recording a zero.
 *
 * The loader below intentionally duplicates the harness fixture shape instead
 * of importing `tests/recall-harness/runner.ts`: src/ must stay importable
 * from the built daemon without dragging the test tree along.
 */

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import { initializeDatabase } from '../db/schema.js';
import { Store } from '../db/store.js';
import { DecisionStore } from '../memory/decision-store.js';
import { findProjectRoot } from '../project-root.js';
import { getProject } from '../registry.js';
import { getSymbol, search } from '../tools/navigation/navigation.js';
import { searchText } from '../tools/navigation/search-text.js';
import { packContext } from '../tools/refactoring/pack-context.js';
import { PluginRegistry } from '../plugin-api/registry.js';
import { getLabArm, LAB_ARMS, type LabArmId } from './arms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const LAB_SCHEMA_VERSION = 1;

/** Pricing for the cost column. Named in every export so the number is auditable. */
export const LAB_MODEL_NAME = 'claude-sonnet-4-5';
export const LAB_INPUT_USD_PER_MTOK = 3.0;

// ──────────────────────────────────────────────────────────────────────────
// Battery (fixture shape mirrors tests/recall-harness/runner.ts)
// ──────────────────────────────────────────────────────────────────────────

export type LabFixtureKind = 'symbol' | 'file' | 'decision';

export interface LabDecisionSeed {
  title: string;
  content: string;
  type:
    | 'architecture_decision'
    | 'tech_choice'
    | 'bug_root_cause'
    | 'preference'
    | 'tradeoff'
    | 'discovery'
    | 'convention';
  tags?: string[];
  file_path?: string;
  symbol_id?: string;
}

export interface LabFixture {
  id: string;
  query: string;
  kind: LabFixtureKind;
  expected_ids: string[];
  k?: number;
  min_recall_at_k: number;
  notes?: string;
  decisions_seed?: LabDecisionSeed[];
  decision_filters?: { search?: string; tag?: string; type?: LabDecisionSeed['type'] };
}

function defaultFixturesDir(): string {
  // src/benchmark-lab → repo root in dev; tsup flattens dist/*.js, so the
  // bundled module sits one level below the package root. Walk up instead of
  // counting levels — the count differs per build.
  return (
    findUpwards(['tests', 'recall-harness', 'fixtures']) ??
    // Fallback keeps the honest "battery not found" error in loadLabFixtures
    // (e.g. an installed package without tests/) instead of throwing here.
    path.resolve(__dirname, '..', '..', 'tests', 'recall-harness', 'fixtures')
  );
}

/**
 * Walk up from this module looking for `targetParts` joined onto a parent.
 * Level-counting breaks across builds (tsup flattens dist/), existence does not.
 */
function findUpwards(targetParts: string[], maxDepth = 8): string | null {
  let dir = __dirname;
  for (let i = 0; i <= maxDepth; i++) {
    try {
      if (fs.existsSync(path.join(dir, ...targetParts))) return path.join(dir, ...targetParts);
    } catch {
      // Permission errors while probing are not a verdict — keep walking.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function loadLabFixtures(dir: string = defaultFixturesDir()): LabFixture[] {
  if (!fs.existsSync(dir)) {
    throw new Error(
      `Benchmark Lab battery not found: ${dir}. The fixtures ship with the repository checkout — ` +
        `a run from an installed package without tests/ cannot measure against them.`,
    );
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const out: LabFixture[] = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
    const parsed = JSON.parse(raw) as LabFixture;
    if (!parsed.id) parsed.id = f.replace(/\.json$/, '');
    out.push(parsed);
  }
  return out;
}

/**
 * Content hash of the pinned battery. Recorded on every run: two runs are
 * comparable when their fixtures_sha match, and the hash says so instead of
 * the calendar.
 */
export function hashFixturesDir(dir: string = defaultFixturesDir()): string {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f);
    h.update('\n');
    h.update(fs.readFileSync(path.join(dir, f)));
    h.update('\n');
  }
  return h.digest('hex').slice(0, 16);
}

// ──────────────────────────────────────────────────────────────────────────
// Results
// ──────────────────────────────────────────────────────────────────────────

export interface LabArmMeasurement {
  /** Tool calls (file reads for the control arm). */
  calls: number;
  /** Exact response tokens (o200k_base) over what the arm returned. */
  tokens: number;
  /** recall@k >= fixture baseline (tool arms) or every expected file read (control). */
  success: boolean;
  /** Wall clock for this fixture × arm, milliseconds. */
  ms: number;
  /** Recall@k behind success, for the tool arms. Null for the control. */
  recall_at_k: number | null;
  /** Short human note when success is false (missing file, empty search, …). */
  note?: string;
}

export interface LabFixtureResult {
  fixture_id: string;
  kind: LabFixtureKind;
  query: string;
  k: number;
  baseline: number;
  arms: Partial<Record<LabArmId, LabArmMeasurement>>;
}

export interface LabArmAggregate {
  arm: LabArmId;
  fixtures: number;
  success_count: number;
  success_rate: number;
  total_tokens: number;
  total_calls: number;
  total_ms: number;
  median_tokens_per_fixture: number;
  /** Share of the control arm's tokens this arm did not spend. Null when the run has no control arm. */
  savings_vs_baseline_pct: number | null;
  cost_usd: number;
}

export interface LabRun {
  schema_version: number;
  run_id: string;
  started_at: string;
  finished_at: string;
  project_root: string;
  battery: {
    source: string;
    fixtures_dir: string;
    fixtures_sha: string;
    fixture_count: number;
  };
  measured_build: { version: string; commit: string; dirty?: boolean };
  model: { name: string; input_usd_per_mtok: number };
  arms: LabArmId[];
  results: LabFixtureResult[];
  aggregates: LabArmAggregate[];
}

export interface RunLabOptions {
  projectRoot?: string;
  /** Override the index DB path (otherwise resolved via the registry). */
  dbPath?: string;
  /** Override the battery dir (tests use a hand-written temp battery). */
  fixturesDir?: string;
  arms?: LabArmId[];
  filterIds?: string[];
  modelName?: string;
  inputUsdPerMtok?: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Measurement
// ──────────────────────────────────────────────────────────────────────────

function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return encode(text).length;
}

/**
 * Substring accounting, same semantics as the recall harness: an expected id
 * is satisfied when it appears (case-insensitive) in any retrieved id.
 */
function matchedExpected(retrieved: string[], expected: string[]): string[] {
  const lower = retrieved.map((r) => r.toLowerCase());
  return expected.filter((exp) => {
    const needle = exp.toLowerCase();
    return lower.some((r) => r.includes(needle));
  });
}

interface RetrievalContext {
  store: Store;
  pluginRegistry: PluginRegistry;
  projectRoot: string;
}

interface ArmDrive {
  calls: number;
  /** The exact text priced in tokens — wire payload for tools, file bytes for the control. */
  text: string;
  /** Ids the recall check matches expected_ids against. */
  retrievedIds: string[];
  note?: string;
}

function readFileOrNull(absPath: string): string | null {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
    return fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Resolve one expected id to the raw files an agent without an index would
 * read: an exact relative path first, then indexed files with a matching
 * basename (fixtures pin basenames like `pipeline.ts`, matched by substring
 * in the harness), then — for symbol fixtures — the defining file of the
 * top search hit. Returns the de-duplicated absolute paths.
 */
async function resolveControlFiles(
  ctx: RetrievalContext,
  fixture: LabFixture,
  expected: string,
): Promise<string[]> {
  const exact = path.resolve(ctx.projectRoot, expected);
  const exactContent = readFileOrNull(exact);
  if (exactContent !== null) return [exact];

  let rows: { path: string }[] = [];
  try {
    rows = ctx.store.db.prepare('SELECT path FROM files WHERE status != ?').all('error') as {
      path: string;
    }[];
  } catch {
    rows = [];
  }
  const baseMatches = rows
    .map((r) => r.path)
    .filter((p) => p === expected || p.endsWith(`/${expected}`));
  // A basename that matches half the repo is a fixture bug, not a baseline:
  // cap the read set and say so in the note.
  const capped = baseMatches.slice(0, 25);
  const readable = capped.filter((p) => readFileOrNull(path.resolve(ctx.projectRoot, p)) !== null);
  if (readable.length > 0) {
    return [...new Set(readable)].map((p) => path.resolve(ctx.projectRoot, p));
  }

  if (fixture.kind === 'symbol') {
    const result = await search(ctx.store, expected, undefined, 5);
    const file = result.items[0]?.file?.path;
    if (file && readFileOrNull(path.resolve(ctx.projectRoot, file)) !== null) {
      return [path.resolve(ctx.projectRoot, file)];
    }
  }
  return [];
}

async function driveControl(ctx: RetrievalContext, fixture: LabFixture): Promise<ArmDrive> {
  if (fixture.kind === 'decision') {
    const seeds = fixture.decisions_seed ?? [];
    const text = seeds.map((s) => `# ${s.title}\n${s.content}`).join('\n\n');
    return {
      calls: seeds.length,
      text,
      retrievedIds: seeds.map((s) => s.title),
      note: seeds.length === 0 ? 'no seeded decisions to re-read' : undefined,
    };
  }
  const texts: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const expected of fixture.expected_ids) {
    const files = await resolveControlFiles(ctx, fixture, expected);
    if (files.length === 0) {
      missing.push(expected);
      continue;
    }
    for (const abs of files) {
      if (seen.has(abs)) continue;
      seen.add(abs);
      const content = readFileOrNull(abs);
      if (content === null) missing.push(abs);
      else texts.push(content);
    }
  }
  return {
    calls: seen.size + missing.length,
    text: texts.join('\n'),
    retrievedIds: fixture.expected_ids.filter((e) => !missing.includes(e)),
    note: missing.length > 0 ? `unresolved files: ${missing.join(', ')}` : undefined,
  };
}

function runDecisionQuery(
  fixture: LabFixture,
  limit: number,
): { title: string; content: string }[] {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-lab-decision-'));
  const dbPath = path.join(tmpRoot, 'decisions.db');
  const store = new DecisionStore(dbPath);
  try {
    const projectRoot = '/__benchmark_lab__';
    for (const seed of fixture.decisions_seed ?? []) {
      store.addDecision({
        title: seed.title,
        content: seed.content,
        type: seed.type,
        project_root: projectRoot,
        tags: seed.tags,
        file_path: seed.file_path,
        symbol_id: seed.symbol_id,
        source: 'manual',
        confidence: 1,
      });
    }
    return store
      .queryDecisions({
        project_root: projectRoot,
        search: fixture.decision_filters?.search ?? fixture.query,
        tag: fixture.decision_filters?.tag,
        type: fixture.decision_filters?.type,
        limit: Math.max(limit, 1),
      })
      .map((d) => ({ title: d.title, content: d.content ?? '' }));
  } finally {
    store.db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function driveMinimal(
  ctx: RetrievalContext,
  fixture: LabFixture,
  k: number,
): Promise<ArmDrive> {
  if (fixture.kind === 'symbol') {
    const result = await search(ctx.store, fixture.query, undefined, Math.max(k, 10));
    const top = result.items.slice(0, k).map((it) => ({
      symbol_id: it.symbol.symbol_id ?? it.symbol.fqn ?? it.symbol.name ?? '',
      name: it.symbol.name,
      file: it.file.path,
      line: it.symbol.line_start ?? null,
    }));
    return {
      calls: 1,
      text: JSON.stringify(top),
      retrievedIds: top.map((t) => t.symbol_id),
      note: top.length === 0 ? 'search returned nothing' : undefined,
    };
  }
  if (fixture.kind === 'file') {
    const res = searchText(ctx.store, ctx.projectRoot, {
      query: fixture.query,
      maxResults: Math.max(k, 10),
      contextLines: 0,
    });
    if (!res.isOk()) {
      return { calls: 1, text: '', retrievedIds: [], note: 'search_text failed' };
    }
    const seen = new Set<string>();
    for (const m of res.value.matches) {
      seen.add(m.file);
      if (seen.size >= k) break;
    }
    const files = [...seen];
    return {
      calls: 1,
      text: JSON.stringify(files),
      retrievedIds: files,
      note: files.length === 0 ? 'search_text matched no files' : undefined,
    };
  }
  const decisions = runDecisionQuery(fixture, Math.max(k, 20));
  const titles = decisions.slice(0, k).map((d) => d.title);
  return {
    calls: 1,
    text: JSON.stringify(titles),
    retrievedIds: titles,
    note: titles.length === 0 ? 'no decisions recalled' : undefined,
  };
}

async function driveStandard(
  ctx: RetrievalContext,
  fixture: LabFixture,
  k: number,
): Promise<ArmDrive> {
  if (fixture.kind === 'symbol') {
    const result = await search(ctx.store, fixture.query, undefined, Math.max(k, 10));
    const top = result.items.slice(0, k);
    const ids = top.map((it) => it.symbol.symbol_id ?? it.symbol.fqn ?? it.symbol.name ?? '');
    let calls = 1;
    let source = '';
    const firstId = ids[0];
    if (firstId) {
      // The standard surface reads the top hit, not just its id.
      const got = getSymbol(ctx.store, ctx.projectRoot, { symbolId: firstId, maxLines: 60 });
      calls = 2;
      if (got.isOk()) source = got.value.source;
    }
    return {
      calls,
      text: JSON.stringify({ hits: ids, top_source: source }),
      retrievedIds: ids,
      note: ids.length === 0 ? 'search returned nothing' : undefined,
    };
  }
  if (fixture.kind === 'file') {
    const packed = packContext(ctx.store, ctx.pluginRegistry, {
      scope: 'feature',
      query: fixture.query,
      maxTokens: 8000,
      format: 'markdown',
      strategy: 'most_relevant',
      compress: false,
      include: ['outlines', 'source'],
      projectRoot: ctx.projectRoot,
    });
    const seen = new Set<string>();
    const ordered: string[] = [];
    const headerRe = /^###\s+([^\n`(]+?)(?:\s+\(truncated\))?\s*$/gm;
    let match: RegExpExecArray | null = headerRe.exec(packed.content);
    while (match !== null) {
      const candidate = match[1].trim();
      if (!seen.has(candidate)) {
        seen.add(candidate);
        ordered.push(candidate);
      }
      match = headerRe.exec(packed.content);
    }
    return {
      calls: 1,
      text: packed.content,
      retrievedIds: ordered.slice(0, k),
      note: ordered.length === 0 ? 'packContext included no files' : undefined,
    };
  }
  // Broader recall with content: more tokens than minimal's titles, priced honestly.
  const decisions = runDecisionQuery(fixture, 20);
  const top = decisions
    .slice(0, k)
    .map((d) => ({ title: d.title, content: d.content.slice(0, 500) }));
  return {
    calls: 1,
    text: JSON.stringify(top),
    retrievedIds: top.map((d) => d.title),
    note: top.length === 0 ? 'no decisions recalled' : undefined,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Provenance
// ──────────────────────────────────────────────────────────────────────────

function repoRootFromHere(): string | null {
  // The package root is the ancestor holding trace-mcp's own package.json.
  // Matched by package name, not depth: a stray package.json in a parent
  // directory must not capture the lookup.
  let dir = __dirname;
  for (let i = 0; i <= 8; i++) {
    try {
      const manifest = path.join(dir, 'package.json');
      if (fs.existsSync(manifest)) {
        const name = (JSON.parse(fs.readFileSync(manifest, 'utf-8')) as { name?: string }).name;
        if (name === 'trace-mcp') return dir;
      }
    } catch {
      // Unreadable manifest — keep walking.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function measuredBuildInfo(): { version: string; commit: string; dirty?: boolean } {
  let version = '0.0.0';
  const root = repoRootFromHere();
  if (root) {
    try {
      version = (
        JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as { version: string }
      ).version;
    } catch {
      // keep the fallback — the run records what it can, never fails on provenance
    }
  }
  let commit = 'unknown';
  let dirty: boolean | undefined;
  if (root) {
    try {
      commit = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
        cwd: root,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      dirty =
        execFileSync('git', ['status', '--porcelain'], {
          cwd: root,
          encoding: 'utf-8',
          timeout: 5000,
        }).trim().length > 0;
    } catch {
      commit = 'unknown';
      dirty = undefined;
    }
  }
  return dirty ? { version, commit, dirty } : { version, commit };
}

function makeRunId(startedAt: Date): string {
  const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  // Uniqueness suffix only, never a secret — but Math.random() trips the
  // Semgrep insecure-RNG gate, so spend the syscall and use randomBytes.
  const rand = randomBytes(3).toString('hex');
  return `lab-${stamp}-${rand}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Orchestration
// ──────────────────────────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Run the battery and return the full record. The caller persists it (the
 * daemon saves every run; scripts decide per invocation).
 */
export async function runLab(opts: RunLabOptions = {}): Promise<LabRun> {
  const startedAt = new Date();
  const projectRoot = opts.projectRoot ?? findProjectRoot(process.cwd());
  const entry = opts.dbPath ? undefined : getProject(projectRoot);
  const dbPath = opts.dbPath ?? entry?.dbPath;
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error(
      `Benchmark Lab needs an indexed project. Run \`trace-mcp add ${projectRoot}\` first ` +
        `(no index DB at ${dbPath ?? '(unknown)'}).`,
    );
  }

  const fixturesDir = opts.fixturesDir ?? defaultFixturesDir();
  const allFixtures = loadLabFixtures(fixturesDir);
  const fixtures = allFixtures.filter((f) => !opts.filterIds || opts.filterIds.includes(f.id));
  if (fixtures.length === 0) {
    throw new Error('Benchmark Lab battery is empty — no fixtures matched the requested filter.');
  }

  const requestedArms = opts.arms ?? (LAB_ARMS.map((a) => a.id) as LabArmId[]);
  for (const id of requestedArms) {
    if (!getLabArm(id)) throw new Error(`Unknown Benchmark Lab arm: ${id}.`);
  }
  const modelName = opts.modelName ?? LAB_MODEL_NAME;
  const price = opts.inputUsdPerMtok ?? LAB_INPUT_USD_PER_MTOK;

  const db = initializeDatabase(dbPath);
  const store = new Store(db);
  const pluginRegistry = PluginRegistry.createWithDefaults();
  const ctx: RetrievalContext = { store, pluginRegistry, projectRoot };

  const results: LabFixtureResult[] = [];
  try {
    for (const fixture of fixtures) {
      const k = fixture.k ?? 10;
      const row: LabFixtureResult = {
        fixture_id: fixture.id,
        kind: fixture.kind,
        query: fixture.query,
        k,
        baseline: fixture.min_recall_at_k,
        arms: {},
      };
      for (const arm of requestedArms) {
        const t0 = Date.now();
        try {
          const drive =
            arm === 'file-reading'
              ? await driveControl(ctx, fixture)
              : arm === 'minimal'
                ? await driveMinimal(ctx, fixture, k)
                : await driveStandard(ctx, fixture, k);
          const tokens = countTokens(drive.text);
          if (arm === 'file-reading') {
            // The control succeeds when every expected id is covered by what
            // was actually read — same substring accounting as the tool arms,
            // so a decision corpus with noise seeds does not fail its own fixture.
            const matched = matchedExpected(drive.retrievedIds, fixture.expected_ids);
            row.arms[arm] = {
              calls: drive.calls,
              tokens,
              success:
                fixture.expected_ids.length > 0 && matched.length === fixture.expected_ids.length,
              ms: Date.now() - t0,
              recall_at_k: null,
              ...(drive.note && matched.length !== fixture.expected_ids.length
                ? { note: drive.note }
                : {}),
            };
          } else {
            const matched = matchedExpected(drive.retrievedIds.slice(0, k), fixture.expected_ids);
            const recall =
              fixture.expected_ids.length === 0 ? 1 : matched.length / fixture.expected_ids.length;
            row.arms[arm] = {
              calls: drive.calls,
              tokens,
              success: recall >= fixture.min_recall_at_k,
              ms: Date.now() - t0,
              recall_at_k: recall,
              ...(drive.note && recall < fixture.min_recall_at_k ? { note: drive.note } : {}),
            };
          }
        } catch (err) {
          row.arms[arm] = {
            calls: 0,
            tokens: 0,
            success: false,
            ms: Date.now() - t0,
            recall_at_k: null,
            note: `error: ${(err as Error).message}`,
          };
        }
      }
      results.push(row);
    }
  } finally {
    db.close();
  }

  const finishedAt = new Date();
  const baselineTotals = new Map<string, number>();
  for (const r of results) {
    const b = r.arms['file-reading'];
    if (b) baselineTotals.set(r.fixture_id, b.tokens);
  }
  const baselineTotal = [...baselineTotals.values()].reduce((s, v) => s + v, 0);

  const aggregates: LabArmAggregate[] = requestedArms.map((arm) => {
    const per = results.map((r) => r.arms[arm]).filter((m): m is LabArmMeasurement => !!m);
    const successCount = per.filter((m) => m.success).length;
    const totalTokens = per.reduce((s, m) => s + m.tokens, 0);
    const savings =
      arm === 'file-reading' || baselineTotal === 0 || !requestedArms.includes('file-reading')
        ? null
        : Math.round(((baselineTotal - totalTokens) / baselineTotal) * 1000) / 10;
    return {
      arm,
      fixtures: per.length,
      success_count: successCount,
      success_rate: per.length === 0 ? 0 : Math.round((successCount / per.length) * 1000) / 10,
      total_tokens: totalTokens,
      total_calls: per.reduce((s, m) => s + m.calls, 0),
      total_ms: per.reduce((s, m) => s + m.ms, 0),
      median_tokens_per_fixture: median(per.map((m) => m.tokens)),
      savings_vs_baseline_pct: savings,
      cost_usd: Math.round((totalTokens / 1_000_000) * price * 10000) / 10000,
    };
  });

  return {
    schema_version: LAB_SCHEMA_VERSION,
    run_id: makeRunId(startedAt),
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    project_root: projectRoot,
    battery: {
      source: 'tests/recall-harness/fixtures',
      fixtures_dir: fixturesDir,
      fixtures_sha: hashFixturesDir(fixturesDir),
      fixture_count: fixtures.length,
    },
    measured_build: measuredBuildInfo(),
    model: { name: modelName, input_usd_per_mtok: price },
    arms: requestedArms,
    results,
    aggregates,
  };
}
