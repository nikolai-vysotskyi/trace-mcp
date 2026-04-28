import { beforeAll, describe, expect, it } from 'vitest';
import { CSharpLanguagePlugin } from '../../src/indexer/plugins/language/csharp/index.js';

const plugin = new CSharpLanguagePlugin();

async function extract(code: string, filePath = 'src/Program.cs') {
  const result = await plugin.extractSymbols(filePath, Buffer.from(code));
  if (!result.isOk()) {
    throw new Error(`C# extractSymbols failed: ${JSON.stringify(result._unsafeUnwrapErr())}`);
  }
  return result._unsafeUnwrap();
}

describe('CSharpLanguagePlugin', () => {
  beforeAll(async () => {
    const probe = await plugin.extractSymbols('probe.cs', Buffer.from('class Probe {}\n'));
    expect(
      probe.isOk(),
      `C# parser init failed: ${JSON.stringify(probe.isErr() ? probe._unsafeUnwrapErr() : '')}`,
    ).toBe(true);
  });

  it('has correct manifest', () => {
    expect(plugin.manifest.name).toBe('csharp-language');
    expect(plugin.supportedExtensions).toContain('.cs');
  });

  it('extracts namespaces and classes', async () => {
    const result = await extract(`
namespace MyApp.Models {
    public class User {
        public string Name { get; set; }
    }
}
    `);
    const ns = result.symbols.find((s) => s.kind === 'namespace');
    expect(ns).toBeDefined();
    const cls = result.symbols.find((s) => s.name === 'User' && s.kind === 'class');
    expect(cls).toBeDefined();
  });

  it('extracts interfaces', async () => {
    const result = await extract(`
public interface IService {
    void Start();
    void Stop();
}
    `);
    const iface = result.symbols.find((s) => s.name === 'IService' && s.kind === 'interface');
    expect(iface).toBeDefined();
  });

  it('extracts enums with members', async () => {
    const result = await extract(`
public enum Color {
    Red,
    Green,
    Blue
}
    `);
    const e = result.symbols.find((s) => s.name === 'Color' && s.kind === 'enum');
    expect(e).toBeDefined();

    const cases = result.symbols.filter((s) => s.kind === 'enum_case');
    expect(cases.length).toBe(3);
  });

  it('extracts methods', async () => {
    const result = await extract(`
public class Calculator {
    public int Add(int a, int b) {
        return a + b;
    }
}
    `);
    const method = result.symbols.find((s) => s.name === 'Add' && s.kind === 'method');
    expect(method).toBeDefined();
  });

  it('extracts using directives as import edges', async () => {
    const result = await extract(`
using System;
using System.Collections.Generic;

class Foo {}
    `);
    expect(result.edges).toBeDefined();
    const imports = result.edges!.filter((e) => e.edgeType === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts structs', async () => {
    const result = await extract(`
public struct Point {
    public double X;
    public double Y;
}
    `);
    const st = result.symbols.find((s) => s.name === 'Point' && s.kind === 'class');
    expect(st).toBeDefined();
    expect(st!.metadata?.csharpKind).toBe('struct');
  });

  it('extracts records', async () => {
    const result = await extract(`
public record Person(string Name, int Age);
    `);
    const rec = result.symbols.find((s) => s.name === 'Person' && s.kind === 'class');
    expect(rec).toBeDefined();
    expect(rec!.metadata?.csharpKind).toBe('record');
  });

  it('handles syntax errors gracefully', async () => {
    const result = await extract(`
public class Broken {
    public void Foo( {
    }
}
    `);
    expect(result.status).toBe('partial');
  });
});
