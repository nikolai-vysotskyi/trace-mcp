/**
 * Tests for multi-pass regex engine features:
 * - Comment/string immunity
 * - Container → member parent-child resolution
 * - Scoped member extraction
 * - Edge deduplication
 */
import { describe, expect, it } from 'vitest';
import { AdaLanguagePlugin } from '../../src/indexer/plugins/language/ada/index.js';
import { ApexLanguagePlugin } from '../../src/indexer/plugins/language/apex/index.js';
import { PascalLanguagePlugin } from '../../src/indexer/plugins/language/pascal/index.js';
import { PlsqlLanguagePlugin } from '../../src/indexer/plugins/language/plsql/index.js';
import { PowerShellLanguagePlugin } from '../../src/indexer/plugins/language/powershell/index.js';
import { stripCommentsAndStrings } from '../../src/indexer/plugins/language/regex-base-v2.js';

function parse(
  plugin: { extractSymbols: (f: string, c: Buffer) => any },
  source: string,
  filePath: string,
): any {
  const r = plugin.extractSymbols(filePath, Buffer.from(source));
  if (r && typeof r.then === 'function')
    return r.then((res: any) => {
      expect(res.isOk()).toBe(true);
      return res._unsafeUnwrap();
    });
  expect(r.isOk()).toBe(true);
  return r._unsafeUnwrap();
}

// ==============================
// Comment/String Stripping Engine
// ==============================
describe('stripCommentsAndStrings', () => {
  it('strips C-style line comments', () => {
    const cStyle = { line: ['//'], block: [['/*', '*/']] as [string, string][], strings: ['"'] };
    const result = stripCommentsAndStrings('int x; // comment\nint y;', cStyle);
    expect(result).toContain('int x;');
    expect(result).not.toContain('comment');
    expect(result).toContain('int y;');
  });

  it('strips block comments', () => {
    const cStyle = { line: ['//'], block: [['/*', '*/']] as [string, string][], strings: ['"'] };
    const result = stripCommentsAndStrings('int x; /* block\ncomment */ int y;', cStyle);
    expect(result).toContain('int x;');
    expect(result).toContain('int y;');
    expect(result).not.toContain('block');
  });

  it('strips string contents', () => {
    const result = stripCommentsAndStrings('const s = "function fake() {}";', {
      line: ['//'],
      block: [['/*', '*/']],
      strings: ['"'],
    });
    expect(result).not.toContain('fake');
  });

  it('preserves line count (newlines survive)', () => {
    const cStyle = { line: ['//'], block: [['/*', '*/']] as [string, string][], strings: ['"'] };
    const source = 'line1\n/* comment\nspanning\nlines */\nline5';
    const result = stripCommentsAndStrings(source, cStyle);
    expect(result.split('\n').length).toBe(source.split('\n').length);
  });

  it('handles Ada -- comments', () => {
    const result = stripCommentsAndStrings('procedure Init; -- initialize\nprocedure Run;', {
      line: ['--'],
      block: [] as [string, string][],
      strings: ['"'],
    });
    expect(result).toContain('procedure Init;');
    expect(result).not.toContain('initialize');
    expect(result).toContain('procedure Run;');
  });

  it('handles Lisp ; comments and #| |# blocks', () => {
    const result = stripCommentsAndStrings('(defun foo () ; comment\n  #| block |# 42)', {
      line: [';'],
      block: [['#|', '|#']] as [string, string][],
      strings: [],
    });
    expect(result).toContain('(defun foo ()');
    expect(result).not.toContain('comment');
    expect(result).not.toContain('block');
    expect(result).toContain('42)');
  });

  it('handles Pascal { } and (* *) comments', () => {
    const result = stripCommentsAndStrings(
      'procedure X; { old comment }\nprocedure Y; (* block *)',
      {
        line: ['//'],
        block: [
          ['{', '}'],
          ['(*', '*)'],
        ],
        strings: ["'"],
      },
    );
    expect(result).toContain('procedure X;');
    expect(result).not.toContain('old comment');
    expect(result).toContain('procedure Y;');
    expect(result).not.toContain('block');
  });
});

// ==============================
// Pascal: Comment immunity + parent-child
// ==============================
describe('Pascal multi-pass', () => {
  const plugin = new PascalLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'unit.pas');

  it('ignores function in { } comment', () => {
    const r = p('{ function FakeFunc; }\nprocedure RealProc;');
    expect(r.symbols.some((s: any) => s.name === 'FakeFunc')).toBe(false);
    expect(r.symbols.some((s: any) => s.name === 'RealProc')).toBe(true);
  });

  it('extracts method inside class with parent', () => {
    const r = p(`TMyClass = class(TObject)
  procedure DoWork;
  function GetName: string;
end;`);
    expect(r.symbols.some((s: any) => s.name === 'TMyClass' && s.kind === 'class')).toBe(true);
    const method = r.symbols.find((s: any) => s.name === 'DoWork');
    expect(method).toBeDefined();
    expect(method.kind).toBe('method');
    expect(method.parentSymbolId).toContain('TMyClass');
  });

  it('extracts field inside record with parent', () => {
    const r = p(`TPoint = record
  X: Integer;
  Y: Integer;
end;`);
    expect(r.symbols.some((s: any) => s.name === 'TPoint' && s.kind === 'class')).toBe(true);
    const fieldX = r.symbols.find((s: any) => s.name === 'X');
    expect(fieldX).toBeDefined();
    expect(fieldX.parentSymbolId).toContain('TPoint');
  });
});

// ==============================
// Ada: Comment immunity + package members
// ==============================
describe('Ada multi-pass', () => {
  const plugin = new AdaLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'main.adb');

  it('ignores function in -- comment', () => {
    const r = p('-- procedure FakeProc;\nprocedure RealProc;');
    expect(r.symbols.some((s: any) => s.name === 'FakeProc')).toBe(false);
    expect(r.symbols.some((s: any) => s.name === 'RealProc')).toBe(true);
  });

  it('extracts procedure inside package with parent', () => {
    const r = p(`package My_Pkg is
  procedure Init;
  function Compute(X : Integer) return Integer;
end My_Pkg;`);
    expect(r.symbols.some((s: any) => s.name === 'My_Pkg' && s.kind === 'namespace')).toBe(true);
    const init = r.symbols.find((s: any) => s.name === 'Init' && s.parentSymbolId);
    expect(init).toBeDefined();
    expect(init.parentSymbolId).toContain('My_Pkg');
  });

  it('extracts record components with parent', () => {
    const r = p(`type Person is record
  Name : String(1..50);
  Age : Integer;
end record;`);
    expect(r.symbols.some((s: any) => s.name === 'Person' && s.kind === 'class')).toBe(true);
    const nameField = r.symbols.find((s: any) => s.name === 'Name' && s.parentSymbolId);
    expect(nameField).toBeDefined();
    expect(nameField.parentSymbolId).toContain('Person');
  });
});

// ==============================
// PowerShell: Comment immunity + class members
// ==============================
describe('PowerShell multi-pass', () => {
  const plugin = new PowerShellLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'script.ps1');

  it('ignores function in # comment', () => {
    const r = p('# function Fake-Func {}\nfunction Real-Func {}');
    expect(r.symbols.some((s: any) => s.name === 'Fake-Func')).toBe(false);
    expect(r.symbols.some((s: any) => s.name === 'Real-Func')).toBe(true);
  });

  it('ignores function in <# #> block comment', () => {
    const r = p('<# function Fake-Func {} #>\nfunction Real-Func {}');
    expect(r.symbols.some((s: any) => s.name === 'Fake-Func')).toBe(false);
    expect(r.symbols.some((s: any) => s.name === 'Real-Func')).toBe(true);
  });

  it('extracts enum values inside enum', () => {
    const r = p('enum Color {\n  Red\n  Green\n  Blue\n}');
    expect(r.symbols.some((s: any) => s.name === 'Color' && s.kind === 'enum')).toBe(true);
    const red = r.symbols.find((s: any) => s.name === 'Red');
    expect(red).toBeDefined();
    expect(red.parentSymbolId).toContain('Color');
  });
});

// ==============================
// Apex: Comment immunity + class members
// ==============================
describe('Apex multi-pass', () => {
  const plugin = new ApexLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'Service.cls');

  it('ignores class in // comment', () => {
    const r = p('// public class FakeClass {}\npublic class RealClass {}');
    expect(r.symbols.some((s: any) => s.name === 'FakeClass')).toBe(false);
    expect(r.symbols.some((s: any) => s.name === 'RealClass')).toBe(true);
  });

  it('extracts constant inside class with parent', () => {
    const r = p('public class Config {\n  static final Integer MAX = 100;\n}');
    expect(r.symbols.some((s: any) => s.name === 'Config' && s.kind === 'class')).toBe(true);
    const max = r.symbols.find((s: any) => s.name === 'MAX');
    expect(max).toBeDefined();
    expect(max.parentSymbolId).toContain('Config');
  });
});

// ==============================
// PL/SQL: Comment immunity + package members
// ==============================
describe('PL/SQL multi-pass', () => {
  const plugin = new PlsqlLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'pkg.pks');

  it('ignores procedure in -- comment', () => {
    const r = p('-- PROCEDURE fake_proc;\nCREATE PROCEDURE real_proc AS BEGIN NULL; END;');
    expect(r.symbols.some((s: any) => s.name === 'fake_proc')).toBe(false);
    expect(r.symbols.some((s: any) => s.name === 'real_proc')).toBe(true);
  });

  it('extracts function inside package with parent', () => {
    const r = p(`CREATE OR REPLACE PACKAGE my_pkg AS
  PROCEDURE init_data;
  FUNCTION get_count RETURN NUMBER;
END my_pkg;`);
    expect(r.symbols.some((s: any) => s.name === 'my_pkg' && s.kind === 'namespace')).toBe(true);
    const initData = r.symbols.find((s: any) => s.name === 'init_data' && s.parentSymbolId);
    expect(initData).toBeDefined();
    expect(initData.parentSymbolId).toContain('my_pkg');
  });
});

// ==============================
// Edge deduplication
// ==============================
describe('Edge deduplication', () => {
  const plugin = new AdaLanguagePlugin();
  const p = (s: string) => parse(plugin, s, 'main.adb');

  it('deduplicates repeated imports', () => {
    const r = p('with Ada.Text_IO;\nwith Ada.Text_IO;\nuse Ada.Text_IO;');
    const textIOEdges = r.edges?.filter((e: any) => e.metadata?.module === 'Ada.Text_IO') ?? [];
    // Multi-pass engine deduplicates globally: 'with A', 'with A', 'use A' → 1 edge
    expect(textIOEdges.length).toBe(1);
  });
});
