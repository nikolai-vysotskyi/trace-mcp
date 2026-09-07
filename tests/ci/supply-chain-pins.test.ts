import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TWEAKCC_VERSION } from '../../src/init/tweakcc.js';

// Two surfaces where third-party code runs on someone else's behalf: GitHub
// Actions in CI, and `npx <pkg>` on a *user's* machine from `init`. Both are
// pinned today; only a manual pass kept them that way, and the npx one drifted
// undetected until TRA-1133. This is that pass, run by CI instead.

const ROOT = join(import.meta.dirname, '../..');

/** `owner/repo/path@ref` — a pin is a full 40-char commit SHA, never a tag. */
const SHA_PIN = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// GitHub Actions
// ---------------------------------------------------------------------------

function collectUses(dir: string): { file: string; ref: string }[] {
  if (!existsSync(dir)) return [];
  const out: { file: string; ref: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectUses(full));
      continue;
    }
    if (!/\.ya?ml$/.test(entry.name)) continue;
    for (const line of readFileSync(full, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:-\s*)?uses:\s*['"]?([^'"\s#]+)/);
      if (!m) continue;
      // `./path` local refs are our own code, versioned by the same commit.
      if (m[1].startsWith('./')) continue;
      out.push({ file: full.slice(ROOT.length + 1), ref: m[1] });
    }
  }
  return out;
}

describe('third-party GitHub Actions are pinned to a commit SHA', () => {
  // Both trees: `.github/actions/**` holds composite actions, which invoke
  // third-party actions of their own (`setup-pnpm` uses `actions/cache`) and
  // are just as reachable from CI as a workflow is.
  const uses = [
    ...collectUses(join(ROOT, '.github/workflows')),
    ...collectUses(join(ROOT, '.github/actions')),
  ];

  it('finds `uses:` entries in both .github/workflows and .github/actions', () => {
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.some((u) => u.file.startsWith('.github/workflows/'))).toBe(true);
    expect(uses.some((u) => u.file.startsWith('.github/actions/'))).toBe(true);
  });

  it.each(uses)('$file: $ref', ({ file, ref }) => {
    const at = ref.lastIndexOf('@');
    expect(at, `${file}: \`uses: ${ref}\` has no @ref at all`).toBeGreaterThan(0);
    expect(
      SHA_PIN.test(ref.slice(at + 1)),
      `${file}: \`uses: ${ref}\` is pinned to a mutable tag/branch, not a 40-char commit SHA`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// npx
// ---------------------------------------------------------------------------

/**
 * `npx foo` resolves `latest` at run time on the *user's* machine, so what
 * executes is decided after our release rather than by it.
 *
 * Scanning is over string and template literals recovered from the TypeScript
 * AST, not over raw text: a first cut used a regex with a comment stripper and
 * a review showed it both missing real invocations (`npx -y ${SPEC}`, because
 * the spec was interpolated) and being blindable by a `//` inside a string
 * literal. The parser has neither problem — comments are not literals, and an
 * interpolation is a distinguishable node rather than a character sequence.
 *
 * Interpolated specs are pinned only if the hole is a constant we control:
 * `${TWEAKCC_SPEC}` is a pin by construction, `${somePackageFromConfig}` is
 * exactly the hazard this gate exists for.
 */
const PINNED_INTERPOLATIONS = new Set(['TWEAKCC_SPEC']);

/**
 * What a package spec can look like: `pkg`, `pkg@1.2.3`, `@scope/pkg@1.2.3`, or
 * a whole-token interpolation. Anything else after `npx` is prose.
 */
const SPEC_SHAPE = /^(\$\{\w+\}|@?[\w.-]+(\/[\w.-]+)?(@[^\s]+)?)$/;

/** Our own CLI, appearing in help text — not third-party code. */
const OWN_PACKAGES = new Set(['trace', 'trace-mcp']);

export function findUnpinnedNpx(source: string, fileName = 'probe.ts'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const offenders: string[] = [];

  const check = (text: string) => {
    // `npx` must stand as its own word — `npx/uvx` in prose is not a call.
    for (const m of text.matchAll(/\bnpx(?=[\s'"`]|$)([^\n]*)/g)) {
      const spec = extractSpec(m[1]);
      // Not spec-shaped: prose that merely contains the word npx, e.g.
      // "auto-installs tweakcc via npx (recommended)".
      if (spec === null || !SPEC_SHAPE.test(spec)) continue;
      if (!isPinned(spec)) offenders.push(`npx ${spec}`);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) check(node.text);
    else if (ts.isTemplateExpression(node)) check(templateText(node));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return offenders;
}

/** Render a template literal with each hole as `${identifierOrExpr}`. */
function templateText(node: ts.TemplateExpression): string {
  let out = node.head.text;
  for (const span of node.templateSpans) {
    const expr = span.expression;
    out += `\${${ts.isIdentifier(expr) ? expr.text : '?'}}`;
    out += span.literal.text;
  }
  return out;
}

/**
 * The package spec an `npx` invocation would execute, or null when the line
 * carries no spec at all (`npx` alone, or only flags).
 */
function extractSpec(rest: string): string | null {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    // `--package=<spec>` / `-p <spec>` name the package explicitly, and npx
    // then runs a *command* name that is not the package — read the spec here.
    if (tok.startsWith('--package=')) return tok.slice('--package='.length);
    if (tok === '--package' || tok === '-p') return tokens[i + 1] ?? null;
    if (tok.startsWith('-')) continue;
    // Strip markdown/punctuation the spec is quoted with when it appears
    // inside a user-facing message: "run `npx -y tweakcc@4.3.3` manually".
    return tok.replace(/[`'",.;:)]+$/, '');
  }
  return null;
}

function isPinned(spec: string): boolean {
  const interpolated = spec.match(/^\$\{(.+)\}$/);
  if (interpolated) return PINNED_INTERPOLATIONS.has(interpolated[1]);
  // Any hole in the middle of a spec (`tweakcc@${v}`, `${name}@1.0.0`) leaves
  // part of what executes decided elsewhere — not a pin as far as this gate is
  // concerned. Whitelist it above if a case ever justifies it.
  if (spec.includes('${')) return false;

  const bare = spec.replace(/^@[^/]+\//, ''); // drop a leading npm scope
  if (OWN_PACKAGES.has(bare.split('@')[0])) return true;
  return bare.includes('@');
}

describe('findUnpinnedNpx', () => {
  const flags = (s: string) => findUnpinnedNpx(s);

  it('flags a bare package', () => {
    expect(flags(`execSync('npx tweakcc --apply')`)).toEqual(['npx tweakcc']);
  });

  it('accepts an explicit version, scoped or not', () => {
    expect(flags(`execSync('npx -y tweakcc@4.3.3 --apply')`)).toEqual([]);
    expect(flags(`execSync('npx @scope/pkg@1.2.3')`)).toEqual([]);
  });

  it('accepts the constant we control as an interpolation, and only that one', () => {
    expect(flags('execSync(`npx -y ${TWEAKCC_SPEC} --apply`)')).toEqual([]);
    expect(flags('execSync(`npx -y ${packageFromConfig} --apply`)')).toEqual([
      'npx ${packageFromConfig}',
    ]);
    expect(flags('execSync(`npx -y tweakcc@${version}`)')).toEqual(['npx tweakcc@${version}']);
  });

  it('reads the spec out of --package/-p rather than the command name', () => {
    expect(flags(`execSync('npx --package=tweakcc tweakcc-apply')`)).toEqual(['npx tweakcc']);
    expect(flags(`execSync('npx -p tweakcc@4.3.3 tweakcc-apply')`)).toEqual([]);
  });

  it('ignores prose in comments, and is not blinded by a // inside a string', () => {
    expect(flags(`// run npx tweakcc manually\n/* or npx tweakcc --apply */`)).toEqual([]);
    expect(flags(`const url = 'https://example.com'; execSync('npx tweakcc');`)).toEqual([
      'npx tweakcc',
    ]);
  });

  it('ignores our own CLI in help text', () => {
    expect(flags(`console.log('   npx trace-mcp init')`)).toEqual([]);
  });

  it('ignores prose that merely contains the word npx', () => {
    expect(flags(`const hint = 'auto-installs tweakcc via npx (recommended)';`)).toEqual([]);
    expect(flags(`const s = 'launched via npx/uvx by the client';`)).toEqual([]);
  });

  it('sees through the markdown quoting of a user-facing message', () => {
    expect(flags('const d = `run \\`npx -y ${TWEAKCC_SPEC}\\` manually`;')).toEqual([]);
    expect(flags('const d = `run \\`npx tweakcc\\` manually`;')).toEqual(['npx tweakcc']);
  });
});

describe('npx invocations in src/ name an exact version', () => {
  function collectTsSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...collectTsSources(full));
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  const files = collectTsSources(join(ROOT, 'src'));
  const offenders = files.flatMap((file) =>
    findUnpinnedNpx(readFileSync(file, 'utf8'), file).map(
      (o) => `${file.slice(ROOT.length + 1)}: ${o}`,
    ),
  );

  it('finds sources to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('has no unpinned npx call', () => {
    expect(offenders, `unpinned npx spec(s):\n${offenders.join('\n')}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe('tweakcc pin is declared in package.json', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  // Declaring it is what puts it in the dependency graph, and therefore in the
  // release SBOM and dependabot's scope. `devDependencies` and not an optional
  // peer: an exact optional peer is still a compatibility constraint, so a
  // consumer that already had another tweakcc would hit `ERESOLVE` installing
  // trace-mcp over a package trace-mcp does not require at runtime.
  it('pins tweakcc in devDependencies at the version init executes', () => {
    expect(pkg.devDependencies?.tweakcc).toBe(TWEAKCC_VERSION);
  });

  it('does not constrain consumers with it', () => {
    expect(pkg.dependencies?.tweakcc).toBeUndefined();
    expect(pkg.optionalDependencies?.tweakcc).toBeUndefined();
    expect(pkg.peerDependencies?.tweakcc).toBeUndefined();
  });
});
