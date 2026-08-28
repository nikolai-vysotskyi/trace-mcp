import { readFileSync } from 'node:fs';
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
const DOCS = ['docs/configuration.md', 'docs/llms-full.txt', 'docs/comparisons.md'];
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
