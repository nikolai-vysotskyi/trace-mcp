import { describe, it, expect } from 'vitest';
import { TomlLanguagePlugin } from '../../src/indexer/plugins/language/toml/index.js';

const plugin = new TomlLanguagePlugin();

async function parse(source: string, filePath = 'settings.toml') {
  const result = await plugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('TomlLanguagePlugin', () => {
  // ── Manifest ──

  it('has correct manifest', () => {
    expect(plugin.manifest.name).toBe('toml-language');
    expect(plugin.supportedExtensions).toContain('.toml');
  });

  // ── Generic TOML ──

  describe('generic', () => {
    it('extracts [table] as namespace and key=value as constant', async () => {
      const r = await parse('[database]\nhost = "localhost"\nport = 5432\n\n[logging]\nlevel = "debug"');
      expect(r.metadata?.dialect).toBe('generic');
      expect(r.symbols.some(s => s.name === 'database' && s.kind === 'namespace')).toBe(true);
      expect(r.symbols.some(s => s.name === 'host' && s.kind === 'constant')).toBe(true);
      expect(r.symbols.some(s => s.name === 'port' && s.kind === 'constant')).toBe(true);
      expect(r.symbols.some(s => s.name === 'logging' && s.kind === 'namespace')).toBe(true);
      expect(r.symbols.some(s => s.name === 'level' && s.kind === 'constant')).toBe(true);
    });

    it('handles empty file', async () => {
      const r = await parse('');
      expect(r.symbols).toHaveLength(0);
    });
  });

  // ── Cargo.toml ──

  describe('cargo', () => {
    it('extracts package name, dependencies as imports, [[bin]] names, and feature keys', async () => {
      const r = await parse(
        `[package]
name = "my-crate"
version = "0.1.0"

[dependencies]
serde = "1.0"
tokio = "1.0"

[dev-dependencies]
criterion = "0.5"

[features]
default = ["serde"]
full = ["serde", "tokio"]

[[bin]]
name = "my-binary"`,
        'Cargo.toml',
      );

      expect(r.metadata?.dialect).toBe('cargo');
      // package name and version
      expect(r.symbols.some(s => s.name === 'name' && s.metadata?.tomlKind === 'package-field')).toBe(true);
      expect(r.symbols.some(s => s.name === 'version' && s.metadata?.tomlKind === 'package-field')).toBe(true);
      // dependencies as import edges
      expect(r.edges!.some(e => (e.metadata as any).module === 'serde')).toBe(true);
      expect(r.edges!.some(e => (e.metadata as any).module === 'tokio')).toBe(true);
      expect(r.edges!.some(e => (e.metadata as any).module === 'criterion')).toBe(true);
      // features
      expect(r.symbols.some(s => s.name === 'default' && s.metadata?.tomlKind === 'feature')).toBe(true);
      expect(r.symbols.some(s => s.name === 'full' && s.metadata?.tomlKind === 'feature')).toBe(true);
      // [[bin]]
      expect(r.symbols.some(s => s.name === 'my-binary' && s.metadata?.tomlKind === 'binary')).toBe(true);
    });
  });

  // ── pyproject.toml ──

  describe('pyproject', () => {
    it('extracts project name and poetry dependencies as imports', async () => {
      const r = await parse(
        `[project]
name = "my-python-pkg"
version = "0.1.0"

[tool.poetry.dependencies]
requests = "^2.28"
flask = "^2.3"

[build-system]
requires = ["setuptools>=61.0"]`,
        'pyproject.toml',
      );

      expect(r.metadata?.dialect).toBe('pyproject');
      // project name and version
      expect(r.symbols.some(s => s.name === 'name' && s.metadata?.tomlKind === 'project-field')).toBe(true);
      expect(r.symbols.some(s => s.name === 'version' && s.metadata?.tomlKind === 'project-field')).toBe(true);
      // poetry deps as imports
      expect(r.edges!.some(e => (e.metadata as any).module === 'requests')).toBe(true);
      expect(r.edges!.some(e => (e.metadata as any).module === 'flask')).toBe(true);
      // build-system requires
      expect(r.edges!.some(e => (e.metadata as any).module === 'setuptools')).toBe(true);
    });
  });
});
