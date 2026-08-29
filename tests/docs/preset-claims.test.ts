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
 * A phrase matcher is the wrong shape here — the claim appears as "28 (~11.6K
 * tok)", "advertises 28 tools", "lists 28 on", "our 28 and ~11.6K", "28-tool
 * default", and the pages should stay free to word it naturally. So this pins
 * the pair instead: the pages say the `minimal` preset is 28 tools costing
 * ~11.6K tokens, and `~11.6K` is the unambiguous anchor for that claim. Move
 * the preset off 28 and this fails, naming every page that needs rewording.
 */
const VS_DEFAULT_PRESET = 'minimal';
const VS_CLAIMED_TOOLS = 28;
const VS_TOKEN_ANCHOR = '11.6K';

describe('head-to-head pages quote the real default surface', () => {
  const vsDir = join(REPO_ROOT, 'docs', 'vs');
  const pages = readdirSync(vsDir).filter((f) => f.endsWith('.md'));

  it('docs/vs contains pages to check', () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  it(`every page quoting "~${VS_TOKEN_ANCHOR} tokens" still matches the \`${VS_DEFAULT_PRESET}\` preset`, () => {
    const quoting = pages.filter((f) =>
      readFileSync(join(vsDir, f), 'utf8').includes(VS_TOKEN_ANCHOR),
    );
    expect(
      quoting.length,
      `no docs/vs page quotes the default surface — did the anchor "${VS_TOKEN_ANCHOR}" get reworded?`,
    ).toBeGreaterThan(0);

    const actual = servedCount(VS_DEFAULT_PRESET);
    if (actual !== VS_CLAIMED_TOOLS) {
      throw new Error(
        `preset "${VS_DEFAULT_PRESET}" now admits ${actual} tools, but these pages still sell the ` +
          `default surface as ${VS_CLAIMED_TOOLS} tools / ~${VS_TOKEN_ANCHOR} tokens: ` +
          `${quoting.map((f) => `docs/vs/${f}`).join(', ')}. ` +
          'Re-measure the wire cost, reword the pages, and update the constants in this test.',
      );
    }
  });
});
