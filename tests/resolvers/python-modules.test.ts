import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PyModuleResolver } from '../../src/indexer/resolvers/python-modules.js';

/** Create a file (and all parent dirs) with empty content. */
function touch(base: string, relPath: string): void {
  const full = join(base, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, '');
}

describe('PyModuleResolver', () => {
  let root: string;

  beforeEach(() => {
    root = join(
      tmpdir(),
      'pymod-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    );
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ---------- basic module resolution ----------

  it('resolves simple module to .py file', () => {
    touch(root, 'myapp/utils.py');
    const resolver = new PyModuleResolver(root);
    expect(resolver.resolve('myapp.utils')).toBe('myapp/utils.py');
  });

  it('resolves nested dotted module', () => {
    touch(root, 'myapp/models/user.py');
    const resolver = new PyModuleResolver(root);
    expect(resolver.resolve('myapp.models.user')).toBe('myapp/models/user.py');
  });

  // ---------- package resolution (__init__.py) ----------

  it('resolves package to __init__.py', () => {
    touch(root, 'myapp/models/__init__.py');
    const resolver = new PyModuleResolver(root);
    expect(resolver.resolve('myapp.models')).toBe('myapp/models/__init__.py');
  });

  it('prefers .py file over __init__.py when both exist', () => {
    touch(root, 'myapp/models.py');
    touch(root, 'myapp/models/__init__.py');
    const resolver = new PyModuleResolver(root);
    // .py file is tried first
    expect(resolver.resolve('myapp.models')).toBe('myapp/models.py');
  });

  it('falls back to __init__.py when .py does not exist', () => {
    touch(root, 'myapp/models/__init__.py');
    // no myapp/models.py
    const resolver = new PyModuleResolver(root);
    expect(resolver.resolve('myapp.models')).toBe('myapp/models/__init__.py');
  });

  // ---------- relative imports ----------

  it('resolves single-dot relative import (.utils)', () => {
    touch(root, 'myapp/models/utils.py');
    const resolver = new PyModuleResolver(root);
    const result = resolver.resolveRelative(1, 'utils', 'myapp/models/user.py');
    expect(result).toBe('myapp/models/utils.py');
  });

  it('resolves double-dot relative import (..utils)', () => {
    touch(root, 'myapp/utils.py');
    const resolver = new PyModuleResolver(root);
    const result = resolver.resolveRelative(2, 'utils', 'myapp/models/user.py');
    expect(result).toBe('myapp/utils.py');
  });

  it('resolves relative import to package __init__.py', () => {
    touch(root, 'myapp/models/__init__.py');
    const resolver = new PyModuleResolver(root);
    const result = resolver.resolveRelative(1, null, 'myapp/models/user.py');
    expect(result).toBe('myapp/models/__init__.py');
  });

  it('resolves dotted relative import (.sub.module)', () => {
    touch(root, 'myapp/models/sub/module.py');
    const resolver = new PyModuleResolver(root);
    const result = resolver.resolveRelative(1, 'sub.module', 'myapp/models/user.py');
    expect(result).toBe('myapp/models/sub/module.py');
  });

  // ---------- src/ layout detection ----------

  it('detects src/ layout and resolves through it', () => {
    touch(root, 'src/myapp/__init__.py');
    touch(root, 'src/myapp/core.py');
    const resolver = new PyModuleResolver(root);
    expect(resolver.getSourceRoots()).toContain('src');
    expect(resolver.resolve('myapp.core')).toBe('src/myapp/core.py');
  });

  it('does not add src/ if it has no packages', () => {
    // src/ exists but has no __init__.py in subdirs
    mkdirSync(join(root, 'src/data'), { recursive: true });
    writeFileSync(join(root, 'src/data/file.txt'), '');
    const resolver = new PyModuleResolver(root);
    expect(resolver.getSourceRoots()).not.toContain('src');
  });

  // ---------- pyproject.toml detection ----------

  it('reads source roots from pyproject.toml setuptools config', () => {
    mkdirSync(join(root, 'lib/myapp'), { recursive: true });
    touch(root, 'lib/myapp/__init__.py');
    touch(root, 'lib/myapp/core.py');

    writeFileSync(
      join(root, 'pyproject.toml'),
      `[tool.setuptools.packages.find]\nwhere = ["lib"]\n`,
    );

    const resolver = new PyModuleResolver(root);
    expect(resolver.getSourceRoots()).toContain('lib');
    expect(resolver.resolve('myapp.core')).toBe('lib/myapp/core.py');
  });

  it('reads source roots from pyproject.toml poetry packages config', () => {
    mkdirSync(join(root, 'src/myapp'), { recursive: true });
    touch(root, 'src/myapp/__init__.py');
    touch(root, 'src/myapp/api.py');

    writeFileSync(
      join(root, 'pyproject.toml'),
      `[tool.poetry]\nname = "myapp"\npackages = [{include = "myapp", from = "src"}]\n`,
    );

    const resolver = new PyModuleResolver(root);
    expect(resolver.getSourceRoots()).toContain('src');
    expect(resolver.resolve('myapp.api')).toBe('src/myapp/api.py');
  });

  // ---------- explicit config ----------

  it('uses explicit sourceRoots from config', () => {
    touch(root, 'custom/pkg/mod.py');
    const resolver = new PyModuleResolver(root, { sourceRoots: ['custom'] });
    expect(resolver.getSourceRoots()).toEqual(['custom']);
    expect(resolver.resolve('pkg.mod')).toBe('custom/pkg/mod.py');
  });

  // ---------- unresolved / external ----------

  it('returns null for unresolved external module', () => {
    const resolver = new PyModuleResolver(root);
    expect(resolver.resolve('numpy.array')).toBeNull();
  });

  it('returns null for unresolved relative import', () => {
    const resolver = new PyModuleResolver(root);
    const result = resolver.resolveRelative(1, 'nonexistent', 'myapp/models/user.py');
    expect(result).toBeNull();
  });

  // ---------- source root always includes project root ----------

  it('always includes project root (.) as fallback', () => {
    const resolver = new PyModuleResolver(root);
    expect(resolver.getSourceRoots()).toContain('.');
  });

  // ---------- edge cases ----------

  it('handles top-level module (single part)', () => {
    touch(root, 'utils.py');
    const resolver = new PyModuleResolver(root);
    expect(resolver.resolve('utils')).toBe('utils.py');
  });

  it('handles top-level package', () => {
    touch(root, 'utils/__init__.py');
    const resolver = new PyModuleResolver(root);
    expect(resolver.resolve('utils')).toBe('utils/__init__.py');
  });
});
