#!/usr/bin/env tsx
/**
 * Generates docs/tools-index.md — the complete, alphabetical list of every tool
 * the MCP server registers (TRA-505).
 *
 * docs/tools-reference.md is a curated, task-shaped page: it groups the tools
 * you reach for by hand. It was never complete — 101 of the tools a default
 * install registers had no entry anywhere on it — so a reader looking up a name
 * the server does answer to found nothing and could reasonably conclude it did
 * not exist.
 *
 * Nothing here is hand-maintained. Names and one-liners are read off the
 * `server.tool('name', 'description', ...)` registrations themselves — the same
 * scan `tests/docs/tool-surface.ts` counts the advertised surface with — so the
 * page cannot drift: tests/docs/tools-index.test.ts fails CI when it does.
 *
 * A static scan rather than a live registration on purpose: 19 tools only
 * register when `topology.enabled` / `runtime.enabled` hand them a real store,
 * and standing those up is a lot of machinery for a docs page whose content is
 * a string literal three characters after the tool's own name.
 *
 * Usage: pnpm run docs:tools-index [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { frameworkGatedToolNames } from '../tests/docs/tool-surface.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER_DIR = path.join(ROOT, 'src/tools/register');
const OUT = path.join(ROOT, 'docs/tools-index.md');

/** `server.tool('name', 'description'` — the description always follows the name. */
const REGISTRATION = /(?:server\.tool|_originalTool)\(\s*['"]([a-zA-Z0-9_]+)['"]\s*,\s*(?=['"`])/g;

/**
 * `if (config.topology?.enabled ...) { ... }` — the config-gated subsystems.
 * `!== false` is the opposite: on unless you turn it off (`config.hermes`), so
 * those tools are not opt-in and the lookahead keeps them out.
 */
const CONFIG_GATE = /if \(\s*config\.(\w+)\??\.enabled(?!\s*!==\s*false)/g;

type Availability = 'always' | 'framework' | 'opt-in';

export interface ToolRow {
  name: string;
  summary: string;
  availability: Availability;
}

function registerSources(): Array<{ body: string }> {
  const out: Array<{ body: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(full);
        continue;
      }
      if (entry.name.endsWith('.ts')) out.push({ body: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(REGISTER_DIR);
  return out;
}

/**
 * Reads one JS string literal starting at `start` (a quote character), honouring
 * escapes, and swallowing adjacent literals so a description split across lines
 * with `+` comes back whole.
 */
function readStringLiteral(body: string, start: number): { value: string; end: number } {
  let i = start;
  let value = '';
  for (;;) {
    const quote = body[i];
    if (quote !== "'" && quote !== '"' && quote !== '`') break;
    i++;
    for (; i < body.length; i++) {
      const ch = body[i];
      if (ch === '\\') {
        const next = body[i + 1];
        value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
        i++;
        continue;
      }
      if (ch === quote) break;
      value += ch;
    }
    i++; // past the closing quote
    // Continue through `+` and whitespace to pick up a concatenated next chunk.
    const rest = /^\s*\+\s*/.exec(body.slice(i));
    if (!rest) break;
    i += rest[0].length;
  }
  return { value, end: i };
}

/** Byte ranges of every `if (...) { ... }` block whose head matches `head`. */
function gateRanges(body: string, head: RegExp): Array<[number, number, string]> {
  const ranges: Array<[number, number, string]> = [];
  for (const m of body.matchAll(head)) {
    const open = body.indexOf('{', m.index);
    if (open < 0) continue;
    let depth = 0;
    for (let i = open; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}' && --depth === 0) {
        ranges.push([open, i, m[1] ?? '']);
        break;
      }
    }
  }
  return ranges;
}

/** The first sentence of the description a client sees in `tools/list`. */
function summarize(description: string): string {
  const first = description.trim().split(/(?<=[.!?])\s/)[0] ?? description.trim();
  const oneLine = first.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157).trimEnd()}…` : oneLine;
}

export function buildRows(): ToolRow[] {
  const framework = frameworkGatedToolNames();
  const rows = new Map<string, ToolRow>();

  for (const { body } of registerSources()) {
    const configGates = gateRanges(body, CONFIG_GATE);
    for (const m of body.matchAll(REGISTRATION)) {
      const name = m[1];
      const { value } = readStringLiteral(body, m.index + m[0].length);
      const optIn = configGates.some(([a, b]) => a <= m.index && m.index <= b);
      rows.set(name, {
        name,
        summary: summarize(value),
        availability: framework.has(name) ? 'framework' : optIn ? 'opt-in' : 'always',
      });
    }
  }

  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `updated:` is emitted so the page always has one: the JSON-LD below reads
 * `page.updated`, so a regenerate that left the key out would publish an empty
 * `dateModified` until the next sitemap run.
 *
 * It keeps whatever the page already says rather than stamping today, because
 * `pnpm docs:sitemap` can only move a published date *forward* (refresh() in
 * gen-sitemap.mjs) — so a regenerate that jumped it to today left the page
 * claiming a date the sitemap's <lastmod> would not confirm, and
 * tests/docs/page-dates.test.ts red with nothing to run to fix it.
 */
function currentUpdated(): string {
  const existing = fs.existsSync(OUT)
    ? fs.readFileSync(OUT, 'utf-8').match(/^updated:[ \t]*(\S+)/m)?.[1]
    : undefined;
  return existing ?? new Date().toISOString().slice(0, 10);
}

export function renderIndex(): string {
  const table = buildRows()
    .map((r) => `| \`${r.name}\` | ${r.summary} | ${r.availability} |`)
    .join('\n');

  return `---
layout: default
title: "Tool index — every MCP tool the server registers"
description: "Alphabetical index of every trace-mcp MCP tool, generated from the server's own registrations: what each one does and when it is available."
updated: ${currentUpdated()}
---

<!-- GENERATED by scripts/tools-index.ts — do not edit by hand. -->

# Tool index

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": {{ page.title | jsonify }},
  "description": {{ page.description | jsonify }},
  "url": "https://trace-mcp.com/tools-index.html",
  "datePublished": "2026-08-30",
  "dateModified": {{ page.updated | jsonify }},
  "author": {
    "@type": "Person",
    "name": "Nikolai Vysotskyi",
    "url": "https://github.com/nikolai-vysotskyi"
  },
  "publisher": {
    "@type": "Person",
    "name": "Nikolai Vysotskyi",
    "url": "https://github.com/nikolai-vysotskyi"
  },
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "https://trace-mcp.com/tools-index.html"
  }
}
</script>

Every tool the server registers, alphabetically, with the first line of the
description a client receives in \`tools/list\`. It is generated from the
registrations themselves, so a tool cannot ship without appearing here.

For the tools grouped by what you are trying to do — plus resources, usage
examples and the migration notes — see the [tools reference](tools-reference.md).
The AI-backed tools (\`explain_symbol\`, \`suggest_tests\`, \`review_change\`,
\`find_similar\`, \`explain_architecture\`) register from a different module and
need \`ai.enabled: true\`; they are described
[there](tools-reference.md#ai-powered-optional).

The rows below are registrations, not a count of what you are served. The
{{ site.data.counts.tools }} figure quoted elsewhere counts what any repo gets,
which excludes the framework-specific rows.

| Availability | Meaning |
| --- | --- |
| \`always\` | Registered on every repo. |
| \`framework\` | Only when its framework is detected — see [supported frameworks](supported-frameworks.md). |
| \`opt-in\` | Behind a config flag (\`topology.enabled\`, \`runtime.enabled\`) — see [configuration](configuration.md). |

| Tool | What it does | Availability |
| --- | --- | --- |
${table}
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const page = renderIndex();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== page) {
      process.stderr.write('docs/tools-index.md is stale. Run: pnpm run docs:tools-index\n');
      process.exit(1);
    }
    process.stdout.write('docs/tools-index.md is up to date\n');
  } else {
    fs.writeFileSync(OUT, page);
    process.stdout.write(`Wrote docs/tools-index.md (${buildRows().length} tools)\n`);
  }
}
