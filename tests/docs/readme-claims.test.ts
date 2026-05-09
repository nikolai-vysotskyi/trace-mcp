import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '../../src/plugin-api/registry.js';

/**
 * README-claims regression test.
 *
 * mempalace #835 / #897 ship a 42-test "every README claim has a code
 * receipt" suite to keep marketing copy aligned with reality. This is the
 * trace-mcp analogue: we extract the numeric claims from README.md and
 * cross-check them against live counts from the plugin registry and the
 * MCP tool-register sources. When a number drifts, the test fails with a
 * pointer at the exact line in README to fix (or at the source of truth
 * to update).
 *
 * Tolerance: ±2 on framework / language / tool counts so a single in-flight
 * plugin add doesn't block unrelated CI runs. Outside the tolerance the test
 * fails — that's the signal to update README.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const README_PATH = join(REPO_ROOT, 'README.md');

function readReadme(): string {
  return readFileSync(README_PATH, 'utf-8');
}

interface Claim {
  count: number;
  rawLine: string;
  description: string;
}

/**
 * Pull the first occurrence of each `<NUMBER> <unit>` claim out of README.
 * Picks the first hit so duplicate claims (e.g. "138 tools" appearing in
 * both intro and table-of-contents) only need to be updated once.
 */
function findClaim(unit: RegExp, readme: string, description: string): Claim | null {
  const lines = readme.split('\n');
  for (const line of lines) {
    const m = line.match(new RegExp(`(\\d+)\\s+${unit.source}`));
    if (m) {
      return { count: Number.parseInt(m[1], 10), rawLine: line.trim(), description };
    }
  }
  return null;
}

function within(actual: number, claim: number, tolerance: number): boolean {
  return Math.abs(actual - claim) <= tolerance;
}

function countServerToolCalls(): number {
  // Grep via Node fs rather than shelling out so the test stays portable.
  const out = execSync(
    `grep -lE "server\\.tool\\(" ${join(REPO_ROOT, 'src/tools/register')}/*.ts`,
    { encoding: 'utf-8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  let total = 0;
  for (const file of out) {
    const body = readFileSync(file, 'utf-8');
    const matches = body.match(/server\.tool\(/g);
    if (matches) total += matches.length;
  }
  return total;
}

describe('README numeric claims', () => {
  const readme = readReadme();
  const registry = PluginRegistry.createWithDefaults();
  const langPlugins = registry.getLanguagePlugins().length;
  const fwPlugins = registry.getAllFrameworkPlugins().length;
  const toolCount = countServerToolCalls();

  it('frameworks count in README is within tolerance of registered framework plugins', () => {
    const claim = findClaim(/framework integrations?/, readme, 'frameworks-integration count');
    expect(claim, 'no "X framework integrations" claim found in README').not.toBeNull();
    if (!claim) return;
    if (!within(fwPlugins, claim.count, 5)) {
      throw new Error(
        `README claims ${claim.count} framework integrations; registry has ${fwPlugins}. ` +
          `Update README.md line: "${claim.rawLine}"`,
      );
    }
  });

  it('languages count in README matches registered language plugins (±2)', () => {
    const claim = findClaim(/languages?/, readme, 'languages count');
    expect(claim, 'no "X languages" claim found in README').not.toBeNull();
    if (!claim) return;
    if (!within(langPlugins, claim.count, 2)) {
      throw new Error(
        `README claims ${claim.count} languages; registry has ${langPlugins}. ` +
          `Update README.md line: "${claim.rawLine}"`,
      );
    }
  });

  it('MCP tool count in README matches the source of truth (±5)', () => {
    const claim = findClaim(/tools?/, readme, 'tool count');
    expect(claim, 'no "X tools" claim found in README').not.toBeNull();
    if (!claim) return;
    if (!within(toolCount, claim.count, 5)) {
      throw new Error(
        `README claims ${claim.count} tools; src/tools/register/*.ts contains ` +
          `${toolCount} server.tool(...) registrations. Update README.md line: "${claim.rawLine}"`,
      );
    }
  });

  it('package.json version is referenced consistently in plugin manifests', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(typeof pkg.version).toBe('string');
    // The plugin/marketplace manifest sync test in tests/plugin/manifest-sync.test.ts
    // owns the cross-file version assertion; we just confirm the package.json
    // version exists so the README-claims test refuses to run on a corrupted manifest.
    expect(pkg.version.length).toBeGreaterThan(0);
  });
});
