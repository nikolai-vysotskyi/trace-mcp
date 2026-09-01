#!/usr/bin/env node
/**
 * TRA-613: what does renaming the MCP server key `trace-mcp` → `trace` actually
 * save, in tokens, per session?
 *
 * Two independent effects, measured separately because they behave differently:
 *
 *   1. Tool-name prefix. Clients namespace MCP tools as `mcp__<serverKey>__<tool>`,
 *      so every advertised tool carries the key once in `tools/list`. Measured
 *      against the REAL `tools/list` payload of the built server (one spawn per
 *      preset), not a hand-written list.
 *   2. Prose mentions. The string `trace-mcp` in the `initialize` instructions
 *      block and in the generated CLAUDE.md / AGENTS.md routing block, both of
 *      which are re-sent every session.
 *
 * Run after `pnpm run build`:
 *
 *   node scripts/bench-name-tokens.mjs            # GPT tokenizers only
 *   npm i -D @anthropic-ai/tokenizer @lenml/tokenizer-gemini  # adds Claude + Gemini
 *
 * The two extra tokenizers are optional on purpose: they are multi-MB vocab
 * downloads and this is a one-off migration benchmark, not a CI guard. The
 * committed numbers live in benchmarks/name-token-savings.md.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const PRESETS = ['minimal', 'standard', 'full'];
const OLD = 'trace-mcp';
const NEW = 'trace';

// ---------------------------------------------------------------- tokenizers

/** @type {Array<{ name: string, count: (s: string) => number }>} */
const tokenizers = [];

{
  const o200k = await import('gpt-tokenizer/encoding/o200k_base');
  tokenizers.push({ name: 'GPT-4o (o200k_base)', count: (s) => o200k.encode(s).length });
  const cl100k = await import('gpt-tokenizer/encoding/cl100k_base');
  tokenizers.push({ name: 'GPT-4 (cl100k_base)', count: (s) => cl100k.encode(s).length });
}
try {
  const ant = await import('@anthropic-ai/tokenizer');
  tokenizers.push({ name: 'Claude (anthropic-ai/tokenizer)', count: (s) => ant.countTokens(s) });
} catch {
  console.error('note: @anthropic-ai/tokenizer not installed — skipping Claude column');
}
try {
  const gem = await import('@lenml/tokenizer-gemini');
  const tok = gem.fromPreTrained();
  tokenizers.push({
    name: 'Gemini',
    count: (s) => tok.encode(s, { add_special_tokens: false }).length,
  });
} catch {
  console.error('note: @lenml/tokenizer-gemini not installed — skipping Gemini column');
}

/** Migration rewrite of any text: the server key and every path derived from it. */
const migrate = (s) => s.split(OLD).join(NEW).split('TRACE_MCP_').join('TRACE_');

// ------------------------------------------------------- real tools/list dump

/** Drives the built server through initialize + tools/list for one preset. */
function toolsList(preset) {
  return new Promise((resolve, reject) => {
    const root = mkdtempSync(join(tmpdir(), `bench-tools-${preset}-`));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    // client_profile off: the profile layer hides tools a specific host already
    // covers, which would make the count depend on who is asking.
    writeFileSync(
      join(root, '.trace-mcp.json'),
      JSON.stringify({ tools: { preset, client_profile: 'off' } }),
    );

    const server = spawn('node', [join(REPO, 'dist/cli.js'), 'serve'], {
      cwd: root,
      env: { ...process.env, TRACE_MCP_NO_DAEMON: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const send = (m) => server.stdin.write(`${JSON.stringify(m)}\n`);
    const timer = setTimeout(() => {
      server.kill();
      reject(new Error(`timed out on preset ${preset}`));
    }, 180_000);

    let buf = '';
    let init;
    server.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // server logs interleave on stdout
        }
        if (msg.id === 1) {
          init = msg.result;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        }
        if (msg.id === 2) {
          clearTimeout(timer);
          server.kill();
          resolve({ tools: msg.result.tools, instructions: init?.instructions ?? '' });
        }
      }
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bench-name-tokens', version: '0' },
      },
    });
  });
}

// ------------------------------------------------------------------ measuring

const md = [];

// The claim under test, in isolation: how many tokens is the name itself?
md.push('## The string, in isolation\n');
md.push(`| text | ${tokenizers.map((t) => t.name).join(' | ')} |`);
md.push(`|---|${tokenizers.map(() => '---:').join('|')}|`);
for (const s of [
  'trace-mcp',
  'trace',
  'mcp__trace-mcp__',
  'mcp__trace__',
  '`trace-mcp`',
  '`trace`',
  '.trace-mcp.json',
  '.trace.json',
]) {
  md.push(`| \`${s}\` | ${tokenizers.map((t) => t.count(s)).join(' | ')} |`);
}

md.push('\n## Tool-name prefix (`mcp__trace-mcp__x` → `mcp__trace__x`)\n');
md.push(`| preset | tools | tokenizer | before | after | saved | % of names |`);
md.push('|---|---:|---|---:|---:|---:|---:|');

const surfaces = [];
let instructions = '';
for (const preset of PRESETS) {
  const { tools, instructions: instr } = await toolsList(preset);
  surfaces.push({ preset, tools });
  if (preset === 'full') instructions = instr;
  const oldNames = tools.map((t) => `mcp__${OLD}__${t.name}`).join('\n');
  const newNames = tools.map((t) => `mcp__${NEW}__${t.name}`).join('\n');
  for (const tk of tokenizers) {
    const before = tk.count(oldNames);
    const after = tk.count(newNames);
    md.push(
      `| ${preset} | ${tools.length} | ${tk.name} | ${before} | ${after} | ${before - after} | ${(((before - after) / before) * 100).toFixed(1)}% |`,
    );
  }
}

// Whole advertised surface, as the client receives it — the denominator that
// says whether the prefix saving is a rounding error or a real cut. Includes
// the `trace-mcp` mentions inside descriptions, which the names table misses.
md.push('\n## Whole advertised tool surface (`tools/list`, names + descriptions + schemas)\n');
md.push('| preset | tokenizer | before | after | saved | % |');
md.push('|---|---|---:|---:|---:|---:|');
const serialize = (tools, key) =>
  JSON.stringify(tools.map((t) => ({ ...t, name: `mcp__${key}__${t.name}` })));
/** Per-session saving on the tool surface alone, keyed `preset|tokenizer`. */
const perSession = new Map();
for (const { preset, tools } of surfaces) {
  for (const tk of tokenizers) {
    const before = tk.count(serialize(tools, OLD));
    const after = tk.count(migrate(serialize(tools, NEW)));
    perSession.set(`${preset}|${tk.name}`, before - after);
    md.push(
      `| ${preset} | ${tk.name} | ${before} | ${after} | ${before - after} | ${(((before - after) / before) * 100).toFixed(2)}% |`,
    );
  }
}

// Prose corpora: everything re-sent on every session that names the server.
const corpora = [
  ['initialize instructions (verbosity=full)', instructions],
  [
    'CLAUDE.md / AGENTS.md routing block',
    readFileSync(join(REPO, 'src/init/md-block.ts'), 'utf8')
      .split('export const TRACE_MCP_ROUTING_BLOCK = `')[1]
      ?.split('\n`;')[0] ?? '',
  ],
  ['repo CLAUDE.md', readFileSync(join(REPO, 'CLAUDE.md'), 'utf8')],
  ['repo AGENTS.md', readFileSync(join(REPO, 'AGENTS.md'), 'utf8')],
];

md.push('\n## Prose mentions (`trace-mcp` → `trace`)\n');
md.push('| corpus | mentions | tokenizer | before | after | saved | % |');
md.push('|---|---:|---|---:|---:|---:|---:|');
/** Per-session saving on prose the client resends every turn. */
const perSessionProse = new Map();
for (const [name, text] of corpora) {
  const mentions = (text.match(/trace-mcp/g) ?? []).length;
  for (const tk of tokenizers) {
    const before = tk.count(text);
    const after = tk.count(migrate(text));
    perSessionProse.set(`${name}|${tk.name}`, before - after);
    md.push(
      `| ${name} | ${mentions} | ${tk.name} | ${before} | ${after} | ${before - after} | ${(((before - after) / before) * 100).toFixed(2)}% |`,
    );
  }
}

// The tool surface and the routing block both live in the system prompt, so a
// client re-bills them (as a cache read, if caching is on) on every turn.
md.push('\n## Input tokens saved over a session (tool surface + CLAUDE.md routing block)\n');
md.push('| preset | tokenizer | per turn | 10 turns | 30 turns | 50 turns |');
md.push('|---|---|---:|---:|---:|---:|');
for (const { preset } of surfaces) {
  for (const tk of tokenizers) {
    const perTurn =
      (perSession.get(`${preset}|${tk.name}`) ?? 0) +
      (perSessionProse.get(`CLAUDE.md / AGENTS.md routing block|${tk.name}`) ?? 0);
    md.push(
      `| ${preset} | ${tk.name} | ${perTurn} | ${perTurn * 10} | ${perTurn * 30} | ${perTurn * 50} |`,
    );
  }
}

console.log(md.join('\n'));
