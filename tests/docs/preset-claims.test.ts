import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { createToolFilter } from '../../src/server/tool-filter.js';
import { allToolNames } from './tool-surface.js';

/**
 * TRA-259: the documented preset sizes were never checked against the filter.
 * `minimal` was documented as "~16 tools" (the raw TOOL_PRESETS list length)
 * while a client is actually served 24 — the always-on meta tools are added on
 * top of every preset. Same story for `standard` (~50 documented, 59 served)
 * and `full` ("~170"). These are the numbers a user budgets context against,
 * so they get a receipt.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');

function servedCount(preset: string): number {
  const filter = createToolFilter({ tools: { preset } } as unknown as TraceMcpConfig);
  return allToolNames().filter((name) => filter(name)).length;
}

// comparisons.md stated its own preset sizes (`minimal` 24, `standard` 55) and
// drifted for exactly as long as it was outside this list (TRA-263). Its claims
// were reworded into the `<preset>` (N tools) shape so they land in scope here.
const DOCS = [
  'docs/configuration.md',
  'docs/llms-full.txt',
  'docs/comparisons.md',
  'docs/reduce-claude-code-token-usage.md',
];
const PRESETS = ['standard', 'minimal', 'review', 'architecture'];

describe('documented tool-preset sizes', () => {
  for (const path of DOCS) {
    it(`${path}: every "\`<preset>\` (N tools)" claim matches the tool filter`, () => {
      const text = readFileSync(join(REPO_ROOT, path), 'utf8');
      let checked = 0;
      for (const preset of PRESETS) {
        const m = text.match(new RegExp('`' + preset + '` \\((~?\\d+) tools'));
        if (!m) continue;
        checked++;
        const claimed = m[1];
        const actual = servedCount(preset);
        if (claimed !== String(actual)) {
          throw new Error(
            `${path} claims preset "${preset}" is ${claimed} tools; the tool filter admits ${actual}. ` +
              'Update the doc (or the preset).',
          );
        }
      }
      expect(checked, `no preset claims found in ${path}`).toBeGreaterThan(0);
    });
  }
});

/**
 * TRA-427: the four `docs/vs/*.md` head-to-head pages quote the shipped default
 * surface at every reader-facing turn — table row, "when to pick theirs", FAQ,
 * JSON-LD answer text — but none of them was in DOCS above, so the numbers were
 * unguarded. They had already drifted once: `docs/vs/serena.md` quoted the
 * `full` ceiling as the *default* row while its own prose two screens down said
 * 28, which made us look ~6x more expensive than we are on the page comparing
 * us to a ~55-tool competitor.
 *
 * The claim is worded five ways across the pages, so this does not match the
 * sentence around it. It reads the number out of the one place every page
 * states it in a fixed shape — the comparison table's "advertised (default)"
 * row — and checks it against what the filter actually serves. That is the cell
 * that drifted, and prose elsewhere on the page saying 28 must not excuse it.
 *
 * A second, looser pass keeps the pages without that row honest: any page
 * quoting the `~11.6K` wire cost has to name the served count somewhere.
 */
const VS_DEFAULT_PRESET = 'minimal';
const VS_TOKEN_ANCHOR = '11.6K';

/**
 * TRA-448: the same default surface was priced at ~9.8K, ~9K and ~11.6K on three
 * pages, with nothing saying why. Two of those are real and mean different
 * things — `tools/list` schema alone, and schema plus the server-instructions
 * block a client also pays at session start — and the ~9K was simply stale.
 * The tool *count* has had a receipt since TRA-427; the token figure had none,
 * so a re-measurement would silently strand the pages nobody edited.
 *
 * ponytail: this pins the pair rather than re-measuring it. A re-measure is a
 * two-line change here and the failure names both figures; adding a live
 * tokenizer run to a docs test buys nothing the pin does not.
 */
const DEFAULT_SURFACE_TOKENS = { schema: '9.8K', wire: '11.6K' };
// The label is stable across the pages; the cell after it is free-form prose.
const VS_DEFAULT_ROW = /^\|[^|\n]*advertised[^|\n]*\(default\)[^|\n]*\|([^|\n]*)\|/gim;
// ponytail: bare-number coverage, so "28.1K stars" does not count as the claim.
// Loose on purpose — the row check above is the one with teeth.
const bareCount = (n: string) => new RegExp(String.raw`\b${n}\b(?![.,]\d)`);

describe('head-to-head pages quote the real default surface', () => {
  const vsDir = join(REPO_ROOT, 'docs', 'vs');
  const pages = readdirSync(vsDir).filter((f) => f.endsWith('.md'));

  it('docs/vs contains pages to check', () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  it(`the "advertised (default)" row matches the \`${VS_DEFAULT_PRESET}\` preset`, () => {
    const served = String(servedCount(VS_DEFAULT_PRESET));
    const rows: string[] = [];
    const stale: string[] = [];

    for (const f of pages) {
      const text = readFileSync(join(vsDir, f), 'utf8');
      for (const m of text.matchAll(VS_DEFAULT_ROW)) {
        rows.push(`docs/vs/${f}`);
        const claimed = m[1].match(/\d+/)?.[0];
        if (claimed !== served) stale.push(`docs/vs/${f} (says ${claimed ?? 'nothing'})`);
      }
    }

    expect(
      rows.length,
      'no docs/vs page has an "advertised (default)" comparison row — did the tables get reshaped?',
    ).toBeGreaterThan(0);
    expect(
      stale,
      `the \`${VS_DEFAULT_PRESET}\` preset serves ${served} tools; re-measure the wire cost and reword`,
    ).toEqual([]);
  });

  it(`every page quoting "~${VS_TOKEN_ANCHOR} tokens" names the served count`, () => {
    const served = String(servedCount(VS_DEFAULT_PRESET));
    const quoting = pages.filter((f) =>
      readFileSync(join(vsDir, f), 'utf8').includes(VS_TOKEN_ANCHOR),
    );
    expect(
      quoting.length,
      `no docs/vs page quotes the default surface — did the anchor "${VS_TOKEN_ANCHOR}" get reworded?`,
    ).toBe(pages.length);

    const silent = quoting.filter(
      (f) => !bareCount(served).test(readFileSync(join(vsDir, f), 'utf8')),
    );
    expect(
      silent,
      `these pages sell the ~${VS_TOKEN_ANCHOR} default surface without ever saying it is ${served} tools`,
    ).toEqual([]);
  });

  it('the "advertised (default)" row prices the wire cost, and says what is in it', () => {
    const wrong: string[] = [];
    for (const f of pages) {
      for (const m of readFileSync(join(vsDir, f), 'utf8').matchAll(VS_DEFAULT_ROW)) {
        const cell = m[1];
        // The cell quotes one of our own figures. It has to be the wire cost —
        // the schema-only 9.8K here would undercount what a client actually
        // pays — and it has to say the instructions block is included.
        if (!cell.includes(DEFAULT_SURFACE_TOKENS.wire) || !cell.includes('server instructions')) {
          wrong.push(`docs/vs/${f}: ${cell.trim()}`);
        }
      }
    }
    expect(
      wrong,
      `each row must price the default surface at ~${DEFAULT_SURFACE_TOKENS.wire} and name the ` +
        `server-instructions block; ~${DEFAULT_SURFACE_TOKENS.schema} is \`tools/list\` alone`,
    ).toEqual([]);
  });
});

/**
 * comparisons.md carries both figures in one cell, so it is the page that has to
 * distinguish them — the drift TRA-448 found was a reader comparing this row
 * against a docs/vs row and seeing two prices for the same thing.
 */
describe('comparisons.md separates the two default-surface figures', () => {
  it('names the schema cost and the wire cost, and labels each', () => {
    const text = readFileSync(join(REPO_ROOT, 'docs/comparisons.md'), 'utf8');
    const row = text.match(VS_DEFAULT_ROW)?.[0] ?? '';
    expect(row, 'no "advertised (default)" row in docs/comparisons.md').not.toBe('');
    expect(row).toContain(`~${DEFAULT_SURFACE_TOKENS.schema} tok schema`);
    expect(row).toContain(`~${DEFAULT_SURFACE_TOKENS.wire} with server instructions`);
  });
});
