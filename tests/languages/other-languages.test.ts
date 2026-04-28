/**
 * Tests for all remaining regex-based language plugins.
 */
import { describe, expect, it } from 'vitest';
import { AlLanguagePlugin } from '../../src/indexer/plugins/language/al/index.js';
import { AssemblyLanguagePlugin } from '../../src/indexer/plugins/language/assembly/index.js';
import { AutoHotkeyLanguagePlugin } from '../../src/indexer/plugins/language/autohotkey/index.js';
import { BashLanguagePlugin } from '../../src/indexer/plugins/language/bash/index.js';
import { BladeLanguagePlugin } from '../../src/indexer/plugins/language/blade/index.js';
import { EjsLanguagePlugin } from '../../src/indexer/plugins/language/ejs/index.js';
import { ElixirLanguagePlugin } from '../../src/indexer/plugins/language/elixir/index.js';
import { ErlangLanguagePlugin } from '../../src/indexer/plugins/language/erlang/index.js';
import { FortranLanguagePlugin } from '../../src/indexer/plugins/language/fortran/index.js';
import { GdscriptLanguagePlugin } from '../../src/indexer/plugins/language/gdscript/index.js';
import { GleamLanguagePlugin } from '../../src/indexer/plugins/language/gleam/index.js';
import { GroovyLanguagePlugin } from '../../src/indexer/plugins/language/groovy/index.js';
import { HaskellLanguagePlugin } from '../../src/indexer/plugins/language/haskell/index.js';
import { HclLanguagePlugin } from '../../src/indexer/plugins/language/hcl/index.js';
import { JsonLanguagePlugin } from '../../src/indexer/plugins/language/json-lang/index.js';
import { JuliaLanguagePlugin } from '../../src/indexer/plugins/language/julia/index.js';
import { LuaLanguagePlugin } from '../../src/indexer/plugins/language/lua/index.js';
import { NixLanguagePlugin } from '../../src/indexer/plugins/language/nix/index.js';
import { PerlLanguagePlugin } from '../../src/indexer/plugins/language/perl/index.js';
import { ProtobufLanguagePlugin } from '../../src/indexer/plugins/language/protobuf/index.js';
import { RLanguagePlugin } from '../../src/indexer/plugins/language/r/index.js';
import { SqlLanguagePlugin } from '../../src/indexer/plugins/language/sql/index.js';
import { TomlLanguagePlugin } from '../../src/indexer/plugins/language/toml/index.js';
import { VerseLanguagePlugin } from '../../src/indexer/plugins/language/verse/index.js';
import { YamlLanguagePlugin } from '../../src/indexer/plugins/language/yaml-lang/index.js';

// Helper to parse and unwrap (handles both sync and async extractSymbols)
function parse(
  plugin: { extractSymbols: (f: string, c: Buffer) => any },
  source: string,
  filePath: string,
): any {
  const resultOrPromise = plugin.extractSymbols(filePath, Buffer.from(source));
  // If the plugin returns a Promise, resolve it first
  if (resultOrPromise && typeof resultOrPromise.then === 'function') {
    return resultOrPromise.then((result: any) => {
      expect(result.isOk()).toBe(true);
      return result._unsafeUnwrap();
    });
  }
  expect(resultOrPromise.isOk()).toBe(true);
  return resultOrPromise._unsafeUnwrap();
}

// ==============================
// 1. Groovy
// ==============================
describe('Groovy', () => {
  const plugin = new GroovyLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'Main.groovy');

  it('extracts class', () => {
    const r = p('class MyService {}');
    expect(r.symbols.some((s: any) => s.name === 'MyService' && s.kind === 'class')).toBe(true);
  });

  it('extracts def method', () => {
    const r = p('def greet(name) {');
    expect(r.symbols.some((s: any) => s.name === 'greet' && s.kind === 'function')).toBe(true);
  });

  it('extracts typed method', () => {
    const r = p('String getName() {');
    expect(r.symbols.some((s: any) => s.name === 'getName' && s.kind === 'function')).toBe(true);
  });

  it('extracts import edge', () => {
    const r = p('import groovy.json.JsonSlurper');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'groovy.json.JsonSlurper')).toBe(true);
  });
});

// ==============================
// 3. Elixir
// ==============================
describe('Elixir', () => {
  const plugin = new ElixirLanguagePlugin();
  async function parseElixir(s: string) {
    const result = await plugin.extractSymbols('lib/app.ex', Buffer.from(s));
    expect(result.isOk()).toBe(true);
    return result._unsafeUnwrap();
  }

  it('extracts defmodule', async () => {
    const r = await parseElixir('defmodule MyApp.Users do\nend');
    expect(r.symbols.some((s: any) => s.name === 'MyApp.Users' && s.kind === 'class')).toBe(true);
  });

  it('extracts def and defp', async () => {
    const r = await parseElixir('  def hello(name) do\n  end\n  defp internal(x) do\n  end');
    expect(r.symbols.some((s: any) => s.name === 'hello' && s.kind === 'function')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'internal' && s.kind === 'function')).toBe(true);
  });

  it('extracts defmacro', async () => {
    const r = await parseElixir('  defmacro my_macro(arg) do\n  end');
    expect(r.symbols.some((s: any) => s.name === 'my_macro' && s.kind === 'function')).toBe(true);
  });

  it('extracts @type and use/import edges', async () => {
    const r = await parseElixir('  @type user :: map()\n  use GenServer\n  import Enum');
    expect(r.symbols.some((s: any) => s.name === 'user' && s.kind === 'type')).toBe(true);
    expect(r.edges?.some((e: any) => e.metadata?.module === 'GenServer')).toBe(true);
    expect(r.edges?.some((e: any) => e.metadata?.module === 'Enum')).toBe(true);
  });
});

// ==============================
// 4. Erlang
// ==============================
describe('Erlang', () => {
  const plugin = new ErlangLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'my_mod.erl');

  it('extracts -module', () => {
    const r = p('-module(my_mod).');
    expect(r.symbols.some((s: any) => s.name === 'my_mod' && s.kind === 'namespace')).toBe(true);
  });

  it('extracts -record and -define', () => {
    const r = p('-record(user, {name, age}).\n-define(MAX, 100).');
    expect(r.symbols.some((s: any) => s.name === 'user' && s.kind === 'class')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'MAX' && s.kind === 'constant')).toBe(true);
  });

  it('extracts -type and exported function', () => {
    const r = p('-export([hello/1]).\n-type age() :: integer().\nhello(Name) -> ok.');
    expect(r.symbols.some((s: any) => s.name === 'age' && s.kind === 'type')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'hello' && s.kind === 'function')).toBe(true);
  });
});

// ==============================
// 5. Haskell
// ==============================
describe('Haskell', () => {
  const plugin = new HaskellLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'Main.hs');

  it('extracts module declaration', () => {
    const r = p('module Data.List where');
    expect(r.symbols.some((s: any) => s.name === 'Data.List' && s.kind === 'namespace')).toBe(true);
  });

  it('extracts data type', () => {
    const r = p('data Maybe a = Nothing | Just a');
    expect(r.symbols.some((s: any) => s.name === 'Maybe' && s.kind === 'type')).toBe(true);
  });

  it('extracts type class', () => {
    const r = p('class Eq a where\n  (==) :: a -> a -> Bool');
    expect(r.symbols.some((s: any) => s.name === 'Eq' && s.kind === 'interface')).toBe(true);
  });

  it('extracts type signature and import', () => {
    const r = p('import Data.Map\nmain :: IO ()\nmain = putStrLn "hello"');
    expect(r.symbols.some((s: any) => s.name === 'main' && s.kind === 'function')).toBe(true);
    expect(r.edges?.some((e: any) => e.metadata?.module === 'Data.Map')).toBe(true);
  });
});

// ==============================
// 6. Gleam
// ==============================
describe('Gleam', () => {
  const plugin = new GleamLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'app.gleam');

  it('extracts pub fn', () => {
    const r = p('pub fn hello(name: String) -> String {');
    expect(r.symbols.some((s: any) => s.name === 'hello' && s.kind === 'function')).toBe(true);
  });

  it('extracts type', () => {
    const r = p('pub type User {\n  User(name: String)\n}');
    expect(r.symbols.some((s: any) => s.name === 'User' && s.kind === 'type')).toBe(true);
  });

  it('extracts const', () => {
    const r = p('pub const max_size = 100');
    expect(r.symbols.some((s: any) => s.name === 'max_size' && s.kind === 'constant')).toBe(true);
  });

  it('extracts import edge', () => {
    const r = p('import gleam/io');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'gleam/io')).toBe(true);
  });
});

// ==============================
// 7. Bash
// ==============================
describe('Bash', () => {
  const plugin = new BashLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'script.sh');

  it('extracts function keyword', async () => {
    const r = await p('function setup {\n  echo "hi"\n}');
    expect(r.symbols.some((s: any) => s.name === 'setup' && s.kind === 'function')).toBe(true);
  });

  it('extracts name() { form', async () => {
    const r = await p('cleanup() {\n  rm -rf /tmp/x\n}');
    expect(r.symbols.some((s: any) => s.name === 'cleanup' && s.kind === 'function')).toBe(true);
  });

  it('extracts readonly and export', async () => {
    const r = await p('readonly MAX_RETRIES=5\nexport PATH_PREFIX=/usr/local');
    expect(r.symbols.some((s: any) => s.name === 'MAX_RETRIES' && s.kind === 'constant')).toBe(
      true,
    );
    expect(r.symbols.some((s: any) => s.name === 'PATH_PREFIX' && s.kind === 'variable')).toBe(
      true,
    );
  });
});

// ==============================
// 8. Lua
// ==============================
describe('Lua', () => {
  const plugin = new LuaLanguagePlugin();
  async function parseLua(s: string) {
    const result = await plugin.extractSymbols('main.lua', Buffer.from(s));
    expect(result.isOk()).toBe(true);
    return result._unsafeUnwrap();
  }

  it('extracts global function', async () => {
    const r = await parseLua('function greet(name)\n  print(name)\nend');
    expect(r.symbols.some((s: any) => s.name === 'greet' && s.kind === 'function')).toBe(true);
  });

  it('extracts local function', async () => {
    const r = await parseLua('local function helper(x)\n  return x + 1\nend');
    expect(r.symbols.some((s: any) => s.name === 'helper' && s.kind === 'function')).toBe(true);
  });

  it('extracts Module.method and Module:method', async () => {
    const r = await parseLua('function MyMod.init(self)\nend\nfunction MyMod:update(dt)\nend');
    expect(r.symbols.some((s: any) => s.name === 'init' && s.kind === 'method')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'update' && s.kind === 'method')).toBe(true);
  });

  it('extracts require edge', async () => {
    const r = await parseLua('local json = require("dkjson")');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'dkjson')).toBe(true);
  });
});

// ==============================
// 9. Perl
// ==============================
describe('Perl', () => {
  const plugin = new PerlLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'module.pl');

  it('extracts sub', () => {
    const r = p('sub process_data {\n  my ($arg) = @_;\n}');
    expect(r.symbols.some((s: any) => s.name === 'process_data' && s.kind === 'function')).toBe(
      true,
    );
  });

  it('extracts package', () => {
    const r = p('package My::Module;');
    expect(r.symbols.some((s: any) => s.name === 'My::Module' && s.kind === 'namespace')).toBe(
      true,
    );
  });

  it('extracts use edge', () => {
    const r = p('use strict;\nuse My::Module;');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'strict')).toBe(true);
    expect(r.edges?.some((e: any) => e.metadata?.module === 'My::Module')).toBe(true);
  });
});

// ==============================
// 10. GDScript
// ==============================
describe('GDScript', () => {
  const plugin = new GdscriptLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'player.gd');

  it('extracts func and class_name', () => {
    const r = p('class_name Player\nfunc move(dir) :\n  pass');
    expect(r.symbols.some((s: any) => s.name === 'Player' && s.kind === 'class')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'move' && s.kind === 'function')).toBe(true);
  });

  it('extracts enum and signal', () => {
    const r = p('enum Direction {\n  UP, DOWN\n}\nsignal health_changed');
    expect(r.symbols.some((s: any) => s.name === 'Direction' && s.kind === 'enum')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'health_changed' && s.kind === 'property')).toBe(
      true,
    );
  });

  it('extracts const and var', () => {
    const r = p('const MAX_SPEED = 200\nvar velocity = Vector2.ZERO');
    expect(r.symbols.some((s: any) => s.name === 'MAX_SPEED' && s.kind === 'constant')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'velocity' && s.kind === 'property')).toBe(true);
  });
});

// ==============================
// 11. R
// ==============================
describe('R', () => {
  const plugin = new RLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'analysis.R');

  it('extracts name <- function()', () => {
    const r = p('clean_data <- function(df) {\n  df\n}');
    expect(r.symbols.some((s: any) => s.name === 'clean_data' && s.kind === 'function')).toBe(true);
  });

  it('extracts library() edge', () => {
    const r = p('library(ggplot2)\nrequire(dplyr)');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'ggplot2')).toBe(true);
    expect(r.edges?.some((e: any) => e.metadata?.module === 'dplyr')).toBe(true);
  });
});

// ==============================
// 12. Julia
// ==============================
describe('Julia', () => {
  const plugin = new JuliaLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'main.jl');

  it('extracts function and struct', () => {
    const r = p('function greet(name)\n  println(name)\nend\nstruct Point\n  x::Float64\nend');
    expect(r.symbols.some((s: any) => s.name === 'greet' && s.kind === 'function')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'Point' && s.kind === 'class')).toBe(true);
  });

  it('extracts module and const', () => {
    const r = p('module MyLib\nconst VERSION = "1.0"\nend');
    expect(r.symbols.some((s: any) => s.name === 'MyLib' && s.kind === 'namespace')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'VERSION' && s.kind === 'constant')).toBe(true);
  });

  it('extracts using edge', () => {
    const r = p('using LinearAlgebra');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'LinearAlgebra')).toBe(true);
  });
});

// ==============================
// 13. Nix
// ==============================
describe('Nix', () => {
  const plugin = new NixLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'default.nix');

  it('extracts attribute bindings', () => {
    const r = p('pkgs = import <nixpkgs> {};\nversion = "1.0";');
    expect(r.symbols.some((s: any) => s.name === 'version' && s.kind === 'variable')).toBe(true);
  });

  it('extracts import edge', () => {
    const r = p('let\n  pkgs = import <nixpkgs> {};\nin pkgs');
    expect(r.edges?.some((e: any) => e.metadata?.module === '<nixpkgs>')).toBe(true);
  });
});

// ==============================
// 14. SQL
// ==============================
describe('SQL', () => {
  const plugin = new SqlLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'schema.sql');

  it('extracts CREATE TABLE', () => {
    const r = p('CREATE TABLE users (\n  id INT PRIMARY KEY\n);');
    expect(r.symbols.some((s: any) => s.name === 'users' && s.kind === 'class')).toBe(true);
  });

  it('extracts CREATE FUNCTION', () => {
    const r = p('CREATE FUNCTION get_user(uid INT) RETURNS TABLE AS $$\nBEGIN\nEND;\n$$;');
    expect(r.symbols.some((s: any) => s.name === 'get_user' && s.kind === 'function')).toBe(true);
  });

  it('extracts WITH cte AS', () => {
    const r = p('WITH active_users AS (\n  SELECT * FROM users\n)\nSELECT * FROM active_users;');
    expect(r.symbols.some((s: any) => s.name === 'active_users' && s.kind === 'variable')).toBe(
      true,
    );
  });

  it('extracts CREATE VIEW', () => {
    const r = p('CREATE VIEW user_summary AS\nSELECT id, name FROM users;');
    expect(r.symbols.some((s: any) => s.name === 'user_summary' && s.kind === 'class')).toBe(true);
  });
});

// ==============================
// 15. HCL
// ==============================
describe('HCL', () => {
  const plugin = new HclLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'main.tf');

  it('extracts resource', () => {
    const r = p('resource "aws_instance" "web" {\n  ami = "abc"\n}');
    expect(r.symbols.some((s: any) => s.name === 'web' && s.kind === 'class')).toBe(true);
  });

  it('extracts variable and output', () => {
    const r = p(
      'variable "region" {\n  default = "us-east-1"\n}\noutput "ip" {\n  value = "1.2.3.4"\n}',
    );
    expect(r.symbols.some((s: any) => s.name === 'region' && s.kind === 'variable')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'ip' && s.kind === 'variable')).toBe(true);
  });

  it('extracts module', () => {
    const r = p('module "vpc" {\n  source = "./modules/vpc"\n}');
    expect(r.symbols.some((s: any) => s.name === 'vpc' && s.kind === 'namespace')).toBe(true);
  });
});

// ==============================
// 16. Protobuf
// ==============================
describe('Protobuf', () => {
  const plugin = new ProtobufLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'api.proto');

  it('extracts message and enum', () => {
    const r = p('message User {\n  string name = 1;\n}\nenum Status {\n  ACTIVE = 0;\n}');
    expect(r.symbols.some((s: any) => s.name === 'User' && s.kind === 'class')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'Status' && s.kind === 'enum')).toBe(true);
  });

  it('extracts service and rpc', () => {
    const r = p('service UserService {\n  rpc GetUser(GetUserRequest) returns (User);\n}');
    expect(r.symbols.some((s: any) => s.name === 'UserService' && s.kind === 'interface')).toBe(
      true,
    );
    expect(r.symbols.some((s: any) => s.name === 'GetUser' && s.kind === 'method')).toBe(true);
  });

  it('extracts import edge', () => {
    const r = p('import "google/protobuf/timestamp.proto";');
    expect(
      r.edges?.some((e: any) => e.metadata?.module === 'google/protobuf/timestamp.proto'),
    ).toBe(true);
  });
});

// ==============================
// 17. YAML
// ==============================
describe('YAML', () => {
  const plugin = new YamlLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'config.yaml');

  it('extracts top-level keys', () => {
    const r = p('name: my-app\nversion: 1.0\ndependencies:\n  lodash: "^4"');
    expect(r.symbols.some((s: any) => s.name === 'name' && s.kind === 'constant')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'version' && s.kind === 'constant')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'dependencies' && s.kind === 'constant')).toBe(
      true,
    );
  });
});

// ==============================
// 18. JSON
// ==============================
describe('JSON', () => {
  const plugin = new JsonLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'package.json');

  it('extracts first-level keys', async () => {
    const r = await p('{\n  "name": "my-app",\n  "version": "1.0.0"\n}');
    expect(r.symbols.some((s: any) => s.name === 'name' && s.kind === 'constant')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'version' && s.kind === 'constant')).toBe(true);
  });
});

// ==============================
// 19. TOML
// ==============================
describe('TOML', () => {
  const plugin = new TomlLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'config.toml');

  it('extracts [table] and key = value', async () => {
    const r = await p('name = "my-app"\n\n[dependencies]\nlodash = "^4"');
    expect(r.symbols.some((s: any) => s.name === 'dependencies' && s.kind === 'namespace')).toBe(
      true,
    );
    expect(r.symbols.some((s: any) => s.name === 'name' && s.kind === 'constant')).toBe(true);
  });

  it('extracts key = value inside tables', async () => {
    const r = await p('[package]\nversion = "1.0"');
    expect(r.symbols.some((s: any) => s.name === 'version' && s.kind === 'constant')).toBe(true);
  });
});

// ==============================
// 20. Assembly
// ==============================
describe('Assembly', () => {
  const plugin = new AssemblyLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'boot.asm');

  it('extracts labels', () => {
    const r = p('main:\n  push ebp\n  mov ebp, esp');
    expect(r.symbols.some((s: any) => s.name === 'main' && s.kind === 'function')).toBe(true);
  });

  it('extracts PROC and MACRO', () => {
    const r = p('myProc PROC\n  ret\nmyProc ENDP\nmyMacro MACRO\n  nop\nENDM');
    expect(r.symbols.some((s: any) => s.name === 'myProc' && s.kind === 'function')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'myMacro' && s.kind === 'function')).toBe(true);
  });

  it('extracts EQU and .global', () => {
    const r = p('BUFFER_SIZE EQU 1024\n.global _start');
    expect(r.symbols.some((s: any) => s.name === 'BUFFER_SIZE' && s.kind === 'constant')).toBe(
      true,
    );
    expect(r.symbols.some((s: any) => s.name === '_start' && s.kind === 'function')).toBe(true);
  });
});

// ==============================
// 21. Fortran
// ==============================
describe('Fortran', () => {
  const plugin = new FortranLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'solver.f90');

  it('extracts SUBROUTINE', () => {
    const r = p('subroutine solve(a, b, x)\n  implicit none\nend subroutine');
    expect(r.symbols.some((s: any) => s.name === 'solve' && s.kind === 'function')).toBe(true);
  });

  it('extracts FUNCTION', () => {
    const r = p('real function area(r)\n  area = 3.14 * r * r\nend function');
    expect(r.symbols.some((s: any) => s.name === 'area' && s.kind === 'function')).toBe(true);
  });

  it('extracts MODULE and USE edge', () => {
    const r = p('module math_utils\n  use iso_fortran_env\nend module');
    expect(r.symbols.some((s: any) => s.name === 'math_utils' && s.kind === 'namespace')).toBe(
      true,
    );
    expect(r.edges?.some((e: any) => e.metadata?.module === 'iso_fortran_env')).toBe(true);
  });
});

// ==============================
// 22. AutoHotkey
// ==============================
describe('AutoHotkey', () => {
  const plugin = new AutoHotkeyLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'script.ahk');

  it('extracts function', () => {
    const r = p('MyFunc(param1, param2) {\n  return param1\n}');
    expect(r.symbols.some((s: any) => s.name === 'MyFunc' && s.kind === 'function')).toBe(true);
  });

  it('extracts class', () => {
    const r = p('class MyClass {\n  static Method() {\n  }\n}');
    expect(r.symbols.some((s: any) => s.name === 'MyClass' && s.kind === 'class')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'Method' && s.kind === 'method')).toBe(true);
  });
});

// ==============================
// 23. Verse
// ==============================
describe('Verse', () => {
  const plugin = new VerseLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'game.verse');

  it('extracts class', () => {
    const r = p('my_device := class(creative_device):\n  var Count : int = 0');
    expect(r.symbols.some((s: any) => s.name === 'my_device' && s.kind === 'class')).toBe(true);
  });

  it('extracts method', () => {
    const r = p('  OnBegin<public>() : void =\n    Print("hello")');
    expect(r.symbols.some((s: any) => s.name === 'OnBegin' && s.kind === 'method')).toBe(true);
  });
});

// ==============================
// 24. AL
// ==============================
describe('AL', () => {
  const plugin = new AlLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'Customer.al');

  it('extracts table', () => {
    const r = p('table 50100 "Customer Ext"\n{\n}');
    expect(r.symbols.some((s: any) => s.name === 'Customer Ext' && s.kind === 'class')).toBe(true);
  });

  it('extracts codeunit', () => {
    const r = p('codeunit 50100 "Sales Processor"\n{\n}');
    expect(r.symbols.some((s: any) => s.name === 'Sales Processor' && s.kind === 'class')).toBe(
      true,
    );
  });

  it('extracts procedure', () => {
    const r = p('  procedure ProcessOrder(\n    OrderNo: Code[20])');
    expect(r.symbols.some((s: any) => s.name === 'ProcessOrder' && s.kind === 'function')).toBe(
      true,
    );
  });
});

// ==============================
// 25. Blade
// ==============================
describe('Blade', () => {
  const plugin = new BladeLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'view.blade.php');

  it('extracts @section', () => {
    const r = p("@section('content')\n  <h1>Hello</h1>\n@endsection");
    expect(r.symbols.some((s: any) => s.name === 'content' && s.kind === 'property')).toBe(true);
  });

  it('extracts @component', () => {
    const r = p("@component('alert')\n  Warning!\n@endcomponent");
    expect(r.symbols.some((s: any) => s.name === 'alert' && s.kind === 'property')).toBe(true);
  });

  it('extracts @extends edge', () => {
    const r = p("@extends('layouts.app')");
    expect(r.edges?.some((e: any) => e.metadata?.module === 'layouts.app')).toBe(true);
  });
});

// ==============================
// 26. EJS
// ==============================
describe('EJS', () => {
  const plugin = new EjsLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'template.ejs');

  it('extracts function inside <% %>', () => {
    const r = p('<% function formatDate(d) { return d.toISOString(); } %>');
    expect(r.symbols.some((s: any) => s.name === 'formatDate' && s.kind === 'function')).toBe(true);
  });

  it('extracts const inside <% %>', () => {
    const r = p('<% const title = "Hello" %>');
    expect(r.symbols.some((s: any) => s.name === 'title' && s.kind === 'variable')).toBe(true);
  });
});
