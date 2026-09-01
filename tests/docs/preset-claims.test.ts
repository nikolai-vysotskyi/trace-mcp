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
//
// TRA-455: and then drifted again in the *other* word order. Its comparison-table
// row reads ``60 `standard` `` — count first, name second — which the original
// pattern below did not see, so the row sat at a stale 54 while the two claims
// worded the guarded way stayed correct. Both orders are matched now.
const DOCS = [
  'docs/configuration.md',
  'docs/llms-full.txt',
  'docs/comparisons.md',
  'docs/reduce-claude-code-token-usage.md',
];
const PRESETS = [
  'standard',
  'minimal',
  'review',
  'architecture',
  'dev',
  'security',
  'design',
  'perf',
];

describe('documented tool-preset sizes', () => {
  for (const path of DOCS) {
    it(`${path}: every "\`<preset>\` (N tools)" claim matches the tool filter`, () => {
      const text = readFileSync(join(REPO_ROOT, path), 'utf8');
      let checked = 0;
      for (const preset of PRESETS) {
        // Both orders: "`standard` (60 tools)" and "60 `standard`".
        const patterns = [
          new RegExp('`' + preset + '` \\((~?\\d+) tools'),
          new RegExp('(~?\\d+) `' + preset + '`'),
        ];
        const actual = servedCount(preset);
        for (const pattern of patterns) {
          for (const m of text.matchAll(new RegExp(pattern, 'g'))) {
            checked++;
            const claimed = m[1];
            if (claimed !== String(actual)) {
              throw new Error(
                `${path} claims preset "${preset}" is ${claimed} tools; the tool filter admits ${actual}. ` +
                  'Update the doc (or the preset).',
              );
            }
          }
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
 *
 * TRA-448: the tool count was guarded, the token figure next to it was not, so
 * the same surface ended up priced at ~9.8K (comparisons.md), ~9K
 * (llms-full.txt) and ~11.6K (docs/vs/*) — schema-only on some pages, schema +
 * server instructions on others, with nothing on the page saying which. One
 * basis is quoted everywhere now: the whole session-start cost, because that is
 * what a client pays. The checks below extend to comparisons.md's copy of the
 * row and to the prose pages that price the default surface.
 */
const VS_DEFAULT_PRESET = 'minimal';
const VS_TOKEN_ANCHOR = '11.6K';
// The label is stable across the pages; the cell after it is free-form prose.
const VS_DEFAULT_ROW = /^\|[^|\n]*advertised[^|\n]*\(default\)[^|\n]*\|([^|\n]*)\|/gim;
// ponytail: bare-number coverage, so "28.1K stars" does not count as the claim.
// Loose on purpose — the row check above is the one with teeth.
const bareCount = (n: string) => new RegExp(String.raw`\b${n}\b(?![.,]\d)`);

// Pages that state the default surface's wire cost in prose rather than a row.
const TOKEN_PROSE_PAGES = ['docs/llms-full.txt', 'docs/reduce-claude-code-token-usage.md'];

describe('head-to-head pages quote the real default surface', () => {
  const vsDir = join(REPO_ROOT, 'docs', 'vs');
  const pages = readdirSync(vsDir).filter((f) => f.endsWith('.md'));
  // comparisons.md carries the same row shape and drifted independently (TRA-448).
  const rowPages = [...pages.map((f) => `docs/vs/${f}`), 'docs/comparisons.md'];

  it('docs/vs contains pages to check', () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  it(`the "advertised (default)" row matches the \`${VS_DEFAULT_PRESET}\` preset`, () => {
    const served = String(servedCount(VS_DEFAULT_PRESET));
    const rows: string[] = [];
    const stale: string[] = [];

    for (const path of rowPages) {
      const text = readFileSync(join(REPO_ROOT, path), 'utf8');
      for (const m of text.matchAll(VS_DEFAULT_ROW)) {
        rows.push(path);
        const claimed = m[1].match(/\d+/)?.[0];
        if (claimed !== served) stale.push(`${path} (says ${claimed ?? 'nothing'})`);
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

  it(`every "advertised (default)" row prices the surface at ~${VS_TOKEN_ANCHOR}`, () => {
    const offBasis: string[] = [];
    for (const path of rowPages) {
      const text = readFileSync(join(REPO_ROOT, path), 'utf8');
      for (const m of text.matchAll(VS_DEFAULT_ROW)) {
        // The cell may list opt-in presets too; only the default's figure is checked.
        const defaultFigure = m[1].split(';')[0];
        if (!defaultFigure.includes(VS_TOKEN_ANCHOR)) offBasis.push(`${path}: "${m[1].trim()}"`);
      }
    }
    expect(
      offBasis,
      `the default surface costs ~${VS_TOKEN_ANCHOR} (tools/list schema + server instructions — ` +
        'what a client pays at session start). Quote that basis, or re-measure and update ' +
        'VS_TOKEN_ANCHOR plus every page listed here',
    ).toEqual([]);
  });

  it(`prose pages price the default surface at ~${VS_TOKEN_ANCHOR}`, () => {
    const silent = TOKEN_PROSE_PAGES.filter(
      (p) => !readFileSync(join(REPO_ROOT, p), 'utf8').includes(VS_TOKEN_ANCHOR),
    );
    expect(
      silent,
      `these pages describe the shipped default surface but not at ~${VS_TOKEN_ANCHOR} — ` +
        'the figure drifted to ~9K/~9.8K here once already (TRA-448)',
    ).toEqual([]);
  });
});
