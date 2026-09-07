import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TWEAKCC_VERSION } from '../../src/init/tweakcc.js';

// Two surfaces where third-party code runs on someone else's behalf: GitHub
// Actions in CI, and `npx <pkg>` on a *user's* machine from `init`. Both are
// pinned today; only a manual pass kept them that way, and the npx one drifted
// undetected until TRA-1133. This is that pass, run by CI instead.

const ROOT = join(import.meta.dirname, '../..');
const WORKFLOWS = join(ROOT, '.github/workflows');

/** `owner/repo/path@ref` — a pin is a full 40-char commit SHA, never a tag. */
const SHA_PIN = /^[0-9a-f]{40}$/;

function collectUses(dir: string): { file: string; ref: string }[] {
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
      // `./path` and `owner/repo/.github/workflows/x.yml@ref` local refs are ours.
      if (m[1].startsWith('./')) continue;
      out.push({ file: full.slice(ROOT.length + 1), ref: m[1] });
    }
  }
  return out;
}

function collectTsSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsSources(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('third-party GitHub Actions are pinned to a commit SHA', () => {
  const uses = collectUses(WORKFLOWS);

  it('finds `uses:` entries to check', () => {
    expect(uses.length).toBeGreaterThan(0);
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

describe('npx invocations in src/ name an exact version', () => {
  // `npx foo` resolves `latest` at run time on the user's machine, so what
  // executes is decided after our release rather than by it. Matches a real
  // invocation (execSync/spawn string), not the word "npx" in prose — hence the
  // requirement that the token after the flags looks like a package spec.
  const NPX_CALL = /\bnpx\s+((?:--?[\w-]+\s+)*)([@\w][^\s'"`$)]*)/g;

  // ponytail: comments are stripped by regex, not parsed. A `//` inside a
  // string literal would blind the rest of that line; no src/ file relies on
  // that today, and the alternative is a TS parse per file at test time.
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const offenders: string[] = [];
  for (const file of collectTsSources(join(ROOT, 'src'))) {
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(NPX_CALL)) {
      const spec = m[2];
      // Our own CLI name in help text, and probes that cannot install.
      if (spec.startsWith('trace-mcp') || spec.startsWith('trace')) continue;
      if (/(^|\s)--no-install(\s|$)/.test(m[1])) continue;
      // `npx -y ${TWEAKCC_SPEC}` — a template hole is a pin by construction.
      if (spec.startsWith('${')) continue;
      const name = spec.replace(/^@[^/]+\//, '');
      if (!name.includes('@')) offenders.push(`${file.slice(ROOT.length + 1)}: npx ${spec}`);
    }
  }

  it('has no unpinned npx call', () => {
    expect(offenders, `unpinned npx spec(s):\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('tweakcc pin is declared in package.json', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  // An optional peerDependency is the honest section: we execute tweakcc but do
  // not require it, and unlike optionalDependencies it is not installed for
  // every trace-mcp user (tweakcc pulls native oxfmt/node-lief). Declaring it
  // is what puts it in the dependency graph, the release SBOM and dependabot.
  it('declares tweakcc as an optional peer dependency at the executed version', () => {
    expect(pkg.peerDependencies?.tweakcc).toBe(TWEAKCC_VERSION);
    expect(pkg.peerDependenciesMeta?.tweakcc?.optional).toBe(true);
  });
});
