import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import ts from 'typescript';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { TWEAKCC_VERSION } from '../../src/init/tweakcc.js';

// Two surfaces where third-party code runs on someone else's behalf: GitHub
// Actions in CI, and `npx <pkg>` on a *user's* machine from `init`. Both are
// pinned today; only a manual pass kept them that way, and the npx one drifted
// undetected until TRA-1133. This is that pass, run by CI instead.

const ROOT = join(import.meta.dirname, '../..');

/** Repo-relative, forward-slashed — the assertions below compare path prefixes,
 * and on Windows `join` hands back backslashes. */
const rel = (full: string) =>
  full
    .slice(ROOT.length + 1)
    .split(sep)
    .join('/');

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
    // Parsed, not line-matched: a review showed `steps: [{ uses: x@main }]`
    // slipping past a `^\s*uses:` regex, and a folded scalar would do the same.
    // The parser sees the same `uses` GitHub does, whatever the YAML style.
    const doc = YAML.parse(readFileSync(full, 'utf8'));
    for (const ref of collectUsesValues(doc)) {
      // `./path` local refs are our own code, versioned by the same commit.
      if (ref.startsWith('./')) continue;
      out.push({ file: rel(full), ref });
    }
  }
  return out;
}

/** Every `uses:` value anywhere in a parsed workflow/action document. */
function collectUsesValues(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(collectUsesValues);
  if (node === null || typeof node !== 'object') return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'uses' && typeof value === 'string') out.push(value.trim());
    else out.push(...collectUsesValues(value));
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

  it('reads uses: out of flow-style YAML, not just line starts', () => {
    const doc = YAML.parse('runs: { using: composite, steps: [{ uses: actions/checkout@main }] }');
    expect(collectUsesValues(doc)).toEqual(['actions/checkout@main']);
  });

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

/**
 * A spec assembled at run time is never a pin, wherever the hole sits —
 * `${pkg}`, `${cfg.package}`, `${name}@1.0.0`, `'npx ' + pkg`. Reaching
 * `isPinned` matters: `SPEC_SHAPE` used to reject these as prose *before* the
 * policy could reject them as unpinned, which is a pass, not a rejection.
 */
const DYNAMIC = /\$\{/;

/**
 * Our own package, appearing in help text — not third-party code. Only the
 * package name: `trace` is the *binary* alias, and `npx trace` would resolve
 * the unrelated registry package of that name, so exempting it would license
 * silent third-party execution.
 */
const OWN_PACKAGES = new Set(['trace-mcp']);

/**
 * npx flags that take no value. The list is an allowlist on purpose: an
 * unrecognized flag may consume the next token (`--cache <dir>` does), which
 * means the scanner cannot prove which token is the package — and a scanner
 * that cannot prove it must fail closed, not guess and drop the line as prose.
 */
const BOOLEAN_FLAGS = new Set([
  '-y',
  '--yes',
  '--no',
  '--no-install',
  '-q',
  '--quiet',
  '--silent',
  '--offline',
  '--prefer-offline',
  '--prefer-online',
  '--ignore-existing',
  '-h',
  '--help',
  '-v',
  '--version',
]);

/**
 * A spec that does not name a registry release: `github:owner/repo` tracks a
 * mutable default branch, and the URL/file forms are outside anything we can
 * pin here. None exist today; if one is ever justified, decide its immutable
 * form (a 40-char commit for `github:`) and whitelist it deliberately.
 */
const NON_REGISTRY = /^[a-z][a-z+.-]*:/i;

export function findUnpinnedNpx(source: string, fileName = 'probe.ts'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const offenders: string[] = [];

  const check = (text: string) => {
    // `npx` must stand as its own word — `npx/uvx` in prose is not a call.
    for (const m of text.matchAll(/\bnpx(?=[\s'"`]|$)([^\n]*)/g)) {
      const scan = extractSpec(m[1]);
      if (scan.kind === 'none') continue;
      if (scan.kind === 'unprovable') {
        offenders.push(`npx ${scan.token} … (unrecognized option — spec unprovable)`);
        continue;
      }
      const { spec } = scan;
      if (NON_REGISTRY.test(spec)) {
        offenders.push(`npx ${spec}`);
        continue;
      }
      // Not spec-shaped: prose that merely contains the word npx, e.g.
      // "auto-installs tweakcc via npx (recommended)".
      if (!DYNAMIC.test(spec) && !SPEC_SHAPE.test(spec)) continue;
      if (!isPinned(spec)) offenders.push(`npx ${spec}`);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || isConcat(node)) {
      check(flattenText(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return offenders;
}

function isConcat(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

/**
 * Render a literal, a template, or a `+` concatenation as one string, with each
 * run-time hole spelled `${name}` — `${dynamic}` when the expression is not a
 * plain identifier. Concatenation matters because `'npx ' + pkg` visits only the
 * literal `'npx '`, which carries no spec and used to pass.
 */
function flattenText(node: ts.Node): string {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      out += `\${${ts.isIdentifier(span.expression) ? span.expression.text : 'dynamic'}}`;
      out += span.literal.text;
    }
    return out;
  }
  if (isConcat(node)) return flattenText(node.left) + flattenText(node.right);
  if (ts.isIdentifier(node)) return `\${${node.text}}`;
  return '${dynamic}';
}

type SpecScan =
  | { kind: 'none' }
  | { kind: 'unprovable'; token: string }
  | { kind: 'spec'; spec: string };

/** The package spec an `npx` invocation would execute. */
function extractSpec(rest: string): SpecScan {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    // `--package=<spec>` / `-p <spec>` name the package explicitly, and npx
    // then runs a *command* name that is not the package — read the spec here.
    if (tok.startsWith('--package=')) return { kind: 'spec', spec: tok.slice(10) };
    if (tok === '--package' || tok === '-p') {
      const next = tokens[i + 1];
      return next ? { kind: 'spec', spec: next } : { kind: 'none' };
    }
    if (tok.startsWith('-')) {
      if (BOOLEAN_FLAGS.has(tok) || tok.includes('=')) continue;
      return { kind: 'unprovable', token: tok };
    }
    // Strip markdown/punctuation the spec is quoted with when it appears
    // inside a user-facing message: "run `npx -y tweakcc@4.3.3` manually".
    return { kind: 'spec', spec: tok.replace(/[`'",.;)]+$/, '') };
  }
  return { kind: 'none' };
}

/**
 * An exact release, and nothing else. `@latest`, `@next`, `@^4`, `@*` all leave
 * the registry deciding what runs, which is the whole finding — "has an `@`"
 * was the first cut and it accepted every one of them.
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function isPinned(spec: string): boolean {
  const interpolated = spec.match(/^\$\{(.+)\}$/);
  if (interpolated) return PINNED_INTERPOLATIONS.has(interpolated[1]);
  // A hole anywhere else in the spec (`tweakcc@${v}`, `${name}@1.0.0`) leaves
  // part of what executes decided elsewhere.
  if (DYNAMIC.test(spec)) return false;

  const bare = spec.replace(/^@[^/]+\//, ''); // drop a leading npm scope
  const at = bare.indexOf('@');
  if (OWN_PACKAGES.has(at === -1 ? bare : bare.slice(0, at))) return true;
  return at > 0 && EXACT_VERSION.test(bare.slice(at + 1));
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

  it('ignores prose that merely contains the word npx', () => {
    expect(flags(`const hint = 'auto-installs tweakcc via npx (recommended)';`)).toEqual([]);
    expect(flags(`const s = 'launched via npx/uvx by the client';`)).toEqual([]);
  });

  it('rejects mutable tags and ranges, not just a missing @', () => {
    expect(flags(`execSync('npx tweakcc@latest --version')`)).toEqual(['npx tweakcc@latest']);
    expect(flags(`execSync('npx tweakcc@next')`)).toEqual(['npx tweakcc@next']);
    expect(flags(`execSync('npx tweakcc@^4')`)).toEqual(['npx tweakcc@^4']);
    expect(flags(`execSync('npx tweakcc@*')`)).toEqual(['npx tweakcc@*']);
    expect(flags(`execSync('npx tweakcc@4.3.3-rc.1')`)).toEqual([]);
  });

  it('flags a dynamic spec however it is assembled', () => {
    expect(flags('execSync(`npx -y ${config.package} --version`)')).toEqual(['npx ${dynamic}']);
    expect(flags(`execSync('npx ' + packageFromConfig)`)).toEqual(['npx \${packageFromConfig}']);
    expect(flags('execSync(`npx ${name}@1.0.0`)')).toEqual(['npx ${name}@1.0.0']);
  });

  it('fails closed on an option it cannot prove is valueless', () => {
    // `--cache <dir>` eats the next token; the package is the one after it.
    expect(flags(`execSync('npx --cache /tmp/c unversioned-package --version')`)).toEqual([
      'npx --cache … (unrecognized option — spec unprovable)',
    ]);
    expect(flags(`execSync('npx --cache=/tmp/c pkg@1.0.0')`)).toEqual([]);
  });

  it('rejects specs that do not name a registry release', () => {
    expect(flags(`execSync('npx github:example/pkg --version')`)).toEqual([
      'npx github:example/pkg',
    ]);
    expect(flags(`execSync('npx file:../pkg')`)).toEqual(['npx file:../pkg']);
  });

  it('does not exempt the `trace` binary alias — that is someone else on npm', () => {
    expect(flags(`execSync('npx trace --version')`)).toEqual(['npx trace']);
    expect(flags(`console.log('   npx trace-mcp init')`)).toEqual([]);
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
    findUnpinnedNpx(readFileSync(file, 'utf8'), file).map((o) => `${rel(file)}: ${o}`),
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
