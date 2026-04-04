import { describe, it, expect } from 'vitest';
import { RustLanguagePlugin } from '../../src/indexer/plugins/language/rust/index.js';
import { CLanguagePlugin } from '../../src/indexer/plugins/language/c/index.js';
import { CppLanguagePlugin } from '../../src/indexer/plugins/language/cpp/index.js';

// ── Rust ────────────────────────────────────────────────────────────────────

const rustPlugin = new RustLanguagePlugin();
function parseRust(source: string, filePath = 'main.rs') {
  const result = rustPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('RustLanguagePlugin', () => {
  it('has correct manifest', () => {
    expect(rustPlugin.manifest.name).toBe('rust-language');
    expect(rustPlugin.supportedExtensions).toContain('.rs');
  });

  it('extracts functions', () => {
    const r = parseRust('pub fn process(data: &[u8]) -> Result<(), Error> {\n  Ok(())\n}');
    expect(r.symbols.some(s => s.name === 'process' && s.kind === 'function')).toBe(true);
  });

  it('extracts async functions', () => {
    const r = parseRust('pub async fn fetch_data() -> Result<Vec<u8>, Error> {\n  Ok(vec![])\n}');
    expect(r.symbols.some(s => s.name === 'fetch_data' && s.kind === 'function')).toBe(true);
  });

  it('extracts structs', () => {
    const r = parseRust('pub struct Config {\n  pub host: String,\n  pub port: u16,\n}');
    expect(r.symbols.some(s => s.name === 'Config' && s.kind === 'class')).toBe(true);
  });

  it('extracts enums', () => {
    const r = parseRust('enum Status {\n  Active,\n  Inactive,\n}');
    expect(r.symbols.some(s => s.name === 'Status' && s.kind === 'enum')).toBe(true);
  });

  it('extracts traits', () => {
    const r = parseRust('pub trait Serializable {\n  fn serialize(&self) -> Vec<u8>;\n}');
    expect(r.symbols.some(s => s.name === 'Serializable' && s.kind === 'trait')).toBe(true);
  });

  it('extracts impl blocks', () => {
    const r = parseRust('impl Display for Config {\n  fn fmt(&self, f: &mut Formatter) -> fmt::Result {\n    Ok(())\n  }\n}');
    // impl blocks emit the methods inside them
    expect(r.symbols.some(s => s.name === 'fmt' && s.kind === 'method')).toBe(true);
  });

  it('extracts macro definitions', () => {
    const r = parseRust('macro_rules! vec {\n  ($($x:expr),*) => { Vec::new() };\n}');
    expect(r.symbols.some(s => s.name === 'vec' && s.kind === 'function')).toBe(true);
  });

  it('extracts constants', () => {
    const r = parseRust('pub const MAX_RETRIES: u32 = 5;');
    expect(r.symbols.some(s => s.name === 'MAX_RETRIES' && s.kind === 'constant')).toBe(true);
  });

  it('extracts type aliases', () => {
    const r = parseRust('pub type Result<T> = std::result::Result<T, Error>;');
    expect(r.symbols.some(s => s.name === 'Result' && s.kind === 'type')).toBe(true);
  });

  it('extracts modules', () => {
    const r = parseRust('pub mod utils;');
    expect(r.symbols.some(s => s.name === 'utils' && s.kind === 'namespace')).toBe(true);
  });

  it('extracts import edges', () => {
    const r = parseRust('use std::collections::HashMap;\nuse std::io::{Read, Write};');
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter(e => e.edgeType === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(2);
    const modules = imports.map(e => (e.metadata as any).module);
    expect(modules).toContain('std::collections::HashMap');
  });
});

// ── C ───────────────────────────────────────────────────────────────────────

const cPlugin = new CLanguagePlugin();
function parseC(source: string, filePath = 'main.c') {
  const result = cPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('CLanguagePlugin', () => {
  it('has correct manifest', () => {
    expect(cPlugin.manifest.name).toBe('c-language');
    expect(cPlugin.supportedExtensions).toContain('.c');
    expect(cPlugin.supportedExtensions).toContain('.h');
  });

  it('extracts functions', () => {
    const r = parseC('int main(int argc, char *argv[]) {\n  return 0;\n}');
    expect(r.symbols.some(s => s.name === 'main' && s.kind === 'function')).toBe(true);
  });

  it('extracts structs', () => {
    const r = parseC('struct node {\n  int value;\n  struct node *next;\n};');
    expect(r.symbols.some(s => s.name === 'node' && s.kind === 'class')).toBe(true);
  });

  it('extracts enums', () => {
    const r = parseC('enum color { RED, GREEN, BLUE };');
    expect(r.symbols.some(s => s.name === 'color' && s.kind === 'enum')).toBe(true);
  });

  it('extracts #define constants', () => {
    const r = parseC('#define MAX_SIZE 100');
    expect(r.symbols.some(s => s.name === 'MAX_SIZE' && s.kind === 'constant')).toBe(true);
  });

  it('extracts unions', () => {
    const r = parseC('union data {\n  int i;\n  float f;\n};');
    expect(r.symbols.some(s => s.name === 'data' && s.kind === 'class')).toBe(true);
  });

  it('extracts typedefs', () => {
    const r = parseC('typedef unsigned long size_t;');
    expect(r.symbols.some(s => s.name === 'size_t' && s.kind === 'type')).toBe(true);
  });

  it('extracts import edges from #include', () => {
    const r = parseC('#include <stdio.h>\n#include "myheader.h"');
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter(e => e.edgeType === 'imports');
    expect(imports.length).toBe(2);
    const modules = imports.map(e => (e.metadata as any).module);
    expect(modules).toContain('stdio.h');
    expect(modules).toContain('myheader.h');
  });
});

// ── C++ ─────────────────────────────────────────────────────────────────────

const cppPlugin = new CppLanguagePlugin();
function parseCpp(source: string, filePath = 'main.cpp') {
  const result = cppPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('CppLanguagePlugin', () => {
  it('has correct manifest', () => {
    expect(cppPlugin.manifest.name).toBe('cpp-language');
    expect(cppPlugin.supportedExtensions).toContain('.cpp');
  });

  it('extracts classes', () => {
    const r = parseCpp('class Widget {\npublic:\n  void draw();\n};');
    expect(r.symbols.some(s => s.name === 'Widget' && s.kind === 'class')).toBe(true);
  });

  it('extracts namespaces', () => {
    const r = parseCpp('namespace ui {\n  class Button {};\n}');
    expect(r.symbols.some(s => s.name === 'ui' && s.kind === 'namespace')).toBe(true);
  });

  it('extracts enum classes', () => {
    const r = parseCpp('enum class Color { Red, Green, Blue };');
    expect(r.symbols.some(s => s.name === 'Color' && s.kind === 'enum')).toBe(true);
  });

  it('extracts template classes', () => {
    const r = parseCpp('template<typename T>\nclass Container {\n  T value;\n};');
    expect(r.symbols.some(s => s.name === 'Container' && s.kind === 'class')).toBe(true);
  });

  it('extracts structs', () => {
    const r = parseCpp('struct Point {\n  int x;\n  int y;\n};');
    expect(r.symbols.some(s => s.name === 'Point' && s.kind === 'class')).toBe(true);
  });

  it('extracts type aliases (using)', () => {
    const r = parseCpp('using StringList = std::vector<std::string>;');
    expect(r.symbols.some(s => s.name === 'StringList' && s.kind === 'type')).toBe(true);
  });

  it('extracts #define constants', () => {
    const r = parseCpp('#define VERSION 42');
    expect(r.symbols.some(s => s.name === 'VERSION' && s.kind === 'constant')).toBe(true);
  });

  it('extracts function definitions', () => {
    const r = parseCpp('int add(int a, int b) {\n  return a + b;\n}');
    expect(r.symbols.some(s => s.name === 'add' && s.kind === 'function')).toBe(true);
  });

  it('extracts import edges from #include', () => {
    const r = parseCpp('#include <vector>\n#include "widget.h"');
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter(e => e.edgeType === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(2);
    const modules = imports.map(e => (e.metadata as any).module);
    expect(modules).toContain('vector');
  });

  it('extracts using namespace edges', () => {
    const r = parseCpp('using namespace std;');
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter(e => e.edgeType === 'imports');
    expect(imports.some(e => (e.metadata as any).module === 'std')).toBe(true);
  });
});
