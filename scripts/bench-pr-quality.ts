#!/usr/bin/env tsx
/**
 * TRA-568 — the quality half of the PR-context benchmark. TRA-534 measured how
 * many tokens the trace-mcp arm saves; this measures whether a review written
 * from that thinner context is still worth reading.
 *
 * Both arms' prompts are produced by bench-pr-context.ts --dump-prompts, so the
 * texts scored here are byte-for-byte the texts that were token-counted there.
 * Each prompt goes to the same model at the same settings; the two resulting
 * reviews are then handed to a judge, blind and in randomised order, together
 * with the PR's own diff as ground truth.
 *
 * Usage:
 *   tsx scripts/bench-pr-context.ts --dump-prompts benchmarks/pr-context/prompts
 *   tsx scripts/bench-pr-quality.ts [--limit N] [--concurrency N]
 *
 * Outputs: benchmarks/pr-context/quality.json
 *
 * ponytail: the model is reached through the `claude` CLI in headless mode
 * rather than the HTTP API, because this runtime has no ANTHROPIC_API_KEY. Known
 * ceiling: the CLI ships ~18.5k tokens of tool definitions in its system prompt
 * that the API arm would not. It is a constant, identical in both arms and in
 * the judge, and no tool is callable (--allowed-tools ""), but it means the
 * absolute token/cost figures here are the CLI's, not the benchmark's — read
 * results.json for those. Swap `askModel` for an SDK call if a key appears.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const BENCH_DIR = path.join(ROOT, 'benchmarks/pr-context');
const PROMPTS_DIR = path.join(BENCH_DIR, 'prompts');
const OUT_PATH = path.join(BENCH_DIR, 'quality.json');
const DOCS_DATA_PATH = path.join(ROOT, 'docs/_data/pr_context_quality.json');
/** Scratch cwd for the CLI so it never picks up this repo's settings or index. */
const SANDBOX = path.join(ROOT, 'node_modules/.cache/pr-quality-sandbox');

const MODEL = 'claude-sonnet-4-5';
const JUDGE_MODEL = 'claude-sonnet-4-5';
const REVIEWER_SYSTEM = 'You are a senior code reviewer. Answer only with the review.';
const JUDGE_SYSTEM = 'You are an impartial evaluator. Answer only with the requested JSON.';

interface Meta {
  repo: string;
  number: number;
  url: string;
  title: string;
  diff: string;
}

interface Answer {
  text: string;
  api_ms: number;
  output_tokens: number;
}

interface Judgement {
  /** Did the review name the defect this PR fixes? */
  understood: boolean;
  /** Findings that are not real problems in the code shown. */
  false_positives: number;
  /** Total findings claimed. */
  findings: number;
  note: string;
}

interface Row {
  repo: string;
  number: number;
  url: string;
  baseline: Answer & Judgement;
  trace: Answer & Judgement;
}

/**
 * One headless model call. Settings are pinned identically for every call:
 * default temperature, no tools, no MCP, no project or user settings, no
 * dynamic system-prompt sections. Only the system prompt and the user text vary.
 */
async function askModel(system: string, prompt: string, model: string): Promise<Answer> {
  const args = [
    '-p',
    '--model',
    model,
    '--output-format',
    'json',
    '--system-prompt',
    system,
    '--exclude-dynamic-system-prompt-sections',
    '--allowed-tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--setting-sources',
    '',
    '--no-session-persistence',
  ];
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: SANDBOX,
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 600_000);
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      err += c;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude exited ${code}: ${err.slice(-500)}`));
    });
    child.stdin.end(prompt);
  });
  const d = JSON.parse(stdout) as {
    is_error?: boolean;
    result: string;
    duration_api_ms: number;
    usage?: { output_tokens?: number };
  };
  if (d.is_error) throw new Error(`model error: ${String(d.result).slice(0, 300)}`);
  return {
    text: d.result,
    api_ms: d.duration_api_ms,
    output_tokens: d.usage?.output_tokens ?? 0,
  };
}

const JUDGE_TEMPLATE = (
  meta: Meta,
  a: string,
  b: string,
) => `A merged pull request from ${meta.repo} is shown below. It is a bug-fix PR, so the
defect it fixes is visible in the diff itself — that defect is the ground truth.

## PR title
${meta.title}

## Diff
\`\`\`diff
${meta.diff}
\`\`\`

Two reviews of this change were written independently, by reviewers given
different amounts of surrounding context. Judge each one on its own merits.

## Review A
${a}

## Review B
${b}

For each review answer:
- understood: true if the review names the defect the diff fixes, or correctly
  describes what the change does and why, in a way that shows it grasped the
  problem being solved. false if it missed or misstated it.
- findings: how many distinct problems the review claims about the code.
- false_positives: how many of those claims are wrong about the code shown —
  a bug that is not there, a call site that does not exist, an already-handled
  edge case. Stylistic nitpicks and speculative "consider..." suggestions are
  not false positives; confident incorrect assertions are.
- note: one short sentence.

Reply with only this JSON, no prose, no fences:
{"A":{"understood":bool,"findings":int,"false_positives":int,"note":str},
 "B":{"understood":bool,"findings":int,"false_positives":int,"note":str}}
`;

function parseJudge(text: string): { A: Judgement; B: Judgement } {
  const one = (raw: Record<string, Partial<Judgement>>, k: string): Judgement => {
    const v = raw[k];
    if (!v || typeof v.understood !== 'boolean') throw new Error(`judge missing ${k}`);
    return {
      understood: v.understood,
      findings: Number(v.findings ?? 0),
      false_positives: Number(v.false_positives ?? 0),
      note: String(v.note ?? ''),
    };
  };
  // The judge is told to answer with bare JSON and mostly does, but it also
  // wraps it in a fence, prefaces it with a sentence, or puts a stray brace in
  // the note. Try every brace-balanced candidate rather than the first one.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = !inStr;
      else if (!inStr && c === '{') depth++;
      else if (!inStr && c === '}' && --depth === 0) {
        try {
          const raw = JSON.parse(text.slice(i, j + 1)) as Record<string, Partial<Judgement>>;
          return { A: one(raw, 'A'), B: one(raw, 'B') };
        } catch {
          // Not the verdict object — keep scanning from the next brace.
        }
        break;
      }
    }
  }
  throw new Error(`judge returned no usable verdict: ${text.slice(0, 300)}`);
}

async function runOne(dir: string): Promise<Row> {
  // A full run is ~180 model calls over ~1.5 h; a rate limit or a dropped
  // connection in the middle must not cost the rows already paid for.
  const cachePath = path.join(dir, 'judged.json');
  if (fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Row;

  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8')) as Meta;
  const baselinePrompt = fs.readFileSync(path.join(dir, 'baseline.txt'), 'utf-8');
  const tracePrompt = fs.readFileSync(path.join(dir, 'trace.txt'), 'utf-8');

  const [baseline, trace] = await Promise.all([
    askModel(REVIEWER_SYSTEM, baselinePrompt, MODEL),
    askModel(REVIEWER_SYSTEM, tracePrompt, MODEL),
  ]);

  // Blind and order-randomised: the judge must not learn which arm is which,
  // and a fixed order would let position bias ride along with the result.
  const baselineIsA = Math.random() < 0.5;
  const judged = parseJudge(
    (
      await askModel(
        JUDGE_SYSTEM,
        JUDGE_TEMPLATE(
          meta,
          baselineIsA ? baseline.text : trace.text,
          baselineIsA ? trace.text : baseline.text,
        ),
        JUDGE_MODEL,
      )
    ).text,
  );

  const row: Row = {
    repo: meta.repo,
    number: meta.number,
    url: meta.url,
    baseline: { ...baseline, ...(baselineIsA ? judged.A : judged.B) },
    trace: { ...trace, ...(baselineIsA ? judged.B : judged.A) },
  };
  fs.writeFileSync(cachePath, `${JSON.stringify(row, null, 2)}\n`);
  return row;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function summarise(rows: Row[], arm: 'baseline' | 'trace') {
  const a = rows.map((r) => r[arm]);
  return {
    understood_rate: mean(a.map((x) => (x.understood ? 1 : 0))),
    false_positives_per_pr: mean(a.map((x) => x.false_positives)),
    findings_per_pr: mean(a.map((x) => x.findings)),
    median_api_ms: median(a.map((x) => x.api_ms)),
    median_output_tokens: median(a.map((x) => x.output_tokens)),
  };
}

async function main(limit?: number, concurrency = 3): Promise<void> {
  fs.mkdirSync(SANDBOX, { recursive: true });
  const dirs = fs
    .readdirSync(PROMPTS_DIR)
    .map((d) => path.join(PROMPTS_DIR, d))
    .filter((d) => fs.existsSync(path.join(d, 'meta.json')))
    .sort();
  const todo = limit ? dirs.slice(0, limit) : dirs;

  const rows: Row[] = [];
  const failed: Array<{ dir: string; error: string }> = [];
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
      while (next < todo.length) {
        const dir = todo[next++];
        try {
          rows.push(await runOne(dir));
        } catch (e) {
          failed.push({ dir: path.basename(dir), error: String(e).slice(0, 300) });
        }
        process.stderr.write(`[${++done}/${todo.length}] ${path.basename(dir)}\n`);
      }
    }),
  );
  rows.sort((x, y) => `${x.repo}#${x.number}`.localeCompare(`${y.repo}#${y.number}`));

  const out = {
    generated_at: new Date().toISOString(),
    model: MODEL,
    judge_model: JUDGE_MODEL,
    transport: 'claude CLI headless (-p), no tools, no MCP, no settings sources',
    pr_count: rows.length,
    failed,
    aggregates: {
      baseline: summarise(rows, 'baseline'),
      trace: summarise(rows, 'trace'),
      both_understood: rows.filter((r) => r.baseline.understood && r.trace.understood).length,
      baseline_only: rows.filter((r) => r.baseline.understood && !r.trace.understood).length,
      trace_only: rows.filter((r) => !r.baseline.understood && r.trace.understood).length,
      neither: rows.filter((r) => !r.baseline.understood && !r.trace.understood).length,
    },
    rows,
  };
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`);

  // Same discipline as pr_context_bench.json: the docs page renders these and
  // never hand-types a number. Preformatted so Liquid does no arithmetic.
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const b = out.aggregates.baseline;
  const t = out.aggregates.trace;
  fs.writeFileSync(
    DOCS_DATA_PATH,
    `${JSON.stringify(
      {
        generated_at: out.generated_at,
        model: MODEL,
        judge_model: JUDGE_MODEL,
        transport: out.transport,
        pr_count: out.pr_count,
        failed_count: failed.length,
        baseline_understood: pct(b.understood_rate),
        trace_understood: pct(t.understood_rate),
        understood_delta_pp: ((t.understood_rate - b.understood_rate) * 100).toFixed(0),
        baseline_false_positives: b.false_positives_per_pr.toFixed(2),
        trace_false_positives: t.false_positives_per_pr.toFixed(2),
        baseline_findings: b.findings_per_pr.toFixed(1),
        trace_findings: t.findings_per_pr.toFixed(1),
        baseline_median_latency_s: (b.median_api_ms / 1000).toFixed(1),
        trace_median_latency_s: (t.median_api_ms / 1000).toFixed(1),
        baseline_median_output_tokens: Math.round(b.median_output_tokens),
        trace_median_output_tokens: Math.round(t.median_output_tokens),
        both_understood: out.aggregates.both_understood,
        baseline_only: out.aggregates.baseline_only,
        trace_only: out.aggregates.trace_only,
        neither: out.aggregates.neither,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n${rows.length} PRs judged, ${failed.length} failed → ${OUT_PATH}`);
  console.log(JSON.stringify(out.aggregates, null, 2));
}

export { parseJudge, median, summarise, type Row };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const num = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? Number(argv[i + 1]) : undefined;
  };
  await main(num('--limit'), num('--concurrency') ?? 3);
}
