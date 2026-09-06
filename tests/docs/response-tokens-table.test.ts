import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');
const PAGE = 'docs/perf/response-tokens.md';
const DATA = 'docs/_data/response_tokens.json';

const page = fs.readFileSync(path.join(REPO_ROOT, PAGE), 'utf8');
const data = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, DATA), 'utf8')) as {
  rows: Array<{ tool: string }>;
  overhead_rows: Array<{ tool: string }>;
};

/**
 * TRA-1020: the aggregates on this page were always generated; the per-tool
 * table was hand-typed Markdown, and it drifted. It published `search` at 924
 * tokens (1.54x) while the committed artifact said 421 (0.70x) — and the page's
 * conclusion, "the whole of the negative block that matters", was drawn from
 * the typed rows rather than the measured ones.
 *
 * ponytail: one regex, aimed at the exact shape of the table that went stale —
 * a row whose first cell is a tool name and whose next two cells are bare
 * numbers. Historical before/after tables state their numbers as `5,240
 * (10.48x)`, so they read as history and do not trip this.
 */
describe('response-tokens page', () => {
  it('renders the per-tool tables from site.data, never as literals', () => {
    expect(page).toContain('{% for r in site.data.response_tokens.rows -%}');
    expect(page).toContain('{% for r in site.data.response_tokens.overhead_rows -%}');
  });

  it('has no hand-typed per-tool measurement row', () => {
    const tools = [...data.rows, ...data.overhead_rows].map((r) => r.tool);
    const offenders = tools.filter((tool) =>
      new RegExp(`^\\|\\s*\`${tool}\`\\s*\\|\\s*[\\d,]+\\s*\\|\\s*[\\d,]+\\s*\\|`, 'm').test(page),
    );
    expect(
      offenders,
      `${PAGE} states these tools' numbers as literals — render them from ${DATA} instead`,
    ).toEqual([]);
  });

});
