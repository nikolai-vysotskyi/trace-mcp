import { describe, it, expect } from 'vitest';
import { CSharpLanguagePlugin } from '../../src/indexer/plugins/language/csharp/index.js';
import { ScalaLanguagePlugin } from '../../src/indexer/plugins/language/scala/index.js';

// ── C# ──────────────────────────────────────────────────────────────────────

const csharpPlugin = new CSharpLanguagePlugin();
function parseCSharp(source: string, filePath = 'Program.cs') {
  const result = csharpPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('CSharpLanguagePlugin', () => {
  it('has correct manifest', () => {
    expect(csharpPlugin.manifest.name).toBe('csharp-language');
    expect(csharpPlugin.supportedExtensions).toContain('.cs');
  });

  it('extracts classes', () => {
    const r = parseCSharp('public class UserService {\n  public void Save() {}\n}');
    expect(r.symbols.some(s => s.name === 'UserService' && s.kind === 'class')).toBe(true);
  });

  it('extracts interfaces', () => {
    const r = parseCSharp('public interface IRepository {\n  void Save();\n}');
    expect(r.symbols.some(s => s.name === 'IRepository' && s.kind === 'interface')).toBe(true);
  });

  it('extracts namespaces', () => {
    const r = parseCSharp('namespace MyApp.Services {\n  public class Foo {}\n}');
    expect(r.symbols.some(s => s.name === 'MyApp.Services' && s.kind === 'namespace')).toBe(true);
  });

  it('extracts enums', () => {
    const r = parseCSharp('public enum Status {\n  Active,\n  Inactive,\n}');
    expect(r.symbols.some(s => s.name === 'Status' && s.kind === 'enum')).toBe(true);
  });

  it('extracts records', () => {
    const r = parseCSharp('public record Point(int X, int Y);');
    expect(r.symbols.some(s => s.name === 'Point' && s.kind === 'class')).toBe(true);
  });

  it('extracts structs', () => {
    const r = parseCSharp('public struct Vector3 {\n  public float X;\n}');
    expect(r.symbols.some(s => s.name === 'Vector3' && s.kind === 'class')).toBe(true);
  });

  it('extracts constants', () => {
    const r = parseCSharp('public class Config {\n  public const int MaxRetries = 3;\n}');
    expect(r.symbols.some(s => s.name === 'MaxRetries' && (s.kind === 'constant' || s.kind === 'property'))).toBe(true);
  });

  it('extracts methods', () => {
    const r = parseCSharp('public class Svc {\n  public async Task<string> GetNameAsync(int id) {\n    return "";\n  }\n}');
    expect(r.symbols.some(s => s.name === 'GetNameAsync' && s.kind === 'method')).toBe(true);
  });

  it('extracts import edges from using statements', () => {
    const r = parseCSharp('using System.Collections.Generic;\nusing System.Linq;\nnamespace App { class Foo {} }');
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter(e => e.edgeType === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Scala (tree-sitter) ────────────────────────────────────────────────────

const scalaPlugin = new ScalaLanguagePlugin();
function parseScala(source: string, filePath = 'Main.scala') {
  const result = scalaPlugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('ScalaLanguagePlugin', () => {
  it('has correct manifest', () => {
    expect(scalaPlugin.manifest.name).toBe('scala-language');
    expect(scalaPlugin.supportedExtensions).toContain('.scala');
  });

  it('extracts class', () => {
    const r = parseScala('class UserService {\n  def findUser(id: Int): Option[User] = None\n}');
    expect(r.symbols.some(s => s.name === 'UserService' && s.kind === 'class')).toBe(true);
  });

  it('extracts case class', () => {
    const r = parseScala('case class User(name: String, age: Int)');
    expect(r.symbols.some(s => s.name === 'User' && s.kind === 'class')).toBe(true);
  });

  it('extracts object', () => {
    const r = parseScala('object AppConfig {\n  val defaultPort: Int = 8080\n}');
    expect(r.symbols.some(s => s.name === 'AppConfig' && s.kind === 'class')).toBe(true);
    const obj = r.symbols.find(s => s.name === 'AppConfig');
    expect(obj?.metadata?.object).toBe(true);
  });

  it('extracts trait', () => {
    const r = parseScala('trait Repository[T] {\n  def findAll(): List[T]\n}');
    expect(r.symbols.some(s => s.name === 'Repository' && s.kind === 'trait')).toBe(true);
  });

  it('extracts def (top-level function)', () => {
    const r = parseScala('def greet(name: String): String = s"Hello, $name"');
    expect(r.symbols.some(s => s.name === 'greet' && s.kind === 'function')).toBe(true);
  });

  it('extracts def inside class as method', () => {
    const r = parseScala('class Greeter {\n  def greet(name: String): String = s"Hello, $name"\n}');
    expect(r.symbols.some(s => s.name === 'Greeter' && s.kind === 'class')).toBe(true);
    expect(r.symbols.some(s => s.name === 'greet' && s.kind === 'method')).toBe(true);
  });

  it('extracts val as constant', () => {
    const r = parseScala('val MaxRetries: Int = 3');
    expect(r.symbols.some(s => s.name === 'MaxRetries' && s.kind === 'constant')).toBe(true);
  });

  it('extracts enum with cases', () => {
    const r = parseScala('enum Color {\n  case Red, Green, Blue\n}');
    expect(r.symbols.some(s => s.name === 'Color' && s.kind === 'enum')).toBe(true);
    expect(r.symbols.some(s => s.name === 'Red' && s.kind === 'enum_case')).toBe(true);
  });

  it('extracts import edges', () => {
    const r = parseScala('import scala.collection.mutable\nimport java.util.{List, Map}');
    expect(r.edges).toBeDefined();
    const imports = r.edges!.filter(e => e.edgeType === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(1);
  });
});
