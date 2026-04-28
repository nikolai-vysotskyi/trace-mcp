import { beforeAll, describe, expect, it } from 'vitest';
import { CLanguagePlugin } from '../../src/indexer/plugins/language/c/index.js';

const plugin = new CLanguagePlugin();

async function extract(code: string, filePath = 'src/main.c') {
  const result = await plugin.extractSymbols(filePath, Buffer.from(code));
  if (!result.isOk()) {
    throw new Error(`C extractSymbols failed: ${JSON.stringify(result._unsafeUnwrapErr())}`);
  }
  return result._unsafeUnwrap();
}

describe('CLanguagePlugin', () => {
  beforeAll(async () => {
    const probe = await plugin.extractSymbols(
      'probe.c',
      Buffer.from('int probe(void) { return 0; }\n'),
    );
    expect(
      probe.isOk(),
      `C parser init failed: ${JSON.stringify(probe.isErr() ? probe._unsafeUnwrapErr() : '')}`,
    ).toBe(true);
  });

  it('has correct manifest', () => {
    expect(plugin.manifest.name).toBe('c-language');
    expect(plugin.supportedExtensions).toContain('.c');
    expect(plugin.supportedExtensions).toContain('.h');
  });

  it('extracts functions', async () => {
    const result = await extract(`
int main(int argc, char **argv) {
    return 0;
}

static void helper(void) {}
    `);
    const main = result.symbols.find((s) => s.name === 'main' && s.kind === 'function');
    expect(main).toBeDefined();
  });

  it('extracts structs with fields', async () => {
    const result = await extract(`
struct Point {
    int x;
    int y;
};
    `);
    const st = result.symbols.find((s) => s.name === 'Point' && s.kind === 'class');
    expect(st).toBeDefined();

    const fields = result.symbols.filter((s) => s.kind === 'property');
    expect(fields.length).toBe(2);
  });

  it('extracts enums with constants', async () => {
    const result = await extract(`
enum Color {
    RED,
    GREEN,
    BLUE
};
    `);
    const e = result.symbols.find((s) => s.name === 'Color' && s.kind === 'enum');
    expect(e).toBeDefined();

    const cases = result.symbols.filter((s) => s.kind === 'enum_case');
    expect(cases.length).toBe(3);
  });

  it('extracts #include edges', async () => {
    const result = await extract(`
#include <stdio.h>
#include "myheader.h"

int main() { return 0; }
    `);
    expect(result.edges).toBeDefined();
    const imports = result.edges!.filter((e) => e.edgeType === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts #define macros', async () => {
    const result = await extract(`
#define MAX_SIZE 1024
#define MIN(a, b) ((a) < (b) ? (a) : (b))
    `);
    const macros = result.symbols.filter((s) => s.kind === 'constant');
    expect(macros.length).toBeGreaterThanOrEqual(1);
    expect(macros.map((m) => m.name)).toContain('MAX_SIZE');
  });

  it('extracts typedef', async () => {
    const result = await extract(`
typedef unsigned long size_t;
typedef struct Node {
    int value;
} Node;
    `);
    const types = result.symbols.filter((s) => s.kind === 'type');
    expect(types.length).toBeGreaterThanOrEqual(1);
  });

  it('handles syntax errors gracefully', async () => {
    const result = await extract(`
int broken( {
    // bad syntax
}
    `);
    expect(result.status).toBe('partial');
  });
});
