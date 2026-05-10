/**
 * Recall harness runner.
 *
 * Loads JSON fixtures from `fixtures/`, drives the live retrieval surfaces
 * (`search`, `gatherContext` via packContext file selection, and
 * `query_decisions` against an in-memory DecisionStore), and computes
 * recall@k / precision@k for each fixture. The result is a regression
 * metric: a fixture passes when recall@k >= the baseline `min_recall_at_k`
 * captured the day the fixture was authored.
 *
 * Two modes:
 *   - assert (default): each fixture's measured recall must meet its
 *                       baseline, otherwise the run fails.
 *   - update (RECALL_UPDATE=1): overwrite each fixture's `min_recall_at_k`
 *                               and `expected_ids` with today's results.
 *                               Use after an intentional ranker improvement.
 *
 * Output:
 *   - tests/recall-harness/report.json     (machine-readable, full detail)
 *   - tests/recall-harness/report.md       (markdown summary for humans)
 *
 * The vitest test in `recall.test.ts` consumes the same per-fixture results
 * via `runHarness()` and turns each fixture into an assertion.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { DecisionStore } from '../../src/memory/decision-store.js';
import { findProjectRoot } from '../../src/project-root.js';
import { getProject } from '../../src/registry.js';
import { search } from '../../src/tools/navigation/navigation.js';
import { packContext } from '../../src/tools/refactoring/pack-context.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const REPORT_JSON = path.join(__dirname, 'report.json');
const REPORT_MD = path.join(__dirname, 'report.md');
const DEFAULT_K = 10;

// ──────────────────────────────────────────────────────────────────────────
// Fixture types
// ──────────────────────────────────────────────────────────────────────────

export type FixtureKind = 'symbol' | 'file' | 'decision';

/**
 * A seed decision used only by `decision`-kind fixtures. The runner inserts
 * these into a fresh in-memory DecisionStore before running the query, so
 * the live decisions.db state can never contaminate (or starve) the test.
 */
export interface DecisionSeed {
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

export interface DecisionFilters {
  /** Optional FTS5 search string (passed to query_decisions's `search`). */
  search?: string;
  /** Optional tag filter. */
  tag?: string;
  /** Optional decision type filter. */
  type?: DecisionSeed['type'];
}

export interface RecallFixture {
  /** Stable identifier — appears in report and assertion messages. */
  id: string;
  /** Free-text query passed to the retrieval surface. */
  query: string;
  /** Which retrieval surface to exercise. */
  kind: FixtureKind;
  /**
   * Identifiers we expect to see in the top `k` results.
   *   - kind="symbol": symbol_id (preferred) or fqn substring
   *   - kind="file":   file path (relative to project root)
   *   - kind="decision": decision title (matched as substring against returned decision.title)
   */
  expected_ids: string[];
  /** Top-k cutoff. Defaults to 10 if omitted. */
  k?: number;
  /** Baseline recall — the test fails if measured recall@k drops below this. */
  min_recall_at_k: number;
  /** Optional notes explaining why this fixture exists. */
  notes?: string;
  /** For kind="decision" only — the decisions to seed into the in-memory store. */
  decisions_seed?: DecisionSeed[];
  /** For kind="decision" only — extra filter args passed to query_decisions. */
  decision_filters?: DecisionFilters;
}

// ──────────────────────────────────────────────────────────────────────────
// Result types
// ──────────────────────────────────────────────────────────────────────────

export interface FixtureResult {
  fixture: RecallFixture;
  retrieved_ids: string[];
  matched_ids: string[];
  recall_at_k: number;
  precision_at_k: number;
  k: number;
  passed: boolean;
  baseline: number;
  notes?: string;
}

export interface HarnessReport {
  generated_at: string;
  project_root: string;
  fixture_count: number;
  passed: number;
  failed: number;
  aggregate_recall_at_k: number;
  aggregate_precision_at_k: number;
  results: FixtureResult[];
}

// ──────────────────────────────────────────────────────────────────────────
// Fixture loading
// ──────────────────────────────────────────────────────────────────────────

export function loadFixtures(dir: string = FIXTURES_DIR): RecallFixture[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`Fixtures dir not found: ${dir}`);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const out: RecallFixture[] = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
    const parsed = JSON.parse(raw) as RecallFixture;
    if (!parsed.id) parsed.id = f.replace(/\.json$/, '');
    out.push(parsed);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Metrics
// ──────────────────────────────────────────────────────────────────────────

/**
 * Match accounting for a fixture. We treat each `expected_id` as relevant
 * exactly once. A retrieved id is a hit when any expected id is a substring
 * of it (case-insensitive). Substring matching keeps fixtures stable when
 * the symbol_id format evolves (e.g. an extra `#class` suffix).
 *
 * Returns the unique expected ids satisfied (used by recall) and the
 * number of distinct retrieved top-k positions that satisfied at least one
 * expected id (used by precision). The two counts diverge when one
 * retrieved item satisfies several expected substrings, or when the same
 * expected substring is satisfied by several retrieved items — both are
 * legitimate cases the metrics must handle.
 */
interface MatchAccounting {
  matchedExpected: string[];
  /** Distinct retrieved positions in top-k that matched at least one expected. */
  hitRetrievedCount: number;
}

function computeMatches(retrieved: string[], expected: string[], k: number): MatchAccounting {
  const lowerRetrieved = retrieved.slice(0, k).map((r) => r.toLowerCase());
  const matchedExpected = new Set<string>();
  const hitRetrievedIdx = new Set<number>();
  for (const exp of expected) {
    const needle = exp.toLowerCase();
    for (let i = 0; i < lowerRetrieved.length; i += 1) {
      if (lowerRetrieved[i].includes(needle)) {
        matchedExpected.add(exp);
        hitRetrievedIdx.add(i);
      }
    }
  }
  return {
    matchedExpected: [...matchedExpected],
    hitRetrievedCount: hitRetrievedIdx.size,
  };
}

function recallAtK(matchedExpected: string[], expected: string[]): number {
  if (expected.length === 0) return 1;
  return matchedExpected.length / expected.length;
}

function precisionAtK(hitRetrievedCount: number, retrieved: string[], k: number): number {
  const window = Math.min(k, retrieved.length);
  if (window === 0) return 0;
  return hitRetrievedCount / window;
}

// ──────────────────────────────────────────────────────────────────────────
// Retrieval drivers
// ──────────────────────────────────────────────────────────────────────────

interface RetrievalContext {
  store: Store;
  pluginRegistry: PluginRegistry;
  projectRoot: string;
}

async function runSymbolFixture(
  ctx: RetrievalContext,
  fixture: RecallFixture,
  k: number,
): Promise<string[]> {
  const result = await search(ctx.store, fixture.query, undefined, Math.max(k, 10));
  return result.items.map((it) => it.symbol.symbol_id ?? it.symbol.fqn ?? it.symbol.name ?? '');
}

/**
 * For file-kind fixtures we drive the same code path that
 * `gatherContext` → `packContext` uses to pick which files end up in the
 * LLM context envelope. We extract the file paths packContext actually
 * included by parsing `### <path>` headers from its markdown output.
 */
function runFileFixture(ctx: RetrievalContext, fixture: RecallFixture, k: number): string[] {
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
  // packContext writes `### <path>` headers for each file it included
  // (in both the Outlines and Source Code sections). Dedupe while
  // preserving first-seen order so we get a stable ranked list.
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
  return ordered.slice(0, k);
}

function runDecisionFixture(fixture: RecallFixture, k: number): string[] {
  // Use a temp on-disk DB — DecisionStore expects a file path and runs
  // schema migrations + restrictDbPerms which require a real file.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-recall-decision-'));
  const dbPath = path.join(tmpRoot, 'decisions.db');
  const store = new DecisionStore(dbPath);
  try {
    const projectRoot = '/__recall_harness__';
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
    const decisions = store.queryDecisions({
      project_root: projectRoot,
      search: fixture.decision_filters?.search ?? fixture.query,
      tag: fixture.decision_filters?.tag,
      type: fixture.decision_filters?.type,
      limit: Math.max(k, 20),
    });
    // Use titles as ids — fixtures match by title substring, which keeps
    // the corpus authorable in plain English without per-fixture id bookkeeping.
    return decisions.map((d) => d.title);
  } finally {
    store.db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Orchestration
// ──────────────────────────────────────────────────────────────────────────

interface RunOptions {
  /**
   * Project root to point retrieval at. Defaults to the trace-mcp root we
   * detect from `process.cwd()` (so the harness exercises the project's
   * own index by default).
   */
  projectRoot?: string;
  /** Override the index DB path (otherwise resolved via the registry). */
  dbPath?: string;
  /** Limit the run to a subset of fixtures by id. */
  filterIds?: string[];
}

/**
 * Run all (or filtered) fixtures and return the per-fixture results.
 * Caller decides whether to assert, write a baseline, or render a report.
 */
export async function runHarness(opts: RunOptions = {}): Promise<HarnessReport> {
  const projectRoot = opts.projectRoot ?? findProjectRoot(process.cwd());
  const entry = getProject(projectRoot);
  const dbPath = opts.dbPath ?? entry?.dbPath;
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error(
      `Recall harness needs an indexed project. Run \`trace-mcp add ${projectRoot}\` first ` +
        `(no index DB at ${dbPath ?? '(unknown)'}).`,
    );
  }

  const db = initializeDatabase(dbPath);
  const store = new Store(db);
  const pluginRegistry = PluginRegistry.createWithDefaults();
  const ctx: RetrievalContext = { store, pluginRegistry, projectRoot };

  const fixtures = loadFixtures().filter((f) => !opts.filterIds || opts.filterIds.includes(f.id));

  const results: FixtureResult[] = [];
  for (const fixture of fixtures) {
    const k = fixture.k ?? DEFAULT_K;
    let retrieved: string[] = [];
    try {
      if (fixture.kind === 'symbol') retrieved = await runSymbolFixture(ctx, fixture, k);
      else if (fixture.kind === 'file') retrieved = runFileFixture(ctx, fixture, k);
      else if (fixture.kind === 'decision') retrieved = runDecisionFixture(fixture, k);
      else throw new Error(`Unknown fixture kind: ${(fixture as RecallFixture).kind}`);
    } catch (err) {
      results.push({
        fixture,
        retrieved_ids: [],
        matched_ids: [],
        recall_at_k: 0,
        precision_at_k: 0,
        k,
        passed: false,
        baseline: fixture.min_recall_at_k,
        notes: `error: ${(err as Error).message}`,
      });
      continue;
    }

    const matched = computeMatches(retrieved, fixture.expected_ids, k);
    const recall = recallAtK(matched.matchedExpected, fixture.expected_ids);
    const precision = precisionAtK(matched.hitRetrievedCount, retrieved, k);
    results.push({
      fixture,
      retrieved_ids: retrieved.slice(0, k),
      matched_ids: matched.matchedExpected,
      recall_at_k: recall,
      precision_at_k: precision,
      k,
      passed: recall >= fixture.min_recall_at_k,
      baseline: fixture.min_recall_at_k,
    });
  }

  db.close();

  const passed = results.filter((r) => r.passed).length;
  const aggregateRecall =
    results.length > 0 ? results.reduce((s, r) => s + r.recall_at_k, 0) / results.length : 0;
  const aggregatePrecision =
    results.length > 0 ? results.reduce((s, r) => s + r.precision_at_k, 0) / results.length : 0;

  return {
    generated_at: new Date().toISOString(),
    project_root: projectRoot,
    fixture_count: results.length,
    passed,
    failed: results.length - passed,
    aggregate_recall_at_k: aggregateRecall,
    aggregate_precision_at_k: aggregatePrecision,
    results,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Reporting
// ──────────────────────────────────────────────────────────────────────────

export function writeJsonReport(report: HarnessReport, file: string = REPORT_JSON): void {
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
}

export function renderMarkdownReport(report: HarnessReport): string {
  const lines: string[] = [];
  lines.push('# Recall harness report');
  lines.push('');
  lines.push(`- generated_at: \`${report.generated_at}\``);
  lines.push(`- project_root: \`${report.project_root}\``);
  lines.push(
    `- fixtures: ${report.fixture_count} (${report.passed} passed, ${report.failed} failed)`,
  );
  lines.push(`- aggregate recall@k: ${report.aggregate_recall_at_k.toFixed(3)}`);
  lines.push(`- aggregate precision@k: ${report.aggregate_precision_at_k.toFixed(3)}`);
  lines.push('');
  lines.push('| status | id | kind | k | recall | precision | baseline |');
  lines.push('|--------|----|------|---|--------|-----------|----------|');
  for (const r of report.results) {
    const status = r.passed ? 'PASS' : 'FAIL';
    lines.push(
      `| ${status} | ${r.fixture.id} | ${r.fixture.kind} | ${r.k} | ` +
        `${r.recall_at_k.toFixed(3)} | ${r.precision_at_k.toFixed(3)} | ${r.baseline.toFixed(3)} |`,
    );
  }
  lines.push('');
  const failed = report.results.filter((r) => !r.passed);
  if (failed.length > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const r of failed) {
      lines.push(`### ${r.fixture.id} (${r.fixture.kind})`);
      lines.push('');
      lines.push(`- query: \`${r.fixture.query}\``);
      lines.push(
        `- recall@${r.k}: ${r.recall_at_k.toFixed(3)} (baseline ${r.baseline.toFixed(3)})`,
      );
      lines.push(`- expected: ${r.fixture.expected_ids.map((e) => `\`${e}\``).join(', ')}`);
      lines.push(`- matched: ${r.matched_ids.map((e) => `\`${e}\``).join(', ') || '(none)'}`);
      lines.push(
        `- top-${r.k} retrieved: ${
          r.retrieved_ids
            .slice(0, r.k)
            .map((e) => `\`${e}\``)
            .join(', ') || '(empty)'
        }`,
      );
      if (r.notes) lines.push(`- notes: ${r.notes}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

export function writeMarkdownReport(report: HarnessReport, file: string = REPORT_MD): void {
  fs.writeFileSync(file, `${renderMarkdownReport(report)}\n`);
}

/**
 * Overwrite each fixture's `min_recall_at_k` and `expected_ids` with
 * the values from today's run. Used by the `--update` / RECALL_UPDATE=1
 * mode to bake in an intentional ranker improvement.
 */
export function updateBaselines(report: HarnessReport, dir: string = FIXTURES_DIR): void {
  for (const r of report.results) {
    const file = path.join(dir, `${r.fixture.id}.json`);
    if (!fs.existsSync(file)) continue;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as RecallFixture;
    // Round to 3 decimals so the baseline file stays diff-friendly across runs
    // where floating-point recall jitters in the 4th place.
    raw.min_recall_at_k = Number(r.recall_at_k.toFixed(3));
    // We deliberately do NOT touch `expected_ids`. Substring matching makes
    // those values author-intent — they encode "what we want to see surface"
    // and should be edited by hand, not auto-replaced from today's results.
    fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CLI entry point — used by `pnpm run test:recall:report`.
// ──────────────────────────────────────────────────────────────────────────

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const update = process.env.RECALL_UPDATE === '1' || process.argv.includes('--update');
  runHarness()
    .then((report) => {
      writeJsonReport(report);
      writeMarkdownReport(report);
      if (update) updateBaselines(report);
      // Console summary
      process.stdout.write(`\nRecall harness — ${report.fixture_count} fixtures\n`);
      for (const r of report.results) {
        const icon = r.passed ? 'PASS' : 'FAIL';
        process.stdout.write(
          `  [${icon}] ${r.fixture.id.padEnd(40)} recall=${r.recall_at_k.toFixed(3)} ` +
            `precision=${r.precision_at_k.toFixed(3)} (baseline=${r.baseline.toFixed(3)})\n`,
        );
      }
      process.stdout.write(
        `\naggregate recall@k=${report.aggregate_recall_at_k.toFixed(3)} ` +
          `precision@k=${report.aggregate_precision_at_k.toFixed(3)}\n`,
      );
      process.stdout.write(`reports: ${REPORT_JSON}, ${REPORT_MD}\n`);
      process.exit(report.failed > 0 && !update ? 1 : 0);
    })
    .catch((err) => {
      process.stderr.write(`Recall harness failed: ${(err as Error).stack ?? err}\n`);
      process.exit(2);
    });
}
