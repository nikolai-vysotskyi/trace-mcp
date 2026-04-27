import { describe, it, expect } from 'vitest';
import { CSharpLanguagePlugin } from '../../src/indexer/plugins/language/csharp/index.js';
import { ScalaLanguagePlugin } from '../../src/indexer/plugins/language/scala/index.js';

// ── C# ──────────────────────────────────────────────────────────────────────

const csharpPlugin = new CSharpLanguagePlugin();
async function parseCSharp(source: string, filePath = 'Program.cs') {
  const result = await csharpPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('CSharpLanguagePlugin', () => {
  it('has correct manifest', async () => {
    expect(csharpPlugin.manifest.name).toBe('csharp-language');
    expect(csharpPlugin.supportedExtensions).toContain('.cs');
  });

  it('extracts classes', async () => {
    const r = await parseCSharp('public class UserService {\n  public void Save() {}\n}');
    expect(r.symbols.some((s) => s.name === 'UserService' && s.kind === 'class')).toBe(true);
  });

  it('extracts interfaces', async () => {
    const r = await parseCSharp('public interface IRepository {\n  void Save();\n}');
    expect(r.symbols.some((s) => s.name === 'IRepository' && s.kind === 'interface')).toBe(true);
  });

  it('extracts namespaces', async () => {
    const r = await parseCSharp('namespace MyApp.Services {\n  public class Foo {}\n}');
    expect(r.symbols.some((s) => s.name === 'MyApp.Services' && s.kind === 'namespace')).toBe(true);
  });

  it('extracts enums', async () => {
    const r = await parseCSharp('public enum Status {\n  Active,\n  Inactive,\n}');
    expect(r.symbols.some((s) => s.name === 'Status' && s.kind === 'enum')).toBe(true);
  });

  it('extracts records', async () => {
    const r = await parseCSharp('public record Point(int X, int Y);');
    expect(r.symbols.some((s) => s.name === 'Point' && s.kind === 'class')).toBe(true);
  });

  it('extracts structs', async () => {
    const r = await parseCSharp('public struct Vector3 {\n  public float X;\n}');
    expect(r.symbols.some((s) => s.name === 'Vector3' && s.kind === 'class')).toBe(true);
  });

  it('extracts constants', async () => {
    const r = await parseCSharp('public class Config {\n  public const int MaxRetries = 3;\n}');
    expect(
      r.symbols.some(
        (s) => s.name === 'MaxRetries' && (s.kind === 'constant' || s.kind === 'property'),
      ),
    ).toBe(true);
  });

  it('extracts methods', async () => {
    const r = await parseCSharp(
      'public class Svc {\n  public async Task<string> GetNameAsync(int id) {\n    return "";\n  }\n}',
    );
    expect(r.symbols.some((s) => s.name === 'GetNameAsync' && s.kind === 'method')).toBe(true);
  });

  it('extracts import edges from using statements', async () => {
    const r = await parseCSharp(
      'using System.Collections.Generic;\nusing System.Linq;\nnamespace App { class Foo {} }',
    );
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter((e) => e.edgeType === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Scala (tree-sitter) ────────────────────────────────────────────────────

const scalaPlugin = new ScalaLanguagePlugin();
async function parseScala(source: string, filePath = 'Main.scala') {
  const result = await scalaPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('ScalaLanguagePlugin', () => {
  it('has correct manifest', async () => {
    expect(scalaPlugin.manifest.name).toBe('scala-language');
    expect(scalaPlugin.supportedExtensions).toContain('.scala');
  });

  it('extracts class', async () => {
    const r = await parseScala(
      'class UserService {\n  def findUser(id: Int): Option[User] = None\n}',
    );
    expect(r.symbols.some((s) => s.name === 'UserService' && s.kind === 'class')).toBe(true);
  });

  it('extracts case class', async () => {
    const r = await parseScala('case class User(name: String, age: Int)');
    expect(r.symbols.some((s) => s.name === 'User' && s.kind === 'class')).toBe(true);
  });

  it('extracts object', async () => {
    const r = await parseScala('object AppConfig {\n  val defaultPort: Int = 8080\n}');
    expect(r.symbols.some((s) => s.name === 'AppConfig' && s.kind === 'class')).toBe(true);
    const obj = r.symbols.find((s) => s.name === 'AppConfig');
    expect(obj?.metadata?.object).toBe(true);
  });

  it('extracts trait', async () => {
    const r = await parseScala('trait Repository[T] {\n  def findAll(): List[T]\n}');
    expect(r.symbols.some((s) => s.name === 'Repository' && s.kind === 'trait')).toBe(true);
  });

  it('extracts def (top-level function)', async () => {
    const r = await parseScala('def greet(name: String): String = s"Hello, $name"');
    expect(r.symbols.some((s) => s.name === 'greet' && s.kind === 'function')).toBe(true);
  });

  it('extracts def inside class as method', async () => {
    const r = await parseScala(
      'class Greeter {\n  def greet(name: String): String = s"Hello, $name"\n}',
    );
    expect(r.symbols.some((s) => s.name === 'Greeter' && s.kind === 'class')).toBe(true);
    expect(r.symbols.some((s) => s.name === 'greet' && s.kind === 'method')).toBe(true);
  });

  it('extracts val as constant', async () => {
    const r = await parseScala('val MaxRetries: Int = 3');
    expect(r.symbols.some((s) => s.name === 'MaxRetries' && s.kind === 'constant')).toBe(true);
  });

  // TODO: tree-sitter-wasms ships an older Scala grammar that doesn't support Scala 3 enums.
  // Re-enable once tree-sitter-wasms updates their bundled tree-sitter-scala WASM.
  it.skip('extracts enum with cases', async () => {
    const r = await parseScala('enum Color {\n  case Red, Green, Blue\n}');
    expect(r.symbols.some((s) => s.name === 'Color' && s.kind === 'enum')).toBe(true);
    expect(r.symbols.some((s) => s.name === 'Red' && s.kind === 'enum_case')).toBe(true);
  });

  it('extracts import edges', async () => {
    const r = await parseScala('import scala.collection.mutable\nimport java.util.{List, Map}');
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter((e) => e.edgeType === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(1);
  });
});
