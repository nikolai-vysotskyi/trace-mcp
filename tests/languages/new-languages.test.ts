/**
 * Tests for new language plugins (Pascal, Ada, Solidity, PowerShell, Apex, PL/SQL)
 * and upgraded plugins (MATLAB, COBOL, Common Lisp, Zig, OCaml).
 */
import { describe, it, expect } from 'vitest';
import { PascalLanguagePlugin } from '../../src/indexer/plugins/language/pascal/index.js';
import { AdaLanguagePlugin } from '../../src/indexer/plugins/language/ada/index.js';
import { SolidityLanguagePlugin } from '../../src/indexer/plugins/language/solidity/index.js';
import { PowerShellLanguagePlugin } from '../../src/indexer/plugins/language/powershell/index.js';
import { ApexLanguagePlugin } from '../../src/indexer/plugins/language/apex/index.js';
import { PlsqlLanguagePlugin } from '../../src/indexer/plugins/language/plsql/index.js';
import { MatlabLanguagePlugin } from '../../src/indexer/plugins/language/matlab/index.js';
import { CobolLanguagePlugin } from '../../src/indexer/plugins/language/cobol/index.js';
import { CommonLispLanguagePlugin } from '../../src/indexer/plugins/language/common-lisp/index.js';
import { ZigLanguagePlugin } from '../../src/indexer/plugins/language/zig/index.js';
import { OcamlLanguagePlugin } from '../../src/indexer/plugins/language/ocaml/index.js';

// Helper to parse and unwrap (handles both sync and async extractSymbols)
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

// ==============================
// 1. Pascal / Delphi
// ==============================
describe('Pascal', () => {
  const plugin = new PascalLanguagePlugin();
  const p = (s: string, f = 'main.pas') => parse(plugin, s, f);

  it('extracts unit declaration', async () => {
    const r = await p('unit MyUnit;');
    expect(r.symbols.some((s: any) => s.name === 'MyUnit' && s.kind === 'module')).toBe(true);
  });

  it('extracts class type', async () => {
    const r = await p('TMyClass = class(TObject)\nend;');
    expect(r.symbols.some((s: any) => s.name === 'TMyClass' && s.kind === 'class')).toBe(true);
  });

  it('extracts interface type', async () => {
    const r = await p('IMyInterface = interface\nend;');
    expect(r.symbols.some((s: any) => s.name === 'IMyInterface' && s.kind === 'interface')).toBe(
      true,
    );
  });

  it('extracts procedure and function', async () => {
    const r = await p('procedure DoWork(x: Integer);\nfunction GetName: string;');
    expect(r.symbols.some((s: any) => s.name === 'DoWork' && s.kind === 'function')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'GetName' && s.kind === 'function')).toBe(true);
  });

  it('extracts property', async () => {
    const r = await p('property Name: string read FName write FName;');
    expect(r.symbols.some((s: any) => s.name === 'Name' && s.kind === 'property')).toBe(true);
  });

  it('extracts uses edge', async () => {
    const r = await p('uses SysUtils, Classes;');
    expect(r.edges?.some((e: any) => e.metadata?.module?.includes('SysUtils'))).toBe(true);
  });
});

// ==============================
// 2. Ada
// ==============================
describe('Ada', () => {
  const plugin = new AdaLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'main.adb');

  it('extracts package', async () => {
    const r = await p('package My_Package is\nend My_Package;');
    expect(r.symbols.some((s: any) => s.name === 'My_Package' && s.kind === 'namespace')).toBe(
      true,
    );
  });

  it('extracts procedure and function', async () => {
    const r = await p('procedure Init;\nfunction Compute(X : Integer) return Integer;');
    expect(r.symbols.some((s: any) => s.name === 'Init' && s.kind === 'function')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'Compute' && s.kind === 'function')).toBe(true);
  });

  it('extracts type record', async () => {
    const r = await p('type Person is record\n  Name : String;\nend record;');
    expect(r.symbols.some((s: any) => s.name === 'Person' && s.kind === 'class')).toBe(true);
  });

  it('extracts with/use edges', async () => {
    const r = await p('with Ada.Text_IO;\nuse Ada.Text_IO;');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'Ada.Text_IO')).toBe(true);
  });

  it('extracts exception declaration', async () => {
    const r = await p('Not_Found : exception;');
    expect(r.symbols.some((s: any) => s.name === 'Not_Found' && s.kind === 'constant')).toBe(true);
  });
});

// ==============================
// 3. Solidity
// ==============================
describe('Solidity', () => {
  const plugin = new SolidityLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'Token.sol');

  it('extracts contract', async () => {
    const r = await p('contract MyToken {\n}');
    expect(r.symbols.some((s: any) => s.name === 'MyToken' && s.kind === 'class')).toBe(true);
  });

  it('extracts interface', async () => {
    const r = await p(
      'interface IERC20 {\n  function totalSupply() external view returns (uint256);\n}',
    );
    expect(r.symbols.some((s: any) => s.name === 'IERC20' && s.kind === 'interface')).toBe(true);
  });

  it('extracts function inside contract', async () => {
    const r = await p(
      'contract Token {\n  function transfer(address to, uint256 amount) public returns (bool) {\n    return true;\n  }\n}',
    );
    expect(r.symbols.some((s: any) => s.name === 'transfer' && s.kind === 'method')).toBe(true);
  });

  it('extracts event', async () => {
    const r = await p(
      'contract Token {\n  event Transfer(address indexed from, address indexed to, uint256 value);\n}',
    );
    expect(r.symbols.some((s: any) => s.name === 'Transfer' && s.metadata?.event)).toBe(true);
  });

  it('extracts state variable', async () => {
    const r = await p('contract Token {\n  uint256 public totalSupply;\n}');
    expect(r.symbols.some((s: any) => s.name === 'totalSupply')).toBe(true);
  });

  it('extracts import edge', async () => {
    const r = await p('import "@openzeppelin/contracts/token/ERC20/ERC20.sol";');
    expect(r.edges?.some((e: any) => e.metadata?.module?.includes('ERC20.sol'))).toBe(true);
  });

  it('extracts enum', async () => {
    const r = await p('contract Token {\n  enum Status { Active, Paused }\n}');
    expect(r.symbols.some((s: any) => s.name === 'Status' && s.kind === 'enum')).toBe(true);
  });

  it('extracts struct inside contract', async () => {
    const r = await p(
      'contract Token {\n  struct Order {\n    uint256 amount;\n    address buyer;\n  }\n}',
    );
    expect(r.symbols.some((s: any) => s.name === 'Order' && s.metadata?.struct)).toBe(true);
  });
});

// ==============================
// 4. PowerShell
// ==============================
describe('PowerShell', () => {
  const plugin = new PowerShellLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'script.ps1');

  it('extracts Verb-Noun function', async () => {
    const r = await p('function Get-UserList {\n  param()\n}');
    expect(r.symbols.some((s: any) => s.name === 'Get-UserList' && s.kind === 'function')).toBe(
      true,
    );
  });

  it('extracts class', async () => {
    const r = await p('class MyLogger {\n  [void] Log([string]$msg) {}\n}');
    expect(r.symbols.some((s: any) => s.name === 'MyLogger' && s.kind === 'class')).toBe(true);
  });

  it('extracts enum', async () => {
    const r = await p('enum Color {\n  Red\n  Green\n  Blue\n}');
    expect(r.symbols.some((s: any) => s.name === 'Color' && s.kind === 'enum')).toBe(true);
  });

  it('extracts filter', async () => {
    const r = await p('filter Get-Even {\n  if ($_ % 2 -eq 0) { $_ }\n}');
    expect(r.symbols.some((s: any) => s.name === 'Get-Even' && s.kind === 'function')).toBe(true);
  });

  it('extracts Import-Module edge', async () => {
    const r = await p('Import-Module ActiveDirectory');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'ActiveDirectory')).toBe(true);
  });

  it('extracts using module edge', async () => {
    const r = await p('using module MyModule');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'MyModule')).toBe(true);
  });
});

// ==============================
// 5. Apex (Salesforce)
// ==============================
describe('Apex', () => {
  const plugin = new ApexLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'Account.cls');

  it('extracts class', async () => {
    const r = await p('public class AccountService {\n}');
    expect(r.symbols.some((s: any) => s.name === 'AccountService' && s.kind === 'class')).toBe(
      true,
    );
  });

  it('extracts interface', async () => {
    const r = await p('public interface IProcessor {\n}');
    expect(r.symbols.some((s: any) => s.name === 'IProcessor' && s.kind === 'interface')).toBe(
      true,
    );
  });

  it('extracts enum', async () => {
    const r = await p('public enum Season {\n  WINTER, SPRING, SUMMER, FALL\n}');
    expect(r.symbols.some((s: any) => s.name === 'Season' && s.kind === 'enum')).toBe(true);
  });

  it('extracts trigger', async () => {
    const r = await p('trigger AccountTrigger on Account (before insert, after update) {\n}');
    expect(r.symbols.some((s: any) => s.name === 'AccountTrigger' && s.metadata?.trigger)).toBe(
      true,
    );
  });

  it('extracts constant', async () => {
    const r = await p('static final Integer MAX_RETRIES = 3;');
    expect(r.symbols.some((s: any) => s.name === 'MAX_RETRIES' && s.kind === 'constant')).toBe(
      true,
    );
  });
});

// ==============================
// 6. PL/SQL
// ==============================
describe('PL/SQL', () => {
  const plugin = new PlsqlLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'pkg.pks');

  it('extracts package', async () => {
    const r = await p('CREATE OR REPLACE PACKAGE my_pkg AS\nEND my_pkg;');
    expect(r.symbols.some((s: any) => s.name === 'my_pkg' && s.kind === 'namespace')).toBe(true);
  });

  it('extracts procedure', async () => {
    const r = await p('CREATE OR REPLACE PROCEDURE do_work(p_id NUMBER) AS\nBEGIN\nEND;');
    expect(r.symbols.some((s: any) => s.name === 'do_work' && s.kind === 'function')).toBe(true);
  });

  it('extracts function', async () => {
    const r = await p(
      'CREATE FUNCTION get_name(p_id NUMBER) RETURN VARCHAR2 AS\nBEGIN\n  RETURN NULL;\nEND;',
    );
    expect(r.symbols.some((s: any) => s.name === 'get_name' && s.kind === 'function')).toBe(true);
  });

  it('extracts trigger', async () => {
    const r = await p('CREATE OR REPLACE TRIGGER trg_audit\n  BEFORE INSERT ON users\nBEGIN\nEND;');
    expect(r.symbols.some((s: any) => s.name === 'trg_audit' && s.metadata?.trigger)).toBe(true);
  });

  it('extracts type', async () => {
    const r = await p('CREATE TYPE address_t AS OBJECT (\n  street VARCHAR2(200)\n);');
    expect(r.symbols.some((s: any) => s.name === 'address_t' && s.kind === 'class')).toBe(true);
  });

  it('extracts view', async () => {
    const r = await p('CREATE OR REPLACE VIEW user_summary AS\nSELECT id, name FROM users;');
    expect(r.symbols.some((s: any) => s.name === 'user_summary' && s.kind === 'class')).toBe(true);
  });

  it('extracts cursor and exception', async () => {
    const r = await p('  CURSOR c_users IS SELECT * FROM users;\n  not_found EXCEPTION;');
    expect(r.symbols.some((s: any) => s.name === 'c_users' && s.kind === 'variable')).toBe(true);
    expect(r.symbols.some((s: any) => s.name === 'not_found' && s.kind === 'constant')).toBe(true);
  });
});

// ==============================
// 7. MATLAB (upgraded)
// ==============================
describe('MATLAB (upgraded)', () => {
  const plugin = new MatlabLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'matlab/MyClass.m');

  it('extracts function', async () => {
    const r = await p('function [out] = myFunc(x, y)\n  out = x + y;\nend');
    expect(r.symbols.some((s: any) => s.name === 'myFunc' && s.kind === 'function')).toBe(true);
  });

  it('extracts classdef', async () => {
    const r = await p('classdef MyClass < handle\nend');
    expect(r.symbols.some((s: any) => s.name === 'MyClass' && s.kind === 'class')).toBe(true);
  });

  it('extracts constant (all-caps)', async () => {
    const r = await p('MAX_ITERATIONS = 1000;');
    expect(r.symbols.some((s: any) => s.name === 'MAX_ITERATIONS' && s.kind === 'constant')).toBe(
      true,
    );
  });

  it('extracts import edge', async () => {
    const r = await p('import pkg.utils.*');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'pkg.utils.*')).toBe(true);
  });
});

// ==============================
// 8. COBOL (upgraded)
// ==============================
describe('COBOL (upgraded)', () => {
  const plugin = new CobolLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'main.cob');

  it('extracts PROGRAM-ID', async () => {
    const r = await p('       PROGRAM-ID. MY-PROGRAM.');
    expect(r.symbols.some((s: any) => s.name === 'MY-PROGRAM' && s.kind === 'module')).toBe(true);
  });

  it('extracts DIVISION', async () => {
    const r = await p('       DATA DIVISION.');
    expect(r.symbols.some((s: any) => s.name === 'DATA' && s.kind === 'namespace')).toBe(true);
  });

  it('extracts SECTION', async () => {
    const r = await p('       WORKING-STORAGE SECTION.');
    expect(r.symbols.some((s: any) => s.name === 'WORKING-STORAGE' && s.kind === 'class')).toBe(
      true,
    );
  });

  it('extracts 01-level record', async () => {
    const r = await p('       01 WS-RECORD.');
    expect(r.symbols.some((s: any) => s.name === 'WS-RECORD' && s.kind === 'class')).toBe(true);
  });

  it('extracts 77-level item', async () => {
    const r = await p('       77 WS-COUNTER PIC 9(4).');
    expect(r.symbols.some((s: any) => s.name === 'WS-COUNTER' && s.kind === 'variable')).toBe(true);
  });

  it('extracts 88-level condition', async () => {
    const r = await p('       88 WS-EOF VALUE "Y".');
    expect(r.symbols.some((s: any) => s.name === 'WS-EOF' && s.kind === 'constant')).toBe(true);
  });

  it('extracts COPY edge', async () => {
    const r = await p('       COPY WSRECORD.');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'WSRECORD')).toBe(true);
  });

  it('extracts CALL edge', async () => {
    const r = await p("       CALL 'SUB-PROGRAM'.");
    expect(r.edges?.some((e: any) => e.metadata?.module === 'SUB-PROGRAM')).toBe(true);
  });

  it('extracts PERFORM edge', async () => {
    const r = await p('       PERFORM PROCESS-RECORD.');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'PROCESS-RECORD')).toBe(true);
  });
});

// ==============================
// 9. Common Lisp (upgraded)
// ==============================
describe('Common Lisp (upgraded)', () => {
  const plugin = new CommonLispLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'app.lisp');

  it('extracts defun', async () => {
    const r = await p('(defun factorial (n)\n  (if (<= n 1) 1 (* n (factorial (1- n)))))');
    expect(r.symbols.some((s: any) => s.name === 'factorial' && s.kind === 'function')).toBe(true);
  });

  it('extracts defclass', async () => {
    const r = await p('(defclass person ()\n  ((name :accessor person-name :initarg :name)))');
    expect(r.symbols.some((s: any) => s.name === 'person' && s.kind === 'class')).toBe(true);
  });

  it('extracts defmacro', async () => {
    const r = await p('(defmacro with-gensyms ((&rest names) &body body)\n  `(let () ,@body))');
    expect(
      r.symbols.some(
        (s: any) => s.name === 'with-gensyms' && s.kind === 'function' && s.metadata?.macro,
      ),
    ).toBe(true);
  });

  it('extracts defmethod', async () => {
    const r = await p('(defmethod greet ((p person))\n  (format t "Hello ~a" (person-name p)))');
    expect(r.symbols.some((s: any) => s.name === 'greet' && s.kind === 'method')).toBe(true);
  });

  it('extracts defparameter and defvar', async () => {
    const r = await p('(defparameter *debug-mode* nil)\n(defvar *count* 0)');
    expect(r.symbols.some((s: any) => s.name === '*debug-mode*' && s.kind === 'variable')).toBe(
      true,
    );
    expect(r.symbols.some((s: any) => s.name === '*count*' && s.kind === 'variable')).toBe(true);
  });

  it('extracts defconstant', async () => {
    const r = await p('(defconstant +max-size+ 100)');
    expect(r.symbols.some((s: any) => s.name === '+max-size+' && s.kind === 'constant')).toBe(true);
  });

  it('extracts defsystem (ASDF)', async () => {
    const r = await p('(defsystem "my-project"\n  :depends-on ("cl-json" "hunchentoot"))');
    expect(
      r.symbols.some(
        (s: any) => s.name === 'my-project' && s.kind === 'module' && s.metadata?.asdf,
      ),
    ).toBe(true);
  });

  it('extracts define-setf-expander', async () => {
    const r = await p('(define-setf-expander my-accessor (place)\n  (values))');
    expect(
      r.symbols.some(
        (s: any) => s.name === 'my-accessor' && s.kind === 'function' && s.metadata?.setf,
      ),
    ).toBe(true);
  });

  it('extracts use-package edge', async () => {
    const r = await p('(use-package :cl-json)');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'cl-json')).toBe(true);
  });

  it('extracts ql:quickload edge', async () => {
    const r = await p('(ql:quickload "drakma")');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'drakma')).toBe(true);
  });
});

// ==============================
// 10. Zig (upgraded)
// ==============================
describe('Zig (upgraded)', () => {
  const plugin = new ZigLanguagePlugin();
  async function parseZig(s: string, f = 'main.zig') {
    const result = await plugin.extractSymbols(f, Buffer.from(s));
    expect(result.isOk()).toBe(true);
    return result._unsafeUnwrap();
  }

  it('extracts pub function', async () => {
    const r = await parseZig('pub fn init(allocator: std.mem.Allocator) void {}');
    expect(
      r.symbols.some(
        (s: any) => s.name === 'init' && s.kind === 'function' && s.metadata?.exported,
      ),
    ).toBe(true);
  });

  it('extracts struct with fields', async () => {
    const r = await parseZig('const Point = struct {\n    x: f32,\n    y: f32,\n};');
    expect(r.symbols.some((s: any) => s.name === 'Point' && s.kind === 'class')).toBe(true);
  });

  it('extracts enum', async () => {
    const r = await parseZig('const Color = enum {\n    red,\n    green,\n    blue,\n};');
    expect(r.symbols.some((s: any) => s.name === 'Color' && s.kind === 'enum')).toBe(true);
  });

  it('extracts test declaration', async () => {
    const r = await parseZig('test "basic add" {\n    try expect(1 + 1 == 2);\n}');
    expect(r.symbols.some((s: any) => s.name === 'basic add' && s.metadata?.test)).toBe(true);
  });

  it('extracts @import edge', async () => {
    const r = await parseZig('const std = @import("std");');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'std')).toBe(true);
  });

  it('extracts const', async () => {
    const r = await parseZig('pub const MAX_SIZE: usize = 1024;');
    expect(r.symbols.some((s: any) => s.name === 'MAX_SIZE' && s.kind === 'constant')).toBe(true);
  });

  it('supports .zon extension', () => {
    expect(plugin.supportedExtensions).toContain('.zon');
  });
});

// ==============================
// 11. OCaml (upgraded)
// ==============================
describe('OCaml (upgraded)', () => {
  const plugin = new OcamlLanguagePlugin();
  async function parseOcaml(s: string, f = 'main.ml') {
    const result = await plugin.extractSymbols(f, Buffer.from(s));
    expect(result.isOk()).toBe(true);
    return result._unsafeUnwrap();
  }

  it('extracts let binding', async () => {
    const r = await parseOcaml('let add x y = x + y');
    expect(r.symbols.some((s: any) => s.name === 'add' && s.kind === 'function')).toBe(true);
  });

  it('extracts type definition', async () => {
    const r = await parseOcaml('type point = { x: float; y: float }');
    expect(r.symbols.some((s: any) => s.name === 'point' && s.kind === 'type')).toBe(true);
  });

  it('extracts module definition', async () => {
    const r = await parseOcaml('module MyMod = struct\n  let x = 42\nend');
    expect(r.symbols.some((s: any) => s.name === 'MyMod' && s.kind === 'module')).toBe(true);
  });

  it('extracts exception', async () => {
    const r = await parseOcaml('exception Not_found');
    expect(r.symbols.some((s: any) => s.name === 'Not_found' && s.metadata?.exception)).toBe(true);
  });

  it('extracts open edge', async () => {
    const r = await parseOcaml('open Printf');
    expect(r.edges?.some((e: any) => e.metadata?.module === 'Printf')).toBe(true);
  });

  it('supports .mli extension', () => {
    expect(plugin.supportedExtensions).toContain('.mli');
  });
});
