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
      new RegExp(
        // The overhead rows write their (absent) baseline as an em-dash, so the
        // middle cell has to admit one or they stay unguarded.
        `^\\|\\s*\`${tool}\`\\s*\\|\\s*[\\d,]+\\s*\\|\\s*(?:[\\d,]+|[—-]+)\\s*\\|`,
        'm',
      ).test(page),
    );
    expect(
      offenders,
      `${PAGE} states these tools' numbers as literals — render them from ${DATA} instead`,
    ).toEqual([]);
  });

  it('keeps the field-tail prose and numbers in sync with generated tail data (TRA-1159)', () => {
    const TAIL_DATA = 'docs/_data/response_tokens_tail.json';
    const tailData = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, TAIL_DATA), 'utf8')) as {
      tail_tools: number;
      tail_calls: number;
      coverage_pct_before: number;
      coverage_pct_after: number;
      headline: { reduction_pct_incl_overhead_with_tail: number };
    };

    expect(page).toContain(`Pricing the remaining ${tailData.tail_tools} tail tools`);
    expect(page).toContain(
      `reduction of **${tailData.headline.reduction_pct_incl_overhead_with_tail}%**`,
    );
    expect(page).toContain(`${tailData.coverage_pct_before}% to ${tailData.coverage_pct_after}%`);

    const prereg = fs.readFileSync(
      path.join(REPO_ROOT, 'docs/perf/prereg-response-tokens.md'),
      'utf8',
    );
    expect(prereg).toContain(`The tail measurement prices ${tailData.tail_tools} tools`);
    expect(prereg).toContain(
      `reduction is **${tailData.headline.reduction_pct_incl_overhead_with_tail}%**`,
    );
    expect(prereg).toContain(
      `${tailData.coverage_pct_before}% (head store) to ${tailData.coverage_pct_after}%`,
    );

    const ref = fs.readFileSync(path.join(REPO_ROOT, 'docs/tools-reference.md'), 'utf8');
    expect(ref).toContain('Migration note (TRA-1159)');
    expect(ref).toContain('include_edge_types: true');
    expect(ref).toContain('name');
    expect(ref).toContain('category');
    expect(ref).toContain('description');
  });
});
