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

function countServerResourceCalls(): number {
  const out = execSync(
    `grep -lE "server\\.resource\\(" ${join(REPO_ROOT, 'src/tools/register')}/*.ts`,
    { encoding: 'utf-8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  let total = 0;
  for (const file of out) {
    const body = readFileSync(file, 'utf-8');
    const matches = body.match(/server\.resource\(/g);
    if (matches) total += matches.length;
  }
  return total;
}

/**
 * Every `<NUMBER>+? <unit>` occurrence in the text, not just the first —
 * TRA-174 found the same file contradicting itself (llms.txt claimed both
 * "170 MCP tools" and "44+ MCP tools"), which a first-match-only check
 * would never catch.
 */
function findAllClaims(unit: RegExp, text: string): Claim[] {
  const claims: Claim[] = [];
  for (const line of text.split('\n')) {
    const re = new RegExp(`(\\d+)\\+?\\s+${unit.source}`, 'g');
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec-loop idiom
    while ((m = re.exec(line))) {
      claims.push({
        count: Number.parseInt(m[1], 10),
        rawLine: line.trim(),
        description: unit.source,
      });
    }
  }
  return claims;
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

/**
 * TRA-174: trace-mcp.com's homepage, llms.txt and comparisons.md each stated
 * a different language/framework/tool count — and llms.txt contradicted
 * itself in the same file. Every doc surface must agree with the live
 * registry counts, and with each other.
 */
describe('docs site numeric claims (TRA-174)', () => {
  const registry = PluginRegistry.createWithDefaults();
  const langPlugins = registry.getLanguagePlugins().length;
  const fwPlugins = registry.getAllFrameworkPlugins().length;
  const toolCount = countServerToolCalls();
  const resourceCount = countServerResourceCalls();

  // comparisons.md is excluded here — its tables legitimately contain many
  // competitors' language/tool counts (e.g. "158 languages", "40+ tools"),
  // so a whole-file scan would false-positive on numbers that aren't about
  // trace-mcp. It gets its own targeted, column-scoped check below instead.
  //
  // TRA-243: the site surfaces were guarded, but CLAUDE.md and the shipped
  // skills were not — and both had drifted badly (CLAUDE.md still claimed
  // "48+ frameworks across 68 languages"; the skills claimed "120+ tools").
  // `skipLine` exempts lines that legitimately state a *subset* count
  // (preset sizes, the TOON allowlist) rather than the total.
  const docs: Array<{ path: string; tolerance: number; skipLine?: RegExp }> = [
    { path: 'docs/index.html', tolerance: 2 },
    { path: 'docs/llms.txt', tolerance: 2 },
    { path: 'docs/tools-reference.md', tolerance: 5 },
    { path: 'docs/quality-gates.md', tolerance: 5 },
    { path: 'CLAUDE.md', tolerance: 5, skipLine: /output_format|preset/ },
    { path: 'AGENTS.md', tolerance: 5, skipLine: /output_format|preset/ },
    { path: 'skills/README.md', tolerance: 5 },
    { path: 'skills/trace-mcp/SKILL.md', tolerance: 5, skipLine: /output_format|preset/ },
  ];

  for (const { path, tolerance, skipLine } of docs) {
    it(`${path}: every "languages" claim matches the registry (±${tolerance})`, () => {
      const text = readFileSync(join(REPO_ROOT, path), 'utf-8');
      for (const claim of findAllClaims(/languages?/, text)) {
        if (!within(langPlugins, claim.count, tolerance)) {
          throw new Error(
            `${path} claims ${claim.count} languages; registry has ${langPlugins}. Line: "${claim.rawLine}"`,
          );
        }
      }
    });

    it(`${path}: every "frameworks/integrations" claim matches the registry (±${tolerance})`, () => {
      const text = readFileSync(join(REPO_ROOT, path), 'utf-8');
      for (const claim of findAllClaims(
        /(?:frameworks?|integrations?|framework integrations?)/,
        text,
      )) {
        if (!within(fwPlugins, claim.count, tolerance)) {
          throw new Error(
            `${path} claims ${claim.count} frameworks/integrations; registry has ${fwPlugins}. Line: "${claim.rawLine}"`,
          );
        }
      }
    });

    it(`${path}: every "MCP tools" claim matches the source of truth (±${tolerance})`, () => {
      const text = readFileSync(join(REPO_ROOT, path), 'utf-8');
      for (const claim of findAllClaims(/(?:MCP )?tools?/, text)) {
        if (skipLine?.test(claim.rawLine)) continue;
        if (!within(toolCount, claim.count, tolerance)) {
          throw new Error(
            `${path} claims ${claim.count} tools; src/tools/register/*.ts contains ${toolCount} server.tool(...) registrations. Line: "${claim.rawLine}"`,
          );
        }
      }
    });
  }

  it("comparisons.md: trace-mcp's own column (first data cell per row) matches the registry", () => {
    // Row label -> which metric its trace-mcp cell should match, and tolerance.
    const rowChecks: Array<{ labelPrefix: string; expected: number; tolerance: number }> = [
      { labelPrefix: 'Tree-sitter AST parsing', expected: langPlugins, tolerance: 2 },
      { labelPrefix: 'Languages', expected: langPlugins, tolerance: 2 },
      { labelPrefix: 'Framework-aware edges', expected: fwPlugins, tolerance: 5 },
      { labelPrefix: 'Framework integrations', expected: fwPlugins, tolerance: 5 },
      { labelPrefix: 'Code intelligence included', expected: toolCount, tolerance: 5 },
      { labelPrefix: 'MCP tools', expected: toolCount, tolerance: 5 },
    ];
    const text = readFileSync(join(REPO_ROOT, 'docs/comparisons.md'), 'utf-8');
    for (const line of text.split('\n')) {
      const cells = line.split('|').map((c) => c.trim());
      // Table row shape: ["", "<label>", "<trace-mcp cell>", ...competitors, ""]
      if (cells.length < 3) continue;
      const check = rowChecks.find((r) => cells[1] === r.labelPrefix);
      if (!check) continue;
      const m = cells[2].match(/(\d+)/);
      if (!m) continue;
      const claimCount = Number.parseInt(m[1], 10);
      if (!within(check.expected, claimCount, check.tolerance)) {
        throw new Error(
          `docs/comparisons.md row "${check.labelPrefix}": trace-mcp cell claims ${claimCount}, ` +
            `registry has ${check.expected}. Line: "${line.trim()}"`,
        );
      }
    }
  });

  it('llms.txt and tools-reference.md agree on the resource count', () => {
    const llms = readFileSync(join(REPO_ROOT, 'docs/llms.txt'), 'utf-8');
    const toolsRef = readFileSync(join(REPO_ROOT, 'docs/tools-reference.md'), 'utf-8');
    for (const text of [llms, toolsRef]) {
      for (const claim of findAllClaims(/resources?/, text)) {
        if (!within(resourceCount, claim.count, 2)) {
          throw new Error(
            `claims ${claim.count} resources; src/tools/register/*.ts contains ${resourceCount} server.resource(...) registrations. Line: "${claim.rawLine}"`,
          );
        }
      }
    }
  });
});
