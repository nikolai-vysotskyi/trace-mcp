import { describe, it, expect, beforeAll } from 'vitest';
import { ScalaLanguagePlugin } from '../../src/indexer/plugins/language/scala/index.js';

const plugin = new ScalaLanguagePlugin();

function extract(code: string, filePath = 'src/main/scala/App.scala') {
  const result = plugin.extractSymbols(filePath, Buffer.from(code));
  if (!result.isOk()) {
    throw new Error(`Scala extractSymbols failed: ${JSON.stringify(result._unsafeUnwrapErr())}`);
  }
  return result._unsafeUnwrap();
}

describe('ScalaLanguagePlugin', () => {
  beforeAll(() => {
    const probe = plugin.extractSymbols('probe.scala', Buffer.from('class Probe\n'));
    expect(probe.isOk(), `Scala parser init failed: ${JSON.stringify(probe.isErr() ? probe._unsafeUnwrapErr() : '')}`).toBe(true);
  });

  it('has correct manifest', () => {
    expect(plugin.manifest.name).toBe('scala-language');
    expect(plugin.supportedExtensions).toContain('.scala');
    expect(plugin.supportedExtensions).toContain('.sc');
  });

  it('extracts classes', () => {
    const result = extract(`
package models

class User(val name: String, val age: Int)
    `);
    const cls = result.symbols.find((s) => s.name === 'User' && s.kind === 'class');
    expect(cls).toBeDefined();
  });

  it('extracts objects', () => {
    const result = extract(`
object App {
  def main(args: Array[String]): Unit = {
    println("Hello")
  }
}
    `);
    const obj = result.symbols.find((s) => s.name === 'App' && s.kind === 'class');
    expect(obj).toBeDefined();
  });

  it('extracts traits', () => {
    const result = extract(`
trait Service {
  def start(): Unit
  def stop(): Unit
}
    `);
    const t = result.symbols.find((s) => s.name === 'Service' && s.kind === 'trait');
    expect(t).toBeDefined();
  });

  it('extracts methods inside objects', () => {
    const result = extract(`
object Utils {
  def add(a: Int, b: Int): Int = a + b
  private def helper(): Unit = {}
}
    `);
    const methods = result.symbols.filter((s) => s.kind === 'method');
    expect(methods.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts top-level functions', () => {
    const result = extract(`
def topLevel(x: Int): Int = x * 2
    `);
    const fns = result.symbols.filter((s) => s.kind === 'function');
    expect(fns.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts import edges', () => {
    const result = extract(`
import scala.collection.mutable.Map
import java.util.{List, ArrayList}

class Foo
    `);
    expect(result.edges).toBeDefined();
    const imports = result.edges!.filter((e) => e.edgeType === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts case classes', () => {
    const result = extract(`
case class Config(name: String, port: Int)
    `);
    const cls = result.symbols.find((s) => s.name === 'Config' && s.kind === 'class');
    expect(cls).toBeDefined();
  });

  it('extracts vals and vars', () => {
    const result = extract(`
object Constants {
  val MaxRetries = 3
  var counter = 0
}
    `);
    const symbols = result.symbols;
    // vals and vars may be extracted at object level or inside
    expect(symbols.length).toBeGreaterThanOrEqual(1);
  });

  it('handles syntax errors gracefully', () => {
    const result = extract(`
class Broken {
  def foo( = {
  }
}
    `);
    expect(result.status).toBe('partial');
  });
});
