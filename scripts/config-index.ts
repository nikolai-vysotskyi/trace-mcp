#!/usr/bin/env tsx
/**
 * Generates docs/config-index.md — every key `TraceMcpConfigSchema` accepts,
 * with its type, allowed values and real default (TRA-801).
 *
 * docs/configuration.md is a curated page: it explains the keys you actually
 * reach for and delegates the big sections to their own pages. It was never
 * complete — 73 of the 263 keys the schema accepts were described nowhere in
 * the repository, including whole subsystems (`predictive`, `runtime`,
 * `indexer`, `pipeline`, `vault`, `logging`, `git`) and six daemon knobs — so a
 * reader could set a real option and find no confirmation it existed, or
 * conclude it did not.
 *
 * Nothing here is hand-maintained: the rows are walked off the schema itself,
 * so a new key cannot ship without appearing here. tests/docs/config-index.test.ts
 * fails CI when the page goes stale.
 *
 * Usage: pnpm run docs:config-index [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraceMcpConfigSchema } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/config-index.md');

/** Keys whose default is a long generated list — quoting it here would be noise. */
const ELIDED_DEFAULTS = new Set(['include', 'exclude', 'security.secret_patterns']);

export interface ConfigRow {
  key: string;
  type: string;
  default: string;
}

/**
 * Peels `.optional()` / `.default()` / `.prefault()` wrappers off a schema,
 * keeping the outermost default it saw on the way down.
 */
function unwrap(schema: unknown): { node: any; def: unknown } {
  let node = schema as any;
  let def: unknown;
  for (let i = 0; i < 30; i++) {
    const d = node?._def;
    if (!d) break;
    if (d.defaultValue !== undefined && def === undefined) {
      def = typeof d.defaultValue === 'function' ? d.defaultValue() : d.defaultValue;
    }
    if (d.innerType) {
      node = d.innerType;
      continue;
    }
    if (d.schema) {
      node = d.schema;
      continue;
    }
    break;
  }
  return { node, def };
}

/** `z.number().min(1).max(1024)` → `1–1024`, read off the checks zod keeps. */
function range(node: any): string {
  let min: string | undefined;
  let max: string | undefined;
  for (const check of node?._def?.checks ?? []) {
    const d = check?._zod?.def ?? check?._def;
    if (d?.check === 'greater_than') min = `${d.inclusive ? '≥' : '>'} ${d.value}`;
    if (d?.check === 'less_than') max = `${d.inclusive ? '≤' : '<'} ${d.value}`;
  }
  const bounds = [min, max].filter(Boolean);
  return bounds.length ? ` (${bounds.join(', ')})` : '';
}

function describeType(node: any): string {
  const d = node?._def;
  const t = d?.typeName ?? d?.type;
  switch (t) {
    case 'enum':
      return Object.keys(d.entries ?? {})
        .map((v) => `\`${v}\``)
        .join(' \\| ');
    case 'number':
      return `number${range(node)}`;
    case 'array': {
      const inner = unwrap(d.element).node;
      const it = inner?._def?.typeName ?? inner?._def?.type;
      return `${it === 'string' || it === 'enum' ? 'string' : it === 'number' ? 'number' : 'object'}[]`;
    }
    case 'record':
      return 'object';
    case 'union':
      return (d.options ?? []).map((o: any) => describeType(unwrap(o).node)).join(' \\| ');
    default:
      return String(t ?? 'unknown');
  }
}

function describeDefault(key: string, def: unknown, node: any): string {
  const t = node?._def?.typeName ?? node?._def?.type;
  if (def === undefined) return t === 'object' ? '—' : '_unset_';
  if (ELIDED_DEFAULTS.has(key)) return '_built-in list_';
  const json = JSON.stringify(def);
  if (json === undefined) return '_unset_';
  if (json.length > 60) return `\`${json.slice(0, 57)}…\``;
  return `\`${json.replace(/\|/g, '\\|')}\``;
}

export function buildRows(): ConfigRow[] {
  const rows: ConfigRow[] = [];
  const walk = (schema: unknown, prefix: string): void => {
    const { node, def } = unwrap(schema);
    const t = node?._def?.typeName ?? node?._def?.type;
    if (prefix) {
      rows.push({
        key: prefix,
        type: describeType(node),
        default: describeDefault(prefix, def, node),
      });
    }
    if (t !== 'object') return;
    const shape = typeof node.shape === 'function' ? node.shape() : node.shape;
    for (const k of Object.keys(shape ?? {})) walk(shape[k], prefix ? `${prefix}.${k}` : k);
  };
  walk(TraceMcpConfigSchema, '');
  // `root` and `children` are internal plumbing, not options a user sets.
  return rows.filter((r) => r.key !== 'root' && r.key !== 'children');
}

/**
 * `updated:` is emitted so the page always has one — `pnpm docs:sitemap` stamps
 * the real git date over it, and the JSON-LD below reads `page.updated`.
 */
export function renderIndex(): string {
  const rows = buildRows();
  const table = rows.map((r) => `| \`${r.key}\` | ${r.type} | ${r.default} |`).join('\n');

  return `---
layout: default
title: "Config index — every key trace-mcp accepts"
description: "Complete index of every trace-mcp configuration key, generated from the schema itself: type, allowed values and the real default."
updated: ${new Date().toISOString().slice(0, 10)}
---

<!-- GENERATED by scripts/config-index.ts — do not edit by hand. -->

# Config index

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": {{ page.title | jsonify }},
  "description": {{ page.description | jsonify }},
  "url": "https://trace-mcp.com/config-index.html",
  "datePublished": "2026-09-04",
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
    "@id": "https://trace-mcp.com/config-index.html"
  }
}
</script>

Every key the config schema accepts, in schema order, with its type and the
default that applies when you leave it out. It is generated from the schema
itself, so an option cannot ship without appearing here.

This page answers "does this key exist, and what is it set to if I say nothing".
For what a key is *for* — and for the sections large enough to have earned their
own page — start at [configuration](configuration.md), which links on to
[quality gates](quality-gates.md), [telemetry](telemetry.md),
[daemon memory](daemon-memory.md) and [decision memory](decision-memory.md).

Everything is optional: trace-mcp indexes a standard project with no config file
at all. A default of \`—\` means the key is a section rather than a value;
\`_unset_\` means there is no default and the feature reads the key only when you
supply it.

| Key | Type | Default |
| --- | --- | --- |
${table}

One default is worth reading with care: \`db.path\` is vestigial. Nothing derives
the index location from it — \`getDbPath()\` in \`src/global.ts\` puts every index
under \`~/.trace/index/\` — and its only reader is the \`config.dbPath\` field of
\`get_project_status\`, which therefore reports a path the database is not at.
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const page = renderIndex();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== page) {
      process.stderr.write('docs/config-index.md is stale. Run: pnpm run docs:config-index\n');
      process.exit(1);
    }
    process.stdout.write('docs/config-index.md is up to date\n');
  } else {
    fs.writeFileSync(OUT, page);
    process.stdout.write(`Wrote docs/config-index.md (${buildRows().length} keys)\n`);
  }
}
