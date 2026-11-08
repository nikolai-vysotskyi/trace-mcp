#!/usr/bin/env tsx
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
 *      block and in the CLAUDE.md / AGENTS.md routing block, both of which are
 *      re-sent every session. The routing block is imported from the module the
 *      generators write, not scraped out of its source text.
 *
 * Run after `pnpm run build`:
 *
 *   npx tsx scripts/bench-name-tokens.ts                       # GPT tokenizers only
 *   npm i -D @anthropic-ai/tokenizer @lenml/tokenizer-gemini   # adds Claude + Gemini
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
import { TRACE_MCP_ROUTING_BLOCK } from '../src/init/md-block.js';
import { buildInstructions } from '../src/server/instructions.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const PRESETS = ['minimal', 'standard', 'full'] as const;
const OLD = 'trace-mcp';
const NEW = 'trace';

// ---------------------------------------------------------------- tokenizers

interface Tokenizer {
  name: string;
  count: (s: string) => number;
}
const tokenizers: Tokenizer[] = [];

// Indirect specifier: these two are optional dev installs, so the module must
// not be resolved at type-check time.
const optionalImport = (spec: string): Promise<Record<string, unknown>> => import(spec);

{
  const o200k = await import('gpt-tokenizer/encoding/o200k_base');
  tokenizers.push({ name: 'GPT-4o (o200k_base)', count: (s) => o200k.encode(s).length });
  const cl100k = await import('gpt-tokenizer/encoding/cl100k_base');
  tokenizers.push({ name: 'GPT-4 (cl100k_base)', count: (s) => cl100k.encode(s).length });
}
try {
  const ant = await optionalImport('@anthropic-ai/tokenizer');
  const countTokens = ant.countTokens as (s: string) => number;
  tokenizers.push({ name: 'Claude (anthropic-ai/tokenizer)', count: countTokens });
} catch {
  console.error('note: @anthropic-ai/tokenizer not installed — skipping Claude column');
}
try {
  const gem = await optionalImport('@lenml/tokenizer-gemini');
  const tok = (gem.fromPreTrained as () => { encode: (s: string, o: object) => number[] })();
  tokenizers.push({
    name: 'Gemini',
    count: (s) => tok.encode(s, { add_special_tokens: false }).length,
  });
} catch {
  console.error('note: @lenml/tokenizer-gemini not installed — skipping Gemini column');
}

/**
 * The migration rewrite, as TRA-611 scopes it: the server key and the config
 * paths derived from it. Deliberately NOT `TRACE_MCP_*` → `TRACE_*` — TRA-611
 * keeps the legacy env vars, so renaming them here would measure a migration
 * that is not going to ship.
 */
const migrate = (s: string): string => s.split(OLD).join(NEW);

// ------------------------------------------------------- real tools/list dump

interface ToolsListResult {
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  instructions: string;
}

/** Drives the built server through initialize + tools/list for one preset. */
function toolsList(preset: string): Promise<ToolsListResult> {
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
    const send = (m: unknown): void => {
      server.stdin.write(`${JSON.stringify(m)}\n`);
    };
    const timer = setTimeout(() => {
      server.kill();
      reject(new Error(`timed out on preset ${preset}`));
    }, 180_000);

    let buf = '';
    let init: { instructions?: string } | undefined;
    server.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: { id?: number; result?: Record<string, unknown> };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // server logs interleave on stdout
        }
        if (msg.id === 1) {
          init = msg.result as { instructions?: string };
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        }
        if (msg.id === 2) {
          clearTimeout(timer);
          server.kill();
          resolve({
            tools: (msg.result?.tools ?? []) as ToolsListResult['tools'],
            instructions: init?.instructions ?? '',
          });
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

const md: string[] = [];
const pct = (before: number, after: number, digits = 2): string =>
  `${(((before - after) / before) * 100).toFixed(digits)}%`;

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
md.push('| preset | tools | tokenizer | before | after | saved | % of names |');
md.push('|---|---:|---|---:|---:|---:|---:|');

const surfaces: Array<{ preset: string; tools: ToolsListResult['tools'] }> = [];
for (const preset of PRESETS) {
  const { tools } = await toolsList(preset);
  surfaces.push({ preset, tools });
  const oldNames = tools.map((t) => `mcp__${OLD}__${t.name}`).join('\n');
  const newNames = tools.map((t) => `mcp__${NEW}__${t.name}`).join('\n');
  for (const tk of tokenizers) {
    const before = tk.count(oldNames);
    const after = tk.count(newNames);
    md.push(
      `| ${preset} | ${tools.length} | ${tk.name} | ${before} | ${after} | ${before - after} | ${pct(before, after, 1)} |`,
    );
  }
}

// The whole advertised surface. `JSON.stringify` is a reproducible proxy for
// how a client renders tool definitions to the model, not the exact provider
// wire format — good enough to say whether the prefix saving is a rounding
// error or a real cut, not to quote as an exact prompt size.
md.push('\n## Whole advertised tool surface (`tools/list`, names + descriptions + schemas)\n');
md.push('| preset | tokenizer | before | after | saved | % |');
md.push('|---|---|---:|---:|---:|---:|');
const serialize = (tools: ToolsListResult['tools'], key: string): string =>
  JSON.stringify(tools.map((t) => ({ ...t, name: `mcp__${key}__${t.name}` })));
/** Per-session saving on the tool surface alone, keyed `preset|tokenizer`. */
const perSession = new Map<string, number>();
for (const { preset, tools } of surfaces) {
  for (const tk of tokenizers) {
    const before = tk.count(serialize(tools, OLD));
    const after = tk.count(migrate(serialize(tools, NEW)));
    perSession.set(`${preset}|${tk.name}`, before - after);
    md.push(
      `| ${preset} | ${tk.name} | ${before} | ${after} | ${before - after} | ${pct(before, after)} |`,
    );
  }
}

// Prose corpora: everything re-sent on every session that names the server.
// The routing block is the exported constant the generators write into
// CLAUDE.md / AGENTS.md — not a substring scraped out of md-block.ts.
const ROUTING_BLOCK = 'CLAUDE.md / AGENTS.md routing block';
const corpora: Array<[string, string]> = [
  ['initialize instructions (verbosity=full)', buildInstructions('none', 'full')],
  [ROUTING_BLOCK, TRACE_MCP_ROUTING_BLOCK],
  ['repo CLAUDE.md', readFileSync(join(REPO, 'CLAUDE.md'), 'utf8')],
  ['repo AGENTS.md', readFileSync(join(REPO, 'AGENTS.md'), 'utf8')],
];

md.push('\n## Prose mentions (`trace-mcp` → `trace`)\n');
md.push('| corpus | mentions | tokenizer | before | after | saved | % |');
md.push('|---|---:|---|---:|---:|---:|---:|');
/** Per-session saving on prose the client resends every turn. */
const perSessionProse = new Map<string, number>();
for (const [name, text] of corpora) {
  const mentions = (text.match(/trace-mcp/g) ?? []).length;
  for (const tk of tokenizers) {
    const before = tk.count(text);
    const after = tk.count(migrate(text));
    perSessionProse.set(`${name}|${tk.name}`, before - after);
    md.push(
      `| ${name} | ${mentions} | ${tk.name} | ${before} | ${after} | ${before - after} | ${pct(before, after)} |`,
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
      (perSessionProse.get(`${ROUTING_BLOCK}|${tk.name}`) ?? 0);
    md.push(
      `| ${preset} | ${tk.name} | ${perTurn} | ${perTurn * 10} | ${perTurn * 30} | ${perTurn * 50} |`,
    );
  }
}

console.log(md.join('\n'));
