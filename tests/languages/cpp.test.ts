import { describe, it, expect, beforeAll } from 'vitest';
import { CppLanguagePlugin } from '../../src/indexer/plugins/language/cpp/index.js';

const plugin = new CppLanguagePlugin();

async function extract(code: string, filePath = 'src/main.cpp') {
  const result = await plugin.extractSymbols(filePath, Buffer.from(code));
  if (!result.isOk()) {
    throw new Error(`C++ extractSymbols failed: ${JSON.stringify(result._unsafeUnwrapErr())}`);
  }
  return result._unsafeUnwrap();
}

describe('CppLanguagePlugin', () => {
  beforeAll(async () => {
    const probe = await plugin.extractSymbols('probe.cpp', Buffer.from('int probe() { return 0; }\n'));
    expect(probe.isOk(), `C++ parser init failed: ${JSON.stringify(probe.isErr() ? probe._unsafeUnwrapErr() : '')}`).toBe(true);
  });

  it('has correct manifest', () => {
    expect(plugin.manifest.name).toBe('cpp-language');
    expect(plugin.supportedExtensions).toContain('.cpp');
    expect(plugin.supportedExtensions).toContain('.hpp');
  });

  it('extracts classes', async () => {
    const result = await extract(`
class Animal {
public:
    virtual void speak() = 0;
    int age;
};
    `);
    const cls = result.symbols.find((s) => s.name === 'Animal' && s.kind === 'class');
    expect(cls).toBeDefined();
  });

  it('extracts namespaces', async () => {
    const result = await extract(`
namespace mylib {
    class Foo {};
}
    `);
    const ns = result.symbols.find((s) => s.name === 'mylib' && s.kind === 'namespace');
    expect(ns).toBeDefined();
    const cls = result.symbols.find((s) => s.name === 'Foo' && s.kind === 'class');
    expect(cls).toBeDefined();
  });

  it('extracts enums', async () => {
    const result = await extract(`
enum class Color {
    Red,
    Green,
    Blue
};
    `);
    const e = result.symbols.find((s) => s.name === 'Color' && s.kind === 'enum');
    expect(e).toBeDefined();
  });

  it('extracts functions', async () => {
    const result = await extract(`
int main(int argc, char** argv) {
    return 0;
}

inline void helper() {}
    `);
    const fns = result.symbols.filter((s) => s.kind === 'function');
    expect(fns.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts #include edges', async () => {
    const result = await extract(`
#include <iostream>
#include "config.h"

int main() { return 0; }
    `);
    expect(result.edges).toBeDefined();
    const imports = result.edges!.filter((e) => e.edgeType === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts structs', async () => {
    const result = await extract(`
struct Point {
    double x;
    double y;
};
    `);
    const st = result.symbols.find((s) => s.name === 'Point' && s.kind === 'class');
    expect(st).toBeDefined();
  });

  it('handles syntax errors gracefully', async () => {
    const result = await extract(`
class Broken {
    void foo( {
    }
};
    `);
    expect(result.status).toBe('partial');
  });
});
