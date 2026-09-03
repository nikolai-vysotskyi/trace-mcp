import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import {
  advertisedToolCount,
  allToolNames,
  frameworkGatedToolNames,
  resourceCount as countServerResourceCalls,
} from './tool-surface.js';

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

/**
 * TRA-263: the docs pages no longer hardcode the tool count — they read
 * `docs/_data/counts.yml` through Liquid, because TRA-174's prose fix drifted
 * again (138 / 164 / 165 / ~170 were live on prod at once, two of them on the
 * same page). The scans below still have to see numbers, so resolve the tags
 * the way Jekyll will. Preset sizes are NOT in that file — they get an exact
 * receipt from tests/docs/preset-claims.test.ts instead.
 */
const COUNTS = parseYaml(readFileSync(join(REPO_ROOT, 'docs/_data/counts.yml'), 'utf-8')) as Record<
  string,
  unknown
>;

const COUNT_TAG = /\{\{\s*site\.data\.counts\.([a-z0-9_.]+)\s*\}\}/gi;

function lookupCount(path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], COUNTS);
}

function readDoc(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf-8').replace(COUNT_TAG, (whole, key: string) => {
    const value = lookupCount(key);
    return typeof value === 'number' ? String(value) : whole;
  });
}

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

// TRA-268: both counts used to come from a non-recursive `grep .../register/*.ts`,
// which never saw src/tools/register/navigation/. They now come from
// ./tool-surface.ts, which walks the tree.
const countServerToolCalls = advertisedToolCount;

/**
 * Every `<NUMBER>+? <unit>` occurrence in the text, not just the first —
 * TRA-174 found the same file contradicting itself (llms.txt claimed both
 * "170 MCP tools" and "44+ MCP tools"), which a first-match-only check
 * would never catch.
 */
function findAllClaims(unit: RegExp, text: string): Claim[] {
  const claims: Claim[] = [];
  for (const line of text.split('\n')) {
    // Case-insensitive: docs/index.html carried a stale "138 mcp tools" tag for
    // months because the case-sensitive `MCP ` alternative never matched it.
    const re = new RegExp(`(\\d+)\\+?\\s+${unit.source}`, 'gi');
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

  it('every frameworks count in README is within tolerance of registered framework plugins', () => {
    // TRA-272: same first-match-only gap as the languages check below — README
    // states this number twice and only the first one was ever verified.
    const claims = findAllClaims(/framework integrations?/, readme);
    expect(claims.length, 'no "X framework integrations" claim found in README').toBeGreaterThan(0);
    for (const claim of claims) {
      if (!within(fwPlugins, claim.count, 5)) {
        throw new Error(
          `README claims ${claim.count} framework integrations; registry has ${fwPlugins}. ` +
            `Update README.md line: "${claim.rawLine}"`,
        );
      }
    }
  });

  it('every languages count in README matches registered language plugins (±2)', () => {
    // TRA-272: first-match-only let README say "80 languages" on line 36 and
    // "language coverage (81)" further down for months. Scan every occurrence,
    // the way the docs-site block already does.
    const claims = findAllClaims(/languages?/, readme);
    expect(claims.length, 'no "X languages" claim found in README').toBeGreaterThan(0);
    for (const claim of claims) {
      if (!within(langPlugins, claim.count, 2)) {
        throw new Error(
          `README claims ${claim.count} languages; registry has ${langPlugins}. ` +
            `Update README.md line: "${claim.rawLine}"`,
        );
      }
    }
  });

  it('MCP tool count in README matches the source of truth (±5)', () => {
    const claim = findClaim(/tools?/, readme, 'tool count');
    expect(claim, 'no "X tools" claim found in README').not.toBeNull();
    if (!claim) return;
    if (!within(toolCount, claim.count, 5)) {
      throw new Error(
        `README claims ${claim.count} tools; src/tools/register/ registers ${toolCount} ` +
          `framework-agnostic tools. Update README.md line: "${claim.rawLine}"`,
      );
    }
  });

  it('counts tools registered in subdirectories of src/tools/register (TRA-268)', () => {
    // The old glob was `src/tools/register/*.ts`, so everything under
    // src/tools/register/navigation/ was invisible and the count only matched
    // the docs by coincidence.
    const names = new Set(allToolNames());
    for (const subdirTool of ['search', 'get_symbol', 'get_outline', 'get_task_context']) {
      expect(names.has(subdirTool), `${subdirTool} is registered but not counted`).toBe(true);
    }
  });

  it('the framework-gate detection still finds the framework-only tools (TRA-268)', () => {
    // advertisedToolCount() subtracts the tools registered inside
    // `if (has('vue', ...))`. If framework.ts ever stops using that shape, the
    // subtraction silently becomes a no-op and the advertised number jumps by
    // ~13 with no other signal. Fail here instead, where the cause is obvious.
    const gated = frameworkGatedToolNames();
    expect(
      gated.size,
      'no framework-gated tools found under src/tools/register — the `if (has(...))` ' +
        'gate shape in framework.ts changed; update frameworkGatedToolNames() in ' +
        'tests/docs/tool-surface.ts.',
    ).toBeGreaterThan(5);
    // A spot-check that we are matching the gate, not every tool in the file:
    // these three sit in framework.ts but outside any `if (has(...))` block.
    for (const alwaysOn of ['find_usages', 'get_call_graph', 'get_tests_for']) {
      expect(gated.has(alwaysOn), `${alwaysOn} is always registered, not framework-gated`).toBe(
        false,
      );
    }
    expect(gated.has('get_component_tree')).toBe(true);
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
    // `N → M tools` is a record of a past measurement ("TRA-239: 171 → 172
    // tools"), not a claim about the surface today — it must not drift with
    // the count, and it goes stale by definition as tools are added.
    { path: 'docs/tools-reference.md', tolerance: 5, skipLine: /\d+ → \d+ tools/ },
    { path: 'docs/quality-gates.md', tolerance: 5 },
    { path: 'CLAUDE.md', tolerance: 5, skipLine: /output_format|preset/ },
    { path: 'AGENTS.md', tolerance: 5, skipLine: /output_format|preset/ },
    { path: 'skills/README.md', tolerance: 5 },
    { path: 'skills/trace-mcp/SKILL.md', tolerance: 5, skipLine: /output_format|preset/ },
    // TRA-259: server.json is the manifest published to the MCP registry and was
    // never guarded — it still advertised "81 languages, 58 framework
    // integrations, 138 tools". docs/configuration.md was unguarded too.
    { path: 'server.json', tolerance: 5 },
    { path: 'docs/configuration.md', tolerance: 5, skipLine: /output_format|preset/ },
    // TRA-361: the install surfaces — the npm page and the Claude Code / Codex
    // plugin marketplaces — were the last unguarded copies, and every one of
    // them still advertised "60(+) framework integrations, 81 languages" while
    // server.json next to them said 87 / 80. Their `version` fields were
    // guarded (tests/plugin/manifest-sync.test.ts), their prose was not.
    { path: 'package.json', tolerance: 5 },
    { path: '.claude-plugin/plugin.json', tolerance: 5 },
    { path: '.claude-plugin/marketplace.json', tolerance: 5 },
    { path: '.codex-plugin/plugin.json', tolerance: 5 },
    { path: '.codex-plugin/marketplace.json', tolerance: 5 },
    // TRA-634: the Agent Plugins root manifest is a scanner-facing surface with
    // the same prose counts, so it drifts the same way the others did.
    { path: 'plugin.json', tolerance: 5 },
  ];

  for (const { path, tolerance, skipLine } of docs) {
    it(`${path}: every "languages" claim matches the registry (±${tolerance})`, () => {
      const text = readDoc(path);
      for (const claim of findAllClaims(/languages?/, text)) {
        if (!within(langPlugins, claim.count, tolerance)) {
          throw new Error(
            `${path} claims ${claim.count} languages; registry has ${langPlugins}. Line: "${claim.rawLine}"`,
          );
        }
      }
    });

    it(`${path}: every "frameworks/integrations" claim matches the registry (±${tolerance})`, () => {
      const text = readDoc(path);
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
      const text = readDoc(path);
      for (const claim of findAllClaims(/(?:MCP )?tools?/, text)) {
        if (skipLine?.test(claim.rawLine)) continue;
        if (!within(toolCount, claim.count, tolerance)) {
          throw new Error(
            `${path} claims ${claim.count} tools; src/tools/register/ registers ${toolCount} framework-agnostic tools. Line: "${claim.rawLine}"`,
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
    const text = readDoc('docs/comparisons.md');
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

  it('no docs page hardcodes its own tool count any more (TRA-263)', () => {
    // The per-page scans above only enforce a ±tolerance against the registry,
    // which is what let 138 / 164 / 165 / ~170 coexist. Reading all of them from
    // one data file is the part that actually keeps the pages equal.
    for (const path of ['docs/index.html', 'docs/llms.txt', 'docs/tools-reference.md']) {
      COUNT_TAG.lastIndex = 0;
      expect(
        COUNT_TAG.test(readFileSync(join(REPO_ROOT, path), 'utf-8')),
        `${path} no longer reads {{ site.data.counts.* }} — keep the number in docs/_data/counts.yml.`,
      ).toBe(true);
    }
  });

  it('docs/_data/counts.yml language and framework counts match the registry exactly (TRA-275)', () => {
    // Exact, not ±tolerance: unlike the tool count these are derived, so the
    // registry is an exact receipt (same reasoning as preset-claims.test.ts).
    expect(
      lookupCount('languages'),
      'update `languages:` in docs/_data/counts.yml — a language plugin was added or removed',
    ).toBe(langPlugins);
    expect(
      lookupCount('frameworks'),
      'update `frameworks:` in docs/_data/counts.yml — a framework plugin was added or removed',
    ).toBe(fwPlugins);
  });

  it('no docs page hardcodes its own language / framework count any more (TRA-275)', () => {
    // TRA-272 had to sweep "85 framework integrations" -> "87" across 8 files
    // (docs/index.html alone had 9 occurrences) and nothing failed in between,
    // because ±5 tolerates a whole plugin batch. These pages read the tags now.
    const pages: Array<{ path: string; keys: string[] }> = [
      { path: 'docs/index.html', keys: ['languages', 'frameworks'] },
      { path: 'docs/llms.txt', keys: ['languages', 'frameworks'] },
      { path: 'docs/llms-full.txt', keys: ['languages', 'frameworks'] },
      { path: 'docs/comparisons.md', keys: ['languages', 'frameworks'] },
      { path: 'docs/supported-frameworks.md', keys: ['languages'] },
      { path: 'docs/quality-gates.md', keys: ['languages', 'frameworks'] },
      { path: 'docs/architecture.md', keys: ['languages'] },
    ];
    for (const { path, keys } of pages) {
      const raw = readFileSync(join(REPO_ROOT, path), 'utf-8');
      for (const key of keys) {
        expect(
          raw.includes(`site.data.counts.${key}`),
          `${path} no longer reads {{ site.data.counts.${key} }} — keep the number in docs/_data/counts.yml.`,
        ).toBe(true);
      }
    }
  });

  it('front matter in docs/supported-frameworks.md still states the real counts (TRA-275)', () => {
    // Jekyll does not render Liquid inside front matter, so the page title and
    // meta description keep prose numbers. They are the only two left in docs/,
    // and they are what search results show — check them exactly.
    const frontMatter = readFileSync(
      join(REPO_ROOT, 'docs/supported-frameworks.md'),
      'utf-8',
    ).split('---')[1];
    for (const [unit, expected] of [
      [/languages?/, langPlugins],
      [/framework integrations?/, fwPlugins],
    ] as const) {
      const claims = findAllClaims(unit, frontMatter);
      expect(
        claims.length,
        `no "X ${unit.source}" claim in supported-frameworks.md front matter`,
      ).toBeGreaterThan(0);
      for (const claim of claims) {
        expect(
          claim.count,
          `docs/supported-frameworks.md front matter is stale — Liquid does not render there, ` +
            `so update the prose by hand. Line: "${claim.rawLine}"`,
        ).toBe(expected);
      }
    }
  });

  it('every {{ site.data.counts.* }} tag in docs/ resolves to a number (TRA-263)', () => {
    // Jekyll renders an unknown key as the empty string rather than failing the
    // build, so a typo would ship as "trace-mcp exposes  MCP tools".
    const broken: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(md|html|txt)$/.test(entry.name)) continue;
        for (const m of readFileSync(full, 'utf-8').matchAll(COUNT_TAG)) {
          if (typeof lookupCount(m[1]) !== 'number') broken.push(`${entry.name}: ${m[0]}`);
        }
      }
    };
    walk(join(REPO_ROOT, 'docs'));
    expect([...new Set(broken)], 'no matching key in docs/_data/counts.yml').toEqual([]);
  });

  it('every README anchor linked from skills/ still exists (TRA-393)', () => {
    // skills/README pointed at README.md#token-savings as the evidence for its
    // token claim. No such heading — the section is "Token reduction — what we
    // measured", so the link silently landed at the top of the README. An
    // evidence pointer that resolves to nothing is worse than no pointer.
    // Shell comments inside fenced blocks ("# Via CLI") also start with '#' and
    // would otherwise widen the accepted anchor set with non-headings.
    let inFence = false;
    const headings = readFileSync(README_PATH, 'utf-8')
      .split('\n')
      .filter((line) => {
        if (line.startsWith('```')) {
          inFence = !inFence;
          return false;
        }
        return !inFence && line.startsWith('#');
      })
      .map((line) =>
        line
          .replace(/^#+\s*/, '')
          .toLowerCase()
          .replace(/[^\w\s-]/g, '')
          .trim()
          .replace(/\s/g, '-'),
      );
    const skillsReadme = readFileSync(join(REPO_ROOT, 'skills/README.md'), 'utf-8');
    for (const [, anchor] of skillsReadme.matchAll(/trace-mcp#([\w-]+)/g)) {
      expect(
        headings,
        `skills/README.md links to README.md#${anchor}, which is not a heading`,
      ).toContain(anchor);
    }
  });

  /**
   * TRA-647: the PR-context benchmark (TRA-534) is the only measurement we have
   * that was taken on somebody else's code, and it lived on one page reachable
   * from the footer nav while every figure a visitor actually met came from our
   * own estimators. It now leads README.md, the homepage hero and the metrics
   * strip. Those surfaces split into two kinds and each needs the opposite
   * check: README.md is not Jekyll-rendered, so its copy is typed by hand and
   * needs a receipt against the generated data; the Jekyll pages need proof
   * that they never type it by hand at all — the same discipline
   * docs/_data/counts.yml gets above.
   */
  const BENCH = JSON.parse(
    readFileSync(join(REPO_ROOT, 'docs/_data/pr_context_bench.json'), 'utf-8'),
  ) as Record<string, unknown>;
  const BENCH_TAG = /\{\{\s*site\.data\.pr_context_bench\.([a-z0-9_.[\]]+)/gi;
  /** `losses[0].savings_pct` is a real tag on the benchmark page, so a key path
   *  has to be walked, not just its first segment. `first` / `last` / `size` are
   *  Liquid's own array accessors and resolve like Liquid resolves them, so
   *  `losses.first.savings_pct` is not reported as a typo. */
  const benchValue = (path: string): unknown =>
    path
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.')
      .reduce<unknown>((v, key) => {
        if (Array.isArray(v)) {
          if (key === 'first') return v[0];
          if (key === 'last') return v[v.length - 1];
          if (key === 'size') return v.length;
        }
        return (v as Record<string, unknown> | undefined)?.[key];
      }, BENCH);

  it('README states the benchmark headline exactly as scripts/bench-pr-context.ts generated it', () => {
    const readme = readReadme();
    const fixIt =
      're-run `npx tsx scripts/bench-pr-context.ts` and update the above-the-fold block in README.md';
    for (const [label, needle] of [
      ['median saving', `${BENCH.median_savings_pct}% fewer input tokens`],
      ['PR count', `${BENCH.pr_count} merged pull requests`],
      [
        'median token pair',
        `${(BENCH.baseline_median_tokens as number).toLocaleString('en-US')} → ${(BENCH.trace_median_tokens as number).toLocaleString('en-US')}`,
      ],
      ['method link', 'https://trace-mcp.com/pr-context-benchmark.html'],
    ] as const) {
      expect(
        readme.includes(needle),
        `README.md no longer states the ${label} ("${needle}") from docs/_data/pr_context_bench.json — ${fixIt}`,
      ).toBe(true);
    }
  });

  it('no percentage README attributes to the PR benchmark has drifted from the data', () => {
    // The headline is stated twice (above the fold and in "Token reduction —
    // what we measured"), in different sentences. Checking the exact fragment
    // above only pins the first one; this pins every line that talks about the
    // benchmark, whatever wording a later edit gives it.
    for (const line of readReadme().split('\n')) {
      if (!/pull requests?/i.test(line)) continue;
      for (const [, pct] of line.matchAll(/(\d+\.\d+)%/g)) {
        expect(
          pct,
          `README.md line claims ${pct}% about pull requests; docs/_data/pr_context_bench.json ` +
            `says ${BENCH.median_savings_pct}%. Line: "${line.trim()}"`,
        ).toBe(BENCH.median_savings_pct);
      }
    }
  });

  it('the Jekyll surfaces read the benchmark from _data instead of hardcoding it (TRA-647)', () => {
    // Asking only whether the file contains one tag *somewhere* passes as long
    // as a single tag survives: the hero could drift to a typed-in 90.6% while
    // the metrics strip keeps its tag, and this test would stay green. So strip
    // the Liquid out and assert the generated values are absent from what is
    // left — a typed-in number then has nowhere to hide, in any section.
    const typedIn = (src: string) => src.replace(/\{\{[^}]*\}\}/g, '').replace(/\{%[^%]*%\}/g, '');
    const esc = (v: unknown) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hardcoded: [string, RegExp][] = [
      // Preceded by no digit or dot, so a CSS `0.6%` or an `1890.6%` is not this.
      ['median saving', new RegExp(`(?<![\\d.])${esc(BENCH.median_savings_pct)}\\s*%`)],
      // A bare 60 is a font size; 60 counting pull requests is the benchmark.
      ['PR count', new RegExp(`\\b${esc(BENCH.pr_count)}\\s+(merged|pull requests?|PRs)`, 'i')],
      ['repo count', new RegExp(`\\b${esc(BENCH.repo_count)}\\s+open-source`, 'i')],
    ];
    for (const path of ['docs/index.html', 'docs/comparisons.md', 'docs/pr-context-benchmark.md']) {
      const src = readFileSync(join(REPO_ROOT, path), 'utf-8');
      expect(
        src.includes('site.data.pr_context_bench.'),
        `${path} no longer reads {{ site.data.pr_context_bench.* }} — the benchmark numbers are ` +
          'generated, never typed. Keep them in docs/_data/pr_context_bench.json.',
      ).toBe(true);
      for (const [label, pattern] of hardcoded) {
        const hit = typedIn(src).match(pattern);
        expect(
          hit?.[0] ?? null,
          `${path} states the ${label} outside a Liquid tag ("${hit?.[0]}"). Replace it with ` +
            '{{ site.data.pr_context_bench.* }} so re-running the benchmark updates the page.',
        ).toBe(null);
      }
    }
  });

  it('every {{ site.data.pr_context_bench.* }} tag in docs/ resolves to a key (TRA-647)', () => {
    // Jekyll renders an unknown key as the empty string rather than failing the
    // build, so a typo ships as "a median % fewer input tokens".
    const broken: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(md|html|txt)$/.test(entry.name)) continue;
        for (const m of readFileSync(full, 'utf-8').matchAll(BENCH_TAG)) {
          if (benchValue(m[1]) === undefined) broken.push(`${entry.name}: ${m[0]}`);
        }
      }
    };
    walk(join(REPO_ROOT, 'docs'));
    expect([...new Set(broken)], 'no matching key in docs/_data/pr_context_bench.json').toEqual([]);
  });

  it('llms.txt and tools-reference.md agree on the resource count', () => {
    const llms = readDoc('docs/llms.txt');
    const toolsRef = readDoc('docs/tools-reference.md');
    for (const text of [llms, toolsRef]) {
      for (const claim of findAllClaims(/resources?/, text)) {
        if (!within(resourceCount, claim.count, 2)) {
          throw new Error(
            `claims ${claim.count} resources; src/tools/register/ contains ${resourceCount} server.resource(...) registrations. Line: "${claim.rawLine}"`,
          );
        }
      }
    }
  });
});
