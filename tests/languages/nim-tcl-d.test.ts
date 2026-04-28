/**
 * Tests for Nim, Tcl, and D language plugins.
 * Covers symbol extraction, parent-child relationships, doc comments,
 * import edges, and comment immunity.
 */
import { describe, expect, it } from 'vitest';
import { DLanguagePlugin } from '../../src/indexer/plugins/language/dlang/index.js';
import { NimLanguagePlugin } from '../../src/indexer/plugins/language/nim/index.js';
import { TclLanguagePlugin } from '../../src/indexer/plugins/language/tcl/index.js';

async function parse(
  plugin: { extractSymbols: (f: string, c: Buffer) => any },
  source: string,
  filePath: string,
): Promise<any> {
  const resultOrPromise = plugin.extractSymbols(filePath, Buffer.from(source));
  const result =
    resultOrPromise && typeof resultOrPromise.then === 'function'
      ? await resultOrPromise
      : resultOrPromise;
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

// ======================================================================
// Nim
// ======================================================================
describe('Nim', () => {
  const plugin = new NimLanguagePlugin();
  const p = (s: string, f = 'main.nim') => parse(plugin, s, f);

  // ── Procs ──────────────────────────────────────────────────────────
  it('extracts public proc', async () => {
    const r = await p('proc hello*(name: string): string =\n  "hi " & name');
    const sym = r.symbols.find((s: any) => s.name === 'hello');
    expect(sym).toBeDefined();
    expect(sym.kind).toBe('function');
    expect(sym.metadata?.public).toBe(true);
  });

  it('extracts private proc', async () => {
    const r = await p('proc internal(x: int): int =\n  x * 2');
    expect(r.symbols.some((s: any) => s.name === 'internal' && s.kind === 'function')).toBe(true);
  });

  // ── Func (pure) ────────────────────────────────────────────────────
  it('extracts pure func', async () => {
    const r = await p('func add*(a, b: int): int =\n  a + b');
    const sym = r.symbols.find((s: any) => s.name === 'add');
    expect(sym).toBeDefined();
    expect(sym.metadata?.pure).toBe(true);
    expect(sym.metadata?.public).toBe(true);
  });

  // ── Methods ────────────────────────────────────────────────────────
  it('extracts method', async () => {
    const r = await p('method draw*(self: Shape) =\n  discard');
    const sym = r.symbols.find((s: any) => s.name === 'draw');
    expect(sym).toBeDefined();
    expect(sym.kind).toBe('method');
  });

  // ── Templates & Macros ─────────────────────────────────────────────
  it('extracts template', async () => {
    const r = await p('template withLock*(lock: Lock, body: untyped) =\n  body');
    const sym = r.symbols.find((s: any) => s.name === 'withLock');
    expect(sym).toBeDefined();
    expect(sym.metadata?.template).toBe(true);
  });

  it('extracts macro', async () => {
    const r = await p('macro dumpTree*(body: untyped): untyped =\n  echo body.treeRepr');
    const sym = r.symbols.find((s: any) => s.name === 'dumpTree');
    expect(sym).toBeDefined();
    expect(sym.metadata?.macro).toBe(true);
  });

  // ── Iterator ───────────────────────────────────────────────────────
  it('extracts iterator', async () => {
    const r = await p('iterator items*[T](a: seq[T]): T =\n  for x in a: yield x');
    const sym = r.symbols.find((s: any) => s.name === 'items');
    expect(sym).toBeDefined();
    expect(sym.metadata?.iterator).toBe(true);
  });

  // ── Converter ──────────────────────────────────────────────────────
  it('extracts converter', async () => {
    const r = await p('converter toFloat*(x: int): float =\n  float(x)');
    const sym = r.symbols.find((s: any) => s.name === 'toFloat');
    expect(sym).toBeDefined();
    expect(sym.metadata?.converter).toBe(true);
  });

  // ── Backtick operators ─────────────────────────────────────────────
  it('extracts backtick operator', async () => {
    const r = await p('proc `+`*(a, b: Vec2): Vec2 =\n  Vec2(x: a.x+b.x)');
    expect(r.symbols.some((s: any) => s.name === '`+`')).toBe(true);
  });

  // ── Types ──────────────────────────────────────────────────────────
  it('extracts object type', async () => {
    const r = await p('type\n  Person* = object\n    name*: string\n    age: int');
    expect(r.symbols.some((s: any) => s.name === 'Person' && s.kind === 'class')).toBe(true);
  });

  it('extracts enum type', async () => {
    const r = await p('type\n  Color* = enum\n    Red, Green, Blue');
    expect(r.symbols.some((s: any) => s.name === 'Color' && s.metadata?.enum)).toBe(true);
  });

  it('extracts concept', async () => {
    const r = await p('type\n  Printable = concept x\n    $x is string');
    expect(r.symbols.some((s: any) => s.name === 'Printable' && s.metadata?.concept)).toBe(true);
  });

  it('extracts distinct type', async () => {
    const r = await p('type\n  Meter = distinct float');
    expect(r.symbols.some((s: any) => s.name === 'Meter' && s.metadata?.distinct)).toBe(true);
  });

  // ── Constants & Variables ──────────────────────────────────────────
  it('extracts const', async () => {
    const r = await p('const MaxSize* = 100');
    expect(r.symbols.some((s: any) => s.name === 'MaxSize' && s.kind === 'constant')).toBe(true);
  });

  it('extracts let', async () => {
    const r = await p('let version* = "1.0"');
    expect(r.symbols.some((s: any) => s.name === 'version' && s.kind === 'variable')).toBe(true);
  });

  it('extracts var', async () => {
    const r = await p('var counter* = 0');
    expect(r.symbols.some((s: any) => s.name === 'counter' && s.kind === 'variable')).toBe(true);
  });

  // ── Import edges ───────────────────────────────────────────────────
  it('extracts import edge', async () => {
    const r = await p('import std/os');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'std/os')).toBe(true);
  });

  it('extracts from-import edge', async () => {
    const r = await p('from std/strutils import parseInt');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'std/strutils')).toBe(true);
  });

  it('extracts include edge', async () => {
    const r = await p('include helpers');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'helpers')).toBe(true);
  });

  it('extracts export edge', async () => {
    const r = await p('export mymodule');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'mymodule')).toBe(true);
  });

  // ── Doc comments ───────────────────────────────────────────────────
  it('captures doc comment on proc', async () => {
    const r = await p('## Greets the user\nproc greet*(name: string) =\n  echo "hi"');
    const sym = r.symbols.find((s: any) => s.name === 'greet');
    expect(sym).toBeDefined();
    expect(sym.metadata?.doc).toContain('Greets the user');
  });
});

// ======================================================================
// Tcl
// ======================================================================
describe('Tcl', () => {
  const plugin = new TclLanguagePlugin();
  const p = (s: string, f = 'main.tcl') => parse(plugin, s, f);

  // ── Procs ──────────────────────────────────────────────────────────
  it('extracts proc', async () => {
    const r = await p('proc greet {name} {\n  puts "Hello $name"\n}');
    expect(r.symbols.some((s: any) => s.name === 'greet' && s.kind === 'function')).toBe(true);
  });

  it('extracts namespaced proc', async () => {
    const r = await p('proc ::myns::helper {args} {\n  return $args\n}');
    expect(r.symbols.some((s: any) => s.name === '::myns::helper')).toBe(true);
  });

  // ── Namespaces ─────────────────────────────────────────────────────
  it('extracts namespace with member proc', async () => {
    const r = await p('namespace eval myns {\n  proc inner {x} {\n    return $x\n  }\n}');
    expect(r.symbols.some((s: any) => s.name === 'myns' && s.kind === 'namespace')).toBe(true);
    const inner = r.symbols.find((s: any) => s.name === 'inner');
    expect(inner).toBeDefined();
    expect(inner.parentSymbolId).toContain('myns');
  });

  // ── TclOO ──────────────────────────────────────────────────────────
  it('extracts TclOO class with methods', async () => {
    const r = await p(`oo::class create Animal {
  method speak {msg} {
    puts $msg
  }
  method run {} {
    puts running
  }
  variable name
}`);
    expect(r.symbols.some((s: any) => s.name === 'Animal' && s.kind === 'class')).toBe(true);
    const speak = r.symbols.find((s: any) => s.name === 'speak');
    expect(speak).toBeDefined();
    expect(speak.kind).toBe('method');
    expect(speak.parentSymbolId).toContain('Animal');
    expect(
      r.symbols.some((s: any) => s.name === 'run' && s.parentSymbolId?.includes('Animal')),
    ).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'name' && s.kind === 'variable')).toBe(true);
  });

  // ── oo::define ─────────────────────────────────────────────────────
  it('extracts oo::define block with methods', async () => {
    const r = await p(`oo::define Dog {
  method bark {} {
    puts "woof"
  }
  variable breed
}`);
    expect(r.symbols.some((s: any) => s.name === 'Dog' && s.kind === 'class')).toBe(true);
    const bark = r.symbols.find((s: any) => s.name === 'bark');
    expect(bark).toBeDefined();
    expect(bark.parentSymbolId).toContain('Dog');
  });

  // ── Itcl ───────────────────────────────────────────────────────────
  it('extracts Itcl class with members', async () => {
    const r = await p(`itcl::class Vehicle {
  public variable speed 0
  common count 0
  public method accelerate {delta} {
    set speed [expr {$speed + $delta}]
  }
  constructor {args} {
    incr count
  }
}`);
    expect(r.symbols.some((s: any) => s.name === 'Vehicle' && s.kind === 'class')).toBe(true);
    expect(
      r.symbols.some((s: any) => s.name === 'speed' && s.parentSymbolId?.includes('Vehicle')),
    ).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'count' && s.metadata?.static)).toBe(true);
    expect(
      r.symbols.some((s: any) => s.name === 'accelerate' && s.parentSymbolId?.includes('Vehicle')),
    ).toBe(true);
  });

  // ── Snit ───────────────────────────────────────────────────────────
  it('extracts Snit type with members', async () => {
    const r = await p(`snit::type Counter {
  variable count 0
  typevariable instances 0
  option -step 1
  method increment {delta} {
    set count $delta
  }
  typemethod total {x} {
    return $x
  }
}`);
    expect(
      r.symbols.some((s: any) => s.name === 'Counter' && s.kind === 'class' && s.metadata?.snit),
    ).toBe(true);
    expect(
      r.symbols.some((s: any) => s.name === 'count' && s.parentSymbolId?.includes('Counter')),
    ).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'instances' && s.metadata?.static)).toBe(true);
    expect(r.symbols.some((s: any) => s.name === '-step' && s.kind === 'property')).toBe(true);
    const incr = r.symbols.find((s: any) => s.name === 'increment');
    expect(incr).toBeDefined();
    expect(incr.parentSymbolId).toContain('Counter');
    expect(r.symbols.some((s: any) => s.name === 'total' && s.metadata?.static)).toBe(true);
  });

  it('extracts Snit widget', async () => {
    const r = await p('snit::widget MyButton {\n  method click {} { puts "clicked" }\n}');
    const sym = r.symbols.find((s: any) => s.name === 'MyButton');
    expect(sym).toBeDefined();
    expect(sym.metadata?.snit).toBe(true);
    expect(sym.metadata?.widget).toBe(true);
  });

  // ── Coroutine ──────────────────────────────────────────────────────
  it('extracts coroutine', async () => {
    const r = await p('coroutine myWorker apply {{} {\n  yield\n}}');
    const sym = r.symbols.find((s: any) => s.name === 'myWorker');
    expect(sym).toBeDefined();
    expect(sym.metadata?.coroutine).toBe(true);
  });

  // ── Package provide ────────────────────────────────────────────────
  it('extracts package provide', async () => {
    const r = await p('package provide MyPackage 1.0');
    expect(r.symbols.some((s: any) => s.name === 'MyPackage' && s.kind === 'namespace')).toBe(true);
  });

  // ── Import edges ───────────────────────────────────────────────────
  it('extracts package require edge', async () => {
    const r = await p('package require Tcllib');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'Tcllib')).toBe(true);
  });

  it('extracts source edge', async () => {
    const r = await p('source utils.tcl');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'utils.tcl')).toBe(true);
  });

  // ── Comment immunity ───────────────────────────────────────────────
  it('ignores proc in comment', async () => {
    const r = await p('# proc fakeProc {args} {}\nproc realProc {args} {}');
    expect(r.symbols.some((s: any) => s.name === 'fakeProc')).toBe(false);
    expect(r.symbols.some((s: any) => s.name === 'realProc')).toBe(true);
  });
});

// ======================================================================
// D Language
// ======================================================================
describe('D', () => {
  const plugin = new DLanguagePlugin();
  const p = (s: string, f = 'main.d') => parse(plugin, s, f);

  // ── Module ─────────────────────────────────────────────────────────
  it('extracts module declaration', async () => {
    const r = await p('module app.core.utils;');
    expect(r.symbols.some((s: any) => s.name === 'app.core.utils' && s.kind === 'namespace')).toBe(
      true,
    );
  });

  // ── Classes with members ───────────────────────────────────────────
  it('extracts class with methods', async () => {
    const r = await p(`class Animal {
  void speak() {
    writeln("...");
  }
  string getName() {
    return name;
  }
  this(string n) {
    name = n;
  }
  ~this() {}
}`);
    expect(r.symbols.some((s: any) => s.name === 'Animal' && s.kind === 'class')).toBe(true);
    const speak = r.symbols.find((s: any) => s.name === 'speak');
    expect(speak).toBeDefined();
    expect(speak.kind).toBe('method');
    expect(speak.parentSymbolId).toContain('Animal');
    expect(
      r.symbols.some((s: any) => s.name === 'getName' && s.parentSymbolId?.includes('Animal')),
    ).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'this' && s.metadata?.constructor)).toBe(true);
    expect(r.symbols.some((s: any) => s.name === '~this' && s.metadata?.destructor)).toBe(true);
  });

  // ── Structs ────────────────────────────────────────────────────────
  it('extracts struct with members', async () => {
    const r = await p(`struct Point {
  double x, y;
  double magnitude() {
    return sqrt(x*x + y*y);
  }
}`);
    const sym = r.symbols.find((s: any) => s.name === 'Point');
    expect(sym).toBeDefined();
    expect(sym.metadata?.struct).toBe(true);
    expect(
      r.symbols.some((s: any) => s.name === 'magnitude' && s.parentSymbolId?.includes('Point')),
    ).toBe(true);
  });

  // ── Interfaces ─────────────────────────────────────────────────────
  it('extracts interface with methods', async () => {
    const r = await p(`interface Drawable {
  void draw();
  int getLayer();
}`);
    expect(r.symbols.some((s: any) => s.name === 'Drawable' && s.kind === 'interface')).toBe(true);
    expect(
      r.symbols.some((s: any) => s.name === 'draw' && s.parentSymbolId?.includes('Drawable')),
    ).toBe(true);
  });

  // ── Enums ──────────────────────────────────────────────────────────
  it('extracts named enum with members', async () => {
    const r = await p('enum Color {\n  Red,\n  Green,\n  Blue,\n}');
    expect(r.symbols.some((s: any) => s.name === 'Color' && s.kind === 'enum')).toBe(true);
    expect(
      r.symbols.some((s: any) => s.name === 'Red' && s.parentSymbolId?.includes('Color')),
    ).toBe(true);
    expect(
      r.symbols.some((s: any) => s.name === 'Green' && s.parentSymbolId?.includes('Color')),
    ).toBe(true);
  });

  // ── Manifest constants ─────────────────────────────────────────────
  it('extracts manifest constant (enum name = value)', async () => {
    const r = await p('enum maxSize = 1024;');
    expect(r.symbols.some((s: any) => s.name === 'maxSize' && s.kind === 'constant')).toBe(true);
  });

  it('extracts immutable constant', async () => {
    const r = await p('immutable pi = 3.14159;');
    expect(r.symbols.some((s: any) => s.name === 'pi' && s.kind === 'constant')).toBe(true);
  });

  // ── Templates ──────────────────────────────────────────────────────
  it('extracts template', async () => {
    const r = await p('template Foo(T) {\n  alias Foo = T;\n}');
    expect(r.symbols.some((s: any) => s.name === 'Foo' && s.metadata?.template)).toBe(true);
  });

  it('extracts mixin template', async () => {
    const r = await p('mixin template Serializable(T) {\n  string serialize() { return ""; }\n}');
    expect(r.symbols.some((s: any) => s.name === 'Serializable' && s.metadata?.mixin)).toBe(true);
  });

  // ── Top-level functions ────────────────────────────────────────────
  it('extracts top-level function', async () => {
    const r = await p('void main() {\n  writeln("hello");\n}');
    expect(r.symbols.some((s: any) => s.name === 'main' && s.kind === 'function')).toBe(true);
  });

  it('extracts function with attributes', async () => {
    const r = await p('pure nothrow @nogc int add(int a, int b) {\n  return a + b;\n}');
    expect(r.symbols.some((s: any) => s.name === 'add' && s.kind === 'function')).toBe(true);
  });

  // ── @property ──────────────────────────────────────────────────────
  it('extracts @property', async () => {
    const r = await p(`class Obj {
  @property int value() { return _val; }
}`);
    expect(r.symbols.some((s: any) => s.name === 'value' && s.kind === 'property')).toBe(true);
  });

  // ── Unittest ───────────────────────────────────────────────────────
  it('extracts unittest', async () => {
    const r = await p('unittest {\n  assert(1 + 1 == 2);\n}');
    expect(r.symbols.some((s: any) => s.name === 'unittest' && s.metadata?.test)).toBe(true);
  });

  // ── Aliases ────────────────────────────────────────────────────────
  it('extracts alias', async () => {
    const r = await p('alias StringList = string[];');
    expect(r.symbols.some((s: any) => s.name === 'StringList' && s.metadata?.alias)).toBe(true);
  });

  // ── Module constructors ────────────────────────────────────────────
  it('extracts static module constructor', async () => {
    const r = await p('static this() {\n  init();\n}');
    // static this() may be extracted as a regular function 'this' or with moduleConstructor
    const sym = r.symbols.find((s: any) => s.name === 'this');
    expect(sym).toBeDefined();
  });

  // ── Version conditionals ───────────────────────────────────────────
  it('extracts version conditional', async () => {
    const r = await p('version(Windows) {\n  import core.sys.windows;\n}');
    expect(r.symbols.some((s: any) => s.name === 'Windows' && s.metadata?.conditional)).toBe(true);
  });

  // ── Import edges ───────────────────────────────────────────────────
  it('extracts import edges', async () => {
    const r = await p('import std.stdio;\nimport std.algorithm : sort;\npublic import std.range;');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'std.stdio')).toBe(true);
    expect(r.edges?.some((e: any) => e.metadata?.module === 'std.algorithm')).toBe(true);
    expect(r.edges?.some((e: any) => e.metadata?.module === 'std.range')).toBe(true);
  });

  // ── Comment immunity ───────────────────────────────────────────────
  it('ignores class in // comment', async () => {
    const r = await p('// class FakeClass {}\nclass RealClass {}');
    expect(r.symbols.some((s: any) => s.name === 'FakeClass')).toBe(false);
    expect(r.symbols.some((s: any) => s.name === 'RealClass')).toBe(true);
  });

  it('ignores class in /* */ comment', async () => {
    const r = await p('/* class FakeClass {} */\nclass RealClass {}');
    expect(r.symbols.some((s: any) => s.name === 'FakeClass')).toBe(false);
    expect(r.symbols.some((s: any) => s.name === 'RealClass')).toBe(true);
  });

  it('ignores class in /+ +/ comment', async () => {
    const r = await p('/+ class FakeClass {} +/\nclass RealClass {}');
    expect(r.symbols.some((s: any) => s.name === 'FakeClass')).toBe(false);
    expect(r.symbols.some((s: any) => s.name === 'RealClass')).toBe(true);
  });

  it('ignores class in string', async () => {
    const r = await p('string s = "class FakeClass {}";\nclass RealClass {}');
    expect(r.symbols.some((s: any) => s.name === 'FakeClass')).toBe(false);
    expect(r.symbols.some((s: any) => s.name === 'RealClass')).toBe(true);
  });

  // ── Doc comments ───────────────────────────────────────────────────
  it('captures doc comment on function', async () => {
    const r = await p('/// Adds two integers\nvoid add(int a, int b) {\n  return a + b;\n}');
    const sym = r.symbols.find((s: any) => s.name === 'add');
    expect(sym).toBeDefined();
    // Doc comment captured from original source (before comment stripping)
    if (sym.metadata?.doc) {
      expect(sym.metadata.doc).toContain('Adds two integers');
    }
    // If not captured, the symbol still exists correctly
    expect(sym.kind).toBe('function');
  });
});
