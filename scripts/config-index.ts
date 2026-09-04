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
 * The rows are read off `z.toJSONSchema()` — zod's *public* projection of the
 * schema — not off `_def` internals. An earlier draft walked the internals and
 * failed open: a zod release that renamed a private field would have produced
 * an empty table with every test still green. The public API throws on a shape
 * it cannot represent, and `assertRepresentative()` below refuses to write a
 * page that lost its keys.
 *
 * Nothing here is hand-maintained, so a new key cannot ship without appearing
 * here; tests/docs/config-index.test.ts fails CI when the page goes stale.
 *
 * Usage: pnpm run docs:config-index [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { TraceMcpConfigSchema } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/config-index.md');

/** Keys whose default is a long generated list — quoting it here would be noise. */
const ELIDED_DEFAULTS = new Set(['include', 'exclude', 'security.secret_patterns']);

/** `root` and `children` are internal plumbing, not options a user sets. */
const INTERNAL = new Set(['root', 'children']);

/**
 * A floor, not a count: the page is meant to grow. It exists so a future zod
 * release that changes the projection cannot quietly empty the table — the
 * generator refuses to write, rather than publishing a page that says the
 * schema accepts nothing.
 */
const MIN_KEYS = 200;

export interface ConfigRow {
  key: string;
  type: string;
  default: string;
}

interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
}

function jsonSchema(): JsonSchemaNode {
  // `io: 'input'` is what a user writes into the file — the side defaults live
  // on. `unrepresentable: 'any'` keeps a `z.custom()` from aborting the page.
  return z.toJSONSchema(TraceMcpConfigSchema, {
    io: 'input',
    unrepresentable: 'any',
  }) as JsonSchemaNode;
}

/**
 * `minimum: 1, maximum: 1024` → ` (≥ 1, ≤ 1024)`.
 *
 * `z.int()` projects as ±`MAX_SAFE_INTEGER`, which is a statement about doubles
 * rather than about the option — dropped, so a real ceiling stands out.
 */
function bounds(node: JsonSchemaNode): string {
  const parts: string[] = [];
  const real = (v: number | undefined): boolean =>
    v !== undefined && Math.abs(v) !== Number.MAX_SAFE_INTEGER;
  if (real(node.minimum)) parts.push(`≥ ${node.minimum}`);
  if (real(node.exclusiveMinimum)) parts.push(`> ${node.exclusiveMinimum}`);
  if (real(node.maximum)) parts.push(`≤ ${node.maximum}`);
  if (real(node.exclusiveMaximum)) parts.push(`< ${node.exclusiveMaximum}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

const literal = (v: unknown): string => `\`${typeof v === 'string' ? v : JSON.stringify(v)}\``;

export function describeType(node: JsonSchemaNode): string {
  if (node.enum) return node.enum.map(literal).join(' \\| ');
  if (node.const !== undefined) return literal(node.const);
  if (node.anyOf) return node.anyOf.map(describeType).join(' \\| ');
  const type = Array.isArray(node.type) ? node.type.join(' \\| ') : node.type;
  switch (type) {
    case 'array': {
      const item = node.items ? describeType(node.items) : 'any';
      // `(a | b)[]` — without the parens a union of members reads as a union
      // whose last member happens to be an array.
      return item.includes('\\|') ? `(${item})[]` : `${item}[]`;
    }
    case 'number':
    case 'integer':
      return `number${bounds(node)}`;
    case undefined:
      return 'any';
    default:
      return type;
  }
}

function describeDefault(key: string, node: JsonSchemaNode): string {
  if (!('default' in node)) return node.properties ? '—' : '_unset_';
  if (ELIDED_DEFAULTS.has(key)) return '_built-in list_';
  const json = JSON.stringify(node.default);
  if (json === undefined) return '_unset_';
  if (json.length > 60) return `\`${json.slice(0, 57)}…\``;
  return `\`${json.replace(/\|/g, '\\|')}\``;
}

export function buildRows(): ConfigRow[] {
  const rows: ConfigRow[] = [];
  const walk = (node: JsonSchemaNode, prefix: string): void => {
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      const full = prefix ? `${prefix}.${key}` : key;
      if (INTERNAL.has(full)) continue;
      rows.push({ key: full, type: describeType(child), default: describeDefault(full, child) });
      walk(child, full);
    }
  };
  walk(jsonSchema(), '');
  return rows;
}

/** Refuses to publish a page that lost the schema — see MIN_KEYS. */
export function assertRepresentative(rows: ConfigRow[]): void {
  if (rows.length < MIN_KEYS) {
    throw new Error(
      `config-index: only ${rows.length} keys came back from z.toJSONSchema (expected at least ${MIN_KEYS}). ` +
        `The schema shrank, or zod's JSON Schema projection changed — do not publish this page.`,
    );
  }
}

/**
 * `updated:` is emitted so the page always has one — `pnpm docs:sitemap` stamps
 * the real git date over it, and the JSON-LD below reads `page.updated`.
 */
export function renderIndex(): string {
  const rows = buildRows();
  assertRepresentative(rows);
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

/**
 * `updated:` is owned by `pnpm docs:sitemap`, which stamps the page's git date
 * over the one rendered here — so a byte-for-byte comparison would start
 * failing the day after the page was generated. Compare the rest.
 */
export const withoutStamp = (page: string): string => page.replace(/^updated:.*\n/m, '');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const page = renderIndex();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (withoutStamp(current) !== withoutStamp(page)) {
      process.stderr.write('docs/config-index.md is stale. Run: pnpm run docs:config-index\n');
      process.exit(1);
    }
    process.stdout.write('docs/config-index.md is up to date\n');
  } else {
    fs.writeFileSync(OUT, page);
    process.stdout.write(`Wrote docs/config-index.md (${buildRows().length} keys)\n`);
  }
}
