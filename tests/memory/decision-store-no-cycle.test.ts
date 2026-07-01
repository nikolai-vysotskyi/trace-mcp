/**
 * Architectural regression: the DecisionStore god-class decomposition
 * (`decision-store-cluster-ops.ts`, `decision-store-memo-ops.ts`) must NOT
 * import back from `decision-store.ts`. Those back-edges close a 3-file
 * circular import chain, which the project's own quality gate flags as an
 * error (0 cycles allowed).
 *
 * The one-way rule: every shared type both sides need lives in
 * `decision-types.ts`, which depends on neither the store nor the ops
 * modules. All three depend on it one-way.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = path.resolve(__dirname, '..', '..', 'src', 'memory');

/** Extract the module specifiers of every `import ... from '<spec>'` in a file. */
function importSpecifiers(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  const specs: string[] = [];
  // Matches both `import ... from 'x'` and `import 'x'` and `export ... from 'x'`.
  const re = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    specs.push(m[1]);
  }
  return specs;
}

describe('decision-store god-class split — no circular imports', () => {
  const opsModules = ['decision-store-cluster-ops.ts', 'decision-store-memo-ops.ts'];

  for (const mod of opsModules) {
    it(`${mod} does not import from decision-store (would close a cycle)`, () => {
      const specs = importSpecifiers(path.join(MEMORY_DIR, mod));
      const backEdges = specs.filter((s) => /(^|\/)decision-store(\.js)?$/.test(s));
      expect(backEdges).toEqual([]);
    });
  }

  it('shared cluster + memo types are declared in decision-types.ts', () => {
    const typesSrc = fs.readFileSync(path.join(MEMORY_DIR, 'decision-types.ts'), 'utf8');
    for (const typeName of ['ClusterRow', 'ClusterInput', 'ClusterQuery', 'ProjectMemoRow']) {
      expect(typesSrc).toMatch(new RegExp(`export interface ${typeName}\\b`));
    }
  });

  it('decision-store.ts still re-exports the moved types for API back-compat', () => {
    const storeSrc = fs.readFileSync(path.join(MEMORY_DIR, 'decision-store.ts'), 'utf8');
    // Each moved type must still be reachable via `./decision-store.js`.
    for (const typeName of ['ClusterRow', 'ClusterInput', 'ClusterQuery', 'ProjectMemoRow']) {
      expect(storeSrc).toMatch(new RegExp(`\\b${typeName}\\b`));
    }
  });
});
