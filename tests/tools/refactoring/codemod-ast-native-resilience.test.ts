/**
 * Regression: a missing/broken `@ast-grep/napi` native binding must NOT crash
 * the process at import time or when `astLangForFile` is called.
 *
 * Real-world trigger: npm intermittently fails to install the optional
 * platform-specific `@ast-grep/napi-<platform>` package (npm/cli#4828). When
 * that happens, the previous implementation used a top-level
 * `import { Lang, parse } from '@ast-grep/napi'` plus an eagerly-evaluated
 * `EXT_TO_LANG` map (`Lang.TypeScript`). Merely importing `codemod-ast.ts`
 * threw "Cannot find native binding", which propagated up through the tool
 * registry and took the ENTIRE MCP server down at startup — not just the AST
 * codemod path.
 *
 * Contract these tests pin:
 *   - the module is importable even when the binding is unavailable
 *   - `astLangForFile()` returns `null` (→ callers fall back to regex) instead
 *     of throwing when the binding is unavailable
 *   - `isAstEngineAvailable()` reports availability truthfully
 *   - the pure helpers (`looksLikeAstPattern`) never depend on the binding
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  __setAstGrepLoaderForTests,
  astLangForFile,
  isAstEngineAvailable,
  looksLikeAstPattern,
} from '../../../src/tools/refactoring/codemod-ast.js';

describe('codemod-ast native-binding resilience', () => {
  afterEach(() => {
    // Always restore the real loader so we don't poison sibling tests.
    __setAstGrepLoaderForTests(null);
  });

  it('does not throw at import time (module already loaded above)', () => {
    // If the top-level import threw, this file would never have executed.
    expect(typeof astLangForFile).toBe('function');
    expect(typeof isAstEngineAvailable).toBe('function');
  });

  it('astLangForFile returns null (no throw) when the native binding is unavailable', () => {
    __setAstGrepLoaderForTests(() => {
      throw new Error('Cannot find native binding. npm has a bug related to optional dependencies');
    });
    // Must degrade, not throw — callers treat null as "use the regex engine".
    expect(() => astLangForFile('foo.ts')).not.toThrow();
    expect(astLangForFile('foo.ts')).toBeNull();
    expect(astLangForFile('foo.tsx')).toBeNull();
    expect(isAstEngineAvailable()).toBe(false);
  });

  it('astLangForFile resolves a Lang when the binding IS available (real napi)', () => {
    // Default loader (real @ast-grep/napi) — present in this repo.
    expect(isAstEngineAvailable()).toBe(true);
    expect(astLangForFile('foo.ts')).not.toBeNull();
    expect(astLangForFile('foo.tsx')).not.toBeNull();
    // Unsupported extension is null regardless of binding availability.
    expect(astLangForFile('foo.py')).toBeNull();
  });

  it('looksLikeAstPattern is a pure helper independent of the native binding', () => {
    __setAstGrepLoaderForTests(() => {
      throw new Error('Cannot find native binding');
    });
    // Pattern classification must work with no binding (used to decide engine).
    expect(looksLikeAstPattern('foo($$$ARGS)')).toBe(true);
    expect(looksLikeAstPattern('\\bfoo\\b')).toBe(false);
  });
});
