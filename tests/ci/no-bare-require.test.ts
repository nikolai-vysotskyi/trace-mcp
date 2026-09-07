/**
 * The gate for TRA-1090: `get_context_bundle` read symbol bodies through a bare
 * `require('node:fs')`. The shipped bundle has a `createRequire` banner and
 * vitest injects `require` into every module it transforms, so both places
 * worked — but the package is `"type": "module"`, and any consumer that imports
 * `src/` as real ESM (tsx, node --loader, the benchmarks) got a ReferenceError
 * straight into a silent catch. The PR-context benchmark ran that path for
 * three months and measured a context with no source code in it at all.
 *
 * No unit test can catch this class, because the only two runtimes we test in
 * both define `require`. A static rule is the gate. It is also the second time:
 * TRA-542 was the same defect in `dropDecisionRows`.
 *
 * Anything genuinely resolved at runtime (native bindings, optional deps, a
 * lazily loaded sibling module) is allowlisted below, and each entry must state
 * why an `import` will not do.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const BARE_REQUIRE = /(?:^|[^.\w])require\s*\(/;

/** file:line-independent — a require survives here only with a stated reason. */
const ALLOWED: Record<string, string> = {
  'src/ai/vec-extension.ts': 'sqlite-vec is optional; a static import breaks builds without it',
  'src/session/providers/sqlite-source.ts': 'better-sqlite3 native binding, loaded lazily',
  'src/daemon/project-artifacts.ts': 'topology-db is loaded lazily to keep daemon startup cheap',
  'src/cli/install-app.ts': 'reads package.json version at runtime, not a module import',
};

describe('no bare require() in src/', () => {
  it('every require is either an ESM import or an allowlisted runtime load', () => {
    const files = (readdirSync('src', { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts') && !f.includes('__tests__'))
      .map((f) => `src/${f}`);
    expect(files.length).toBeGreaterThan(100); // the glob itself must not silently match nothing

    const offenders: string[] = [];
    for (const file of files) {
      if (ALLOWED[file]) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const code = line.trim();
          if (code.startsWith('*') || code.startsWith('//')) return; // prose, incl. this rule's own docs
          if (code.includes('createRequire')) return; // the explicit, working form
          // Language plugins and the SBOM reader carry "require(" inside string
          // literals; strip literals so the rule reads code, not data.
          const bare = code.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''");
          if (BARE_REQUIRE.test(bare)) offenders.push(`${file}:${i + 1}  ${code}`);
        });
    }

    expect(
      offenders,
      'A bare require() throws ReferenceError under real ESM and is usually swallowed\n' +
        'by a catch, so the failure shows up as missing data rather than an error (TRA-1090,\n' +
        'TRA-542). Use a top-level import; if the module must be resolved at runtime, add the\n' +
        'file to ALLOWED in this test with the reason.\n\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
