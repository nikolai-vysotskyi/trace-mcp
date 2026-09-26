#!/usr/bin/env node
/**
 * GEO-battery: 20 fixed prompts x 4 models, weekly AI-visibility tracker.
 *
 * Measures whether trace-mcp shows up in AI answers (ChatGPT, Claude, Gemini,
 * Perplexity via the DataForSEO AI Optimization `llm_responses/live` endpoints,
 * US/English, web_search on) — the GEO counterpart of a rank tracker.
 *
 * Modes:
 *   node scripts/geo-battery.mjs prompts
 *     Print the frozen runbook: procedure + all 20 prompts verbatim.
 *     No network, no cost. Use for manual runs.
 *
 *   node scripts/geo-battery.mjs run [--date YYYY-MM-DD] [--fresh] [--yes]
 *     Live run via DataForSEO. Needs DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD.
 *     Results append to ops/geo-ranks-history/<date>.json; entries already
 *     present for (prompt, model) are reused unless --fresh. Without --yes the
 *     script only prints the cost estimate and exits — paid calls never happen
 *     by accident. ~80 live calls, a few dollars; concurrency capped at 3 with
 *     a delay between calls so we do not hammer the API.
 *
 *   node scripts/geo-battery.mjs score --in responses.json
 *     Deterministic offline scoring of a hand-collected file. Input is an array
 *     of {prompt_id, platform, model, text, annotations:[{title,url}]} —
 *     exactly the entry shape `run` stores. Prints scored JSON to stdout.
 *     Same input always yields the same output (guarded by tests).
 *
 *   node scripts/geo-battery.mjs report [--history ops/geo-ranks-history]
 *     Markdown table date x prompt x model x position + share summary, to
 *     stdout. Paste the new rows into ops/geo-ranks.md after each run.
 *
 * Metric definitions (see ops/geo-ranks.md for the rationale):
 *   mentioned — "trace-mcp"/"trace mcp"/trace-mcp.com appears in the answer
 *     prose or in a cited source (annotations).
 *   cited     — a trace-mcp.com URL is among the answer's cited sources.
 *   position  — 1-based number of the list item naming trace-mcp when the
 *     answer enumerates tools; null when mentioned in prose outside a list
 *     or not mentioned at all.
 *   top10     — position !== null && position <= 10.
 *   top50     — mentioned at all (AI answers almost never enumerate 50 tools,
 *     so any mention counts; the column exists to keep the contract stable
 *     if answers get longer).
 *   share_top10 = top10 runs / total runs; share_top50 = mentioned / total.
 *
 * Single source of truth for the prompt list lives here. ops/geo-ranks.md
 * repeats the prompts for humans; tests/docs/geo-battery.test.ts asserts the
 * file contains every prompt verbatim so the two cannot drift apart.
 * (TRA-1947)
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PROMPTS = [
  { id: 'P01', text: 'What is the best MCP server for code graph navigation?' },
  { id: 'P02', text: 'Which MCP server is best for code intelligence in AI coding agents?' },
  { id: 'P03', text: 'What is the best code graph MCP server for large monorepos?' },
  { id: 'P04', text: 'What is the best tool to reduce Claude Code token usage?' },
  { id: 'P05', text: 'How can I reduce context window usage in Claude Code?' },
  { id: 'P06', text: 'What is the best MCP server for Claude Code to save tokens?' },
  { id: 'P07', text: 'What is the best MCP server for Laravel codebases?' },
  { id: 'P08', text: 'What is the best MCP server for Vue and Nuxt projects?' },
  { id: 'P09', text: 'What is the best MCP server for Django projects?' },
  { id: 'P10', text: 'What is the best MCP server for Spring and Java projects?' },
  {
    id: 'P11',
    text: 'Which MCP server understands frameworks like Laravel, Vue, Django and Spring?',
  },
  { id: 'P12', text: 'What is the best tool for impact analysis before refactoring code?' },
  { id: 'P13', text: 'Which tool shows the blast radius of a code change for AI agents?' },
  { id: 'P14', text: 'What is the best MCP server for PR review context?' },
  { id: 'P15', text: 'What tool gives AI agents dependency graph context for code review?' },
  { id: 'P16', text: 'Repomix vs Serena vs trace-mcp: which should I choose?' },
  { id: 'P17', text: 'What is the best Serena alternative for large repositories?' },
  { id: 'P18', text: 'What is the best Repomix alternative for AI coding agents?' },
  { id: 'P19', text: 'Which MCP servers should I install for Claude Code?' },
  { id: 'P20', text: 'What is the best MCP server for framework-aware code search?' },
];

/**
 * Pinned models, one per surface. Exact `model_name` values as listed by the
 * DataForSEO `.../llm_responses/models` endpoints on 2026-09-25; versioned
 * where a versioned name exists so week-to-week runs compare like with like.
 * If a pinned name stops resolving, update it here AND note the change with
 * its date in ops/geo-ranks.md — a silent model swap breaks the trend.
 */
export const MODELS = [
  {
    platform: 'chat_gpt',
    model: 'gpt-5.5',
    endpoint: 'ai_optimization/chat_gpt/llm_responses/live',
  },
  {
    platform: 'claude',
    model: 'claude-sonnet-4-5-20250929',
    endpoint: 'ai_optimization/claude/llm_responses/live',
  },
  {
    platform: 'gemini',
    model: 'gemini-2.5-pro',
    endpoint: 'ai_optimization/gemini/llm_responses/live',
  },
  {
    platform: 'perplexity',
    model: 'sonar-pro',
    endpoint: 'ai_optimization/perplexity/llm_responses/live',
  },
];

export const PROCEDURE = {
  region: 'United States',
  language: 'English (en)',
  web_search: true,
  max_output_tokens: 1024,
  frequency: 'weekly (Monday), plus on demand after major doc/positioning changes',
  history_dir: 'ops/geo-ranks-history',
};

const BRAND_RE = /trace[\s\-_]?mcp/i;
const DOMAIN_RE = /(^|\.)trace-mcp\.com$/i;

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Lines that enumerate tools: "1. Foo", "2) Bar", "- Baz", "* Qux", "• Quux". */
const LIST_ITEM_RE = /^\s*(?:\d{1,3}[.)]|[-*•])\s+\S/;

/**
 * Score one (prompt, model) answer. Pure function — no network, no dates,
 * no randomness; the same input always yields the same output.
 */
export function scoreResponse(text, annotations = []) {
  const body = String(text ?? '');
  const sources = Array.isArray(annotations) ? annotations : [];

  const mentionedInProse = BRAND_RE.test(body);
  const citedSource = sources.some(
    (a) => DOMAIN_RE.test(hostOf(a?.url ?? '')) || BRAND_RE.test(a?.title ?? ''),
  );
  const mentioned = mentionedInProse || citedSource;
  const cited = sources.some((a) => DOMAIN_RE.test(hostOf(a?.url ?? '')));

  let position = null;
  if (mentioned) {
    let itemNo = 0;
    for (const line of body.split('\n')) {
      if (!LIST_ITEM_RE.test(line)) continue;
      itemNo += 1;
      if (position === null && BRAND_RE.test(line)) position = itemNo;
    }
    // Mention sits inside a list but the item regex missed the exact line
    // (e.g. a wrapped continuation line): still a mention, no position.
  }

  return {
    mentioned,
    cited,
    position,
    top10: position !== null && position <= 10,
    top50: mentioned,
  };
}

/** Extract plain text + cited sources from a DataForSEO llm_responses result. */
export function parseLiveResult(result) {
  const texts = [];
  const annotations = [];
  for (const item of result?.items ?? []) {
    for (const section of item?.sections ?? []) {
      if (typeof section?.text === 'string' && section.text.length > 0) texts.push(section.text);
      for (const a of section?.annotations ?? []) {
        if (a && (a.url || a.direct_url)) {
          annotations.push({ title: a.title ?? '', url: a.direct_url ?? a.url });
        }
      }
    }
  }
  return { text: texts.join('\n\n'), annotations };
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function historyPath(historyDir, date) {
  return join(historyDir, `${date}.json`);
}

function loadHistory(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function printPrompts() {
  const out = [
    '# GEO-battery runbook (frozen prompt list)',
    '',
    `Region: ${PROCEDURE.region} · Language: ${PROCEDURE.language} · web_search: ${PROCEDURE.web_search} · max_output_tokens: ${PROCEDURE.max_output_tokens}`,
    'Models:',
    ...MODELS.map((m) => `  - ${m.platform} / ${m.model}`),
    '',
    'Ask each prompt exactly as written (English, no follow-ups, fresh session):',
    '',
    ...PROMPTS.flatMap((p) => [`${p.id}. ${p.text}`, '']),
    'Record per (prompt, model): full answer text + cited source URLs, then run',
    '`node scripts/geo-battery.mjs score --in responses.json` and append the',
    'history file + table rows to ops/geo-ranks.md.',
  ];
  console.log(out.join('\n'));
}

async function dataForSeoLive(model, promptText, tag, auth) {
  const res = await fetch(`https://api.dataforseo.com/v3/${model.endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([
      {
        model_name: model.model,
        user_prompt: promptText,
        web_search: true,
        web_search_country_iso_code: 'US',
        max_output_tokens: PROCEDURE.max_output_tokens,
        tag,
      },
    ]),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${model.platform}/${model.model}`);
  const json = await res.json();
  const task = json?.tasks?.[0];
  if (!task || task.status_code !== 20000) {
    throw new Error(
      `DataForSEO error for ${model.platform}/${model.model}: ${task?.status_message ?? 'unknown'} (${task?.status_code ?? '?'})`,
    );
  }
  const result = task.result?.[0];
  if (!result) throw new Error(`Empty result for ${model.platform}/${model.model}`);
  const { text, annotations } = parseLiveResult(result);
  return {
    text,
    annotations,
    tokens: { input: result.input_tokens ?? null, output: result.output_tokens ?? null },
    cost_usd: task.cost ?? null,
    measured_at: result.datetime ?? null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cmdRun(args) {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) {
    console.error('Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD in the environment.');
    console.error('No paid calls were made. Set the credentials or use `score` for manual runs.');
    process.exit(2);
  }
  const dateIdx = args.indexOf('--date');
  const date = dateIdx >= 0 && args[dateIdx + 1] ? args[dateIdx + 1] : todayISO();
  const fresh = args.includes('--fresh');
  const confirmed = args.includes('--yes');
  const totalCalls = PROMPTS.length * MODELS.length;

  const historyDir = PROCEDURE.history_dir;
  const path = historyPath(historyDir, date);
  const existing = fresh ? [] : loadHistory(path);
  const have = new Set(existing.map((e) => `${e.prompt_id} :: ${e.platform}/${e.model}`));
  const missing = [];
  for (const p of PROMPTS) {
    for (const m of MODELS) {
      if (!have.has(`${p.id} :: ${m.platform}/${m.model}`)) missing.push([p, m]);
    }
  }

  console.log(
    `GEO-battery live run for ${date}: ${missing.length} of ${totalCalls} calls missing.`,
  );
  console.log('Estimate: on the order of a few USD total (per-call cost seen on 2026-09-25:');
  console.log('chat_gpt ~$0.10, claude ~$0.05, gemini ~$0.05, perplexity ~$0.01).');
  if (missing.length === 0) {
    console.log('History file already complete — nothing to do.');
    return;
  }
  if (!confirmed) {
    console.log('Dry run only. Re-run with --yes to spend the calls.');
    return;
  }

  const auth = Buffer.from(`${login}:${password}`).toString('base64');
  const entries = [...existing];
  const failures = [];
  for (const [p, m] of missing) {
    const key = `${p.id} :: ${m.platform}/${m.model}`;
    try {
      const live = await dataForSeoLive(m, p.text, `geo-battery:${date}:${p.id}`, auth);
      entries.push({
        date,
        prompt_id: p.id,
        prompt: p.text,
        platform: m.platform,
        model: m.model,
        ...live,
        ...scoreResponse(live.text, live.annotations),
      });
      console.log(`ok   ${key}`);
    } catch (err) {
      failures.push(key);
      console.error(`FAIL ${key}: ${err.message}`);
    }
    await sleep(500);
  }

  mkdirSync(historyDir, { recursive: true });
  entries.sort((a, b) =>
    a.prompt_id === b.prompt_id
      ? a.platform.localeCompare(b.platform)
      : a.prompt_id.localeCompare(b.prompt_id),
  );
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`Wrote ${entries.length} entries to ${path}.`);

  if (failures.length > 0) {
    console.error(`${failures.length} calls failed; re-run (cached entries are reused).`);
    process.exit(1);
  }
}

function cmdScore(args) {
  const inIdx = args.indexOf('--in');
  if (inIdx < 0 || !args[inIdx + 1]) {
    console.error('Usage: node scripts/geo-battery.mjs score --in responses.json');
    process.exit(2);
  }
  const items = JSON.parse(readFileSync(args[inIdx + 1], 'utf-8'));
  const scored = items.map((e) => ({
    prompt_id: e.prompt_id,
    platform: e.platform,
    model: e.model,
    ...scoreResponse(e.text, e.annotations),
  }));
  console.log(JSON.stringify(scored, null, 2));
}

function summarize(entries) {
  const total = entries.length;
  const mentioned = entries.filter((e) => e.mentioned).length;
  const cited = entries.filter((e) => e.cited).length;
  const top10 = entries.filter((e) => e.top10).length;
  const pct = (n) => (total === 0 ? 'n/a' : `${((100 * n) / total).toFixed(1)}%`);
  return { total, mentioned, cited, top10, share_top10: pct(top10), share_top50: pct(mentioned) };
}

function cmdReport(args) {
  const dirIdx = args.indexOf('--history');
  const dir = dirIdx >= 0 && args[dirIdx + 1] ? args[dirIdx + 1] : PROCEDURE.history_dir;
  let files = [];
  try {
    files = readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
  } catch {
    console.error(`No history dir at ${dir} yet.`);
    process.exit(2);
  }
  const lines = [
    '| date | prompt | chat_gpt | claude | gemini | perplexity |',
    '|---|---|---|---|---|---|',
  ];
  const summaries = [];
  for (const f of files) {
    const date = f.slice(0, 10);
    const entries = loadHistory(join(dir, f));
    summaries.push({ date, ...summarize(entries) });
    for (const p of PROMPTS) {
      const cells = MODELS.map((m) => {
        const e = entries.find((x) => x.prompt_id === p.id && x.platform === m.platform);
        if (!e) return '·';
        if (!e.mentioned) return '—';
        if (e.position !== null && e.position !== undefined) return `✓#${e.position}`;
        return '~';
      });
      lines.push(`| ${date} | ${p.id} | ${cells.join(' | ')} |`);
    }
  }
  console.log(lines.join('\n'));
  console.log('');
  console.log('| date | runs | mentioned | cited | top10 | share_top10 | share_top50 |');
  console.log('|---|---|---|---|---|---|---|');
  for (const s of summaries) {
    console.log(
      `| ${s.date} | ${s.total} | ${s.mentioned} | ${s.cited} | ${s.top10} | ${s.share_top10} | ${s.share_top50} |`,
    );
  }
  console.log('');
  console.log(
    'Legend: ✓#n = named at list position n · ~ = mentioned in prose, no list position · — = not mentioned · · = not measured',
  );
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'prompts') printPrompts();
  else if (mode === 'run') await cmdRun(args);
  else if (mode === 'score') cmdScore(args);
  else if (mode === 'report') cmdReport(args);
  else {
    console.error('Usage: node scripts/geo-battery.mjs <prompts|run|score|report> [options]');
    process.exit(2);
  }
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) await main();
