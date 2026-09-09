import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import {
  detectChecker,
  getDiagnostics,
  matchesFilePath,
  normalizeFilePath,
  parseMypyOutput,
  parsePyrightOutput,
  parseTscOutput,
  resolveEnclosingSymbol,
} from '../../src/tools/quality/diagnostics.js';
import { createTestStore, createTmpDir } from '../test-utils.js';

describe('get_diagnostics: path normalization and matching', () => {
  it('normalizes relative, absolute, and Windows-style paths', () => {
    expect(normalizeFilePath('./src/index.ts')).toBe('src/index.ts');
    expect(normalizeFilePath('src\\utils\\math.ts')).toBe('src/utils/math.ts');
    expect(normalizeFilePath('/project/src/index.ts', '/project')).toBe('src/index.ts');
  });

  it('matches paths accurately with exact and suffix matching on segment boundaries', () => {
    expect(matchesFilePath('src/app.ts', 'src/app.ts')).toBe(true);
    expect(matchesFilePath('src/app.ts', './src/app.ts')).toBe(true);
    expect(matchesFilePath('src/app.ts', 'app.ts')).toBe(true);
    expect(matchesFilePath('src/webapp.ts', 'app.ts')).toBe(false);
    expect(matchesFilePath('src/deep/app.ts', 'deep/app.ts')).toBe(true);
    expect(matchesFilePath('src/sub_deep/app.ts', 'deep/app.ts')).toBe(false);
    expect(matchesFilePath('tests/app.ts', 'src/app.ts')).toBe(false);
  });
});

describe('get_diagnostics: compiler output parsers', () => {
  describe('parseTscOutput', () => {
    it('parses standard tsc errors and warnings', () => {
      const output = [
        "src/user.ts(14,7): error TS2322: Type 'string' is not assignable to type 'number'.",
        "src/config.ts(5,1): warning TS6133: 'unused' is declared but its value is never read.",
        'Found 2 errors.',
      ].join('\n');

      const diagnostics = parseTscOutput(output);
      expect(diagnostics).toHaveLength(2);

      expect(diagnostics[0]).toEqual({
        file: 'src/user.ts',
        line: 14,
        column: 7,
        severity: 'error',
        code: 'TS2322',
        message: "Type 'string' is not assignable to type 'number'.",
      });

      expect(diagnostics[1]).toEqual({
        file: 'src/config.ts',
        line: 5,
        column: 1,
        severity: 'warning',
        code: 'TS6133',
        message: "'unused' is declared but its value is never read.",
      });
    });

    it('handles multiline continuation error messages', () => {
      const output = [
        "src/api.ts(25,10): error TS2345: Argument of type '{ id: string; }' is not assignable to parameter of type 'Options'.",
        "  Types of property 'id' are incompatible.",
        "    Type 'string' is not assignable to type 'number'.",
        'src/api.ts(50,3): error TS2554: Expected 2 arguments, but got 1.',
      ].join('\n');

      const diagnostics = parseTscOutput(output);
      expect(diagnostics).toHaveLength(2);

      expect(diagnostics[0].line).toBe(25);
      expect(diagnostics[0].code).toBe('TS2345');
      expect(diagnostics[0].message).toContain("Argument of type '{ id: string; }'");
      expect(diagnostics[0].message).toContain("Types of property 'id' are incompatible.");

      expect(diagnostics[1].line).toBe(50);
      expect(diagnostics[1].code).toBe('TS2554');
    });

    it('returns empty array when output has no errors', () => {
      expect(parseTscOutput('')).toEqual([]);
      expect(parseTscOutput('Done in 1.4s\n')).toEqual([]);
    });
  });

  describe('parseMypyOutput', () => {
    it('parses mypy errors with column, code, and severity', () => {
      const output = [
        'src/models.py:42:8: error: Incompatible types in assignment (expression has type "str", variable has type "int") [assignment]',
        'src/utils.py:10:1: warning: Unused import "os" [unused-ignore]',
        'src/models.py:43: note: See https://mypy.readthedocs.io for details',
        'Found 1 error in 1 file (checked 5 source files)',
      ].join('\n');

      const diagnostics = parseMypyOutput(output);
      expect(diagnostics).toHaveLength(3);

      expect(diagnostics[0]).toEqual({
        file: 'src/models.py',
        line: 42,
        column: 8,
        severity: 'error',
        code: 'assignment',
        message:
          'Incompatible types in assignment (expression has type "str", variable has type "int")',
      });

      expect(diagnostics[1]).toEqual({
        file: 'src/utils.py',
        line: 10,
        column: 1,
        severity: 'warning',
        code: 'unused-ignore',
        message: 'Unused import "os"',
      });

      expect(diagnostics[2]).toEqual({
        file: 'src/models.py',
        line: 43,
        column: 1,
        severity: 'note',
        code: undefined,
        message: 'See https://mypy.readthedocs.io for details',
      });
    });

    it('parses mypy errors without column number', () => {
      const output =
        'src/service.py:88: error: Function is missing a return type annotation [no-untyped-def]\n';
      const diagnostics = parseMypyOutput(output);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toEqual({
        file: 'src/service.py',
        line: 88,
        column: 1,
        severity: 'error',
        code: 'no-untyped-def',
        message: 'Function is missing a return type annotation',
      });
    });
  });

  describe('parsePyrightOutput', () => {
    it('parses pyright JSON output and converts 0-indexed positions to 1-indexed', () => {
      const jsonPayload = {
        version: '1.1.350',
        time: '123456',
        generalDiagnostics: [
          {
            file: '/workspace/project/src/calc.py',
            severity: 'error',
            message:
              'Argument of type "Literal[1]" cannot be assigned to parameter "val" of type "str"',
            rule: 'reportArgumentType',
            range: {
              start: { line: 9, character: 4 },
              end: { line: 9, character: 15 },
            },
          },
          {
            file: 'src/calc.py',
            severity: 'warning',
            message: 'Variable "unused" is not accessed',
            rule: 'reportUnusedVariable',
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 6 },
            },
          },
        ],
        summary: {
          filesAnalyzed: 1,
          errorCount: 1,
          warningCount: 1,
          informationCount: 0,
          timeInSec: 0.5,
        },
      };

      const diagnostics = parsePyrightOutput(JSON.stringify(jsonPayload), '/workspace/project');
      expect(diagnostics).toHaveLength(2);

      expect(diagnostics[0]).toEqual({
        file: 'src/calc.py',
        line: 10, // 9 + 1
        column: 5, // 4 + 1
        severity: 'error',
        code: 'reportArgumentType',
        message:
          'Argument of type "Literal[1]" cannot be assigned to parameter "val" of type "str"',
      });

      expect(diagnostics[1]).toEqual({
        file: 'src/calc.py',
        line: 1,
        column: 1,
        severity: 'warning',
        code: 'reportUnusedVariable',
        message: 'Variable "unused" is not accessed',
      });
    });

    it('falls back to text parsing if output is not valid JSON', () => {
      const textOutput = [
        '/project/src/app.py:12:5 - error: Expected type "int" but received "str" (reportGeneralTypeIssues)',
        '/project/src/app.py:20:1 - warning: Import "math" is not accessed',
      ].join('\n');

      const diagnostics = parsePyrightOutput(textOutput, '/project');
      expect(diagnostics).toHaveLength(2);

      expect(diagnostics[0]).toEqual({
        file: 'src/app.py',
        line: 12,
        column: 5,
        severity: 'error',
        code: 'reportGeneralTypeIssues',
        message: 'Expected type "int" but received "str"',
      });

      expect(diagnostics[1]).toEqual({
        file: 'src/app.py',
        line: 20,
        column: 1,
        severity: 'warning',
        code: undefined,
        message: 'Import "math" is not accessed',
      });
    });
  });
});

describe('get_diagnostics: checker auto-detection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir('checker-detect-');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects tsc when tsconfig.json is present', () => {
    writeFileSync(join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');
    expect(detectChecker(tmpDir)).toBe('tsc');
  });

  it('detects mypy when pyproject.toml has [tool.mypy]', () => {
    writeFileSync(
      join(tmpDir, 'pyproject.toml'),
      '[tool.mypy]\npython_version = "3.11"\n',
      'utf-8',
    );
    expect(detectChecker(tmpDir)).toBe('mypy');
  });

  it('detects mypy when mypy.ini is present', () => {
    writeFileSync(join(tmpDir, 'mypy.ini'), '[mypy]\n', 'utf-8');
    expect(detectChecker(tmpDir)).toBe('mypy');
  });

  it('detects pyright when pyproject.toml has [tool.pyright]', () => {
    writeFileSync(
      join(tmpDir, 'pyproject.toml'),
      '[tool.pyright]\ntypeCheckingMode = "strict"\n',
      'utf-8',
    );
    expect(detectChecker(tmpDir)).toBe('pyright');
  });

  it('detects pyright when pyrightconfig.json is present', () => {
    writeFileSync(join(tmpDir, 'pyrightconfig.json'), '{}', 'utf-8');
    expect(detectChecker(tmpDir)).toBe('pyright');
  });

  it('returns null when no type checker configuration is detected', () => {
    expect(detectChecker(tmpDir)).toBeNull();
  });
});

describe('get_diagnostics: enclosing AST symbol resolution', () => {
  let store: Store;
  let fileId: number;

  beforeEach(() => {
    store = createTestStore();
    fileId = store.insertFile('src/service.ts', 'typescript', 'hash1', 500);

    // Class from line 10 to line 80
    store.insertSymbol(fileId, {
      symbolId: 'sym:UserService#class',
      name: 'UserService',
      kind: 'class',
      lineStart: 10,
      lineEnd: 80,
    });

    // Outer method from line 15 to line 40
    store.insertSymbol(fileId, {
      symbolId: 'sym:UserService#getUser#method',
      name: 'getUser',
      kind: 'method',
      lineStart: 15,
      lineEnd: 40,
    });

    // Standalone function from line 90 to line 120
    store.insertSymbol(fileId, {
      symbolId: 'sym:createHelper#function',
      name: 'createHelper',
      kind: 'function',
      lineStart: 90,
      lineEnd: 120,
    });

    // Variable at line 20 (should be ignored as enclosing candidate)
    store.insertSymbol(fileId, {
      symbolId: 'sym:tempVar#variable',
      name: 'tempVar',
      kind: 'variable',
      lineStart: 20,
      lineEnd: 20,
    });
  });

  it('resolves the innermost enclosing symbol when nested', () => {
    // Line 25 is inside UserService (10-80) and getUser (15-40) -> should choose getUser
    const sym = resolveEnclosingSymbol(store, 'src/service.ts', 25);
    expect(sym).toBeDefined();
    expect(sym?.name).toBe('getUser');
    expect(sym?.kind).toBe('method');
    expect(sym?.id).toBe('sym:UserService#getUser#method');
  });

  it('resolves class symbol when error is in class body but outside methods', () => {
    // Line 12 is inside UserService (10-80) but not inside getUser (15-40)
    const sym = resolveEnclosingSymbol(store, 'src/service.ts', 12);
    expect(sym).toBeDefined();
    expect(sym?.name).toBe('UserService');
    expect(sym?.kind).toBe('class');
  });

  it('resolves standalone function', () => {
    const sym = resolveEnclosingSymbol(store, 'src/service.ts', 105);
    expect(sym).toBeDefined();
    expect(sym?.name).toBe('createHelper');
    expect(sym?.kind).toBe('function');
  });

  it('returns undefined if line is outside any function, method, class, or interface', () => {
    const sym = resolveEnclosingSymbol(store, 'src/service.ts', 5);
    expect(sym).toBeUndefined();
  });

  it('returns undefined if file is not indexed in store', () => {
    const sym = resolveEnclosingSymbol(store, 'src/other.ts', 25);
    expect(sym).toBeUndefined();
  });
});

describe('get_diagnostics: end-to-end integration and bounds', () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    store = createTestStore();
    tmpDir = createTmpDir('diag-e2e-');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns clean status no_checker_configured when no checker is detected', async () => {
    const result = await getDiagnostics(store, tmpDir, {});
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.status).toBe('no_checker_configured');
    expect(data.total_errors).toBe(0);
    expect(data.files).toEqual([]);
  });

  it('returns no_errors when checker runs and finds zero errors', async () => {
    writeFileSync(join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');

    const mockRunCommand = async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });

    const result = await getDiagnostics(store, tmpDir, {
      runCommand: mockRunCommand,
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.checker).toBe('tsc');
    expect(data.status).toBe('no_errors');
    expect(data.total_errors).toBe(0);
    expect(data.files_with_errors).toBe(0);
    expect(data.files).toEqual([]);
  });

  it('parses tsc errors, maps enclosing symbols, and respects filePath filter', async () => {
    writeFileSync(join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');

    const fileId = store.insertFile('src/handler.ts', 'typescript', 'hash1', 300);
    store.insertSymbol(fileId, {
      symbolId: 'sym:handleRequest#function',
      name: 'handleRequest',
      kind: 'function',
      lineStart: 10,
      lineEnd: 30,
    });

    const mockRunCommand = async () => ({
      stdout: [
        "src/handler.ts(15,3): error TS2322: Type 'null' is not assignable to type 'string'.",
        "src/other.ts(8,1): error TS2304: Cannot find name 'foo'.",
      ].join('\n'),
      stderr: '',
      exitCode: 1,
    });

    // Test with filePath filter
    const filteredResult = await getDiagnostics(store, tmpDir, {
      filePath: 'src/handler.ts',
      runCommand: mockRunCommand,
    });

    expect(filteredResult.isOk()).toBe(true);
    const filteredData = filteredResult._unsafeUnwrap();
    expect(filteredData.checker).toBe('tsc');
    expect(filteredData.total_errors).toBe(1);
    expect(filteredData.files_with_errors).toBe(1);
    expect(filteredData.files).toHaveLength(1);
    expect(filteredData.files[0].file).toBe('src/handler.ts');
    expect(filteredData.files[0].diagnostics).toHaveLength(1);
    expect(filteredData.files[0].diagnostics[0].enclosing_symbol).toEqual({
      name: 'handleRequest',
      kind: 'function',
      id: 'sym:handleRequest#function',
    });

    // Test without filePath filter (both files returned)
    const allResult = await getDiagnostics(store, tmpDir, {
      runCommand: mockRunCommand,
    });
    expect(allResult.isOk()).toBe(true);
    const allData = allResult._unsafeUnwrap();
    expect(allData.total_errors).toBe(2);
    expect(allData.files_with_errors).toBe(2);
  });

  it('enforces bounds: max_per_file and max_files', async () => {
    writeFileSync(join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');

    // Create 5 files with 12 errors each (total 60 errors)
    const stdoutLines: string[] = [];
    for (let f = 1; f <= 5; f++) {
      for (let e = 1; e <= 12; e++) {
        stdoutLines.push(`src/file${f}.ts(${e},1): error TS2322: Error ${e} in file ${f}.`);
      }
    }

    const mockRunCommand = async () => ({
      stdout: stdoutLines.join('\n'),
      stderr: '',
      exitCode: 1,
    });

    // Request with maxFiles: 3, maxPerFile: 5
    const result = await getDiagnostics(store, tmpDir, {
      maxFiles: 3,
      maxPerFile: 5,
      runCommand: mockRunCommand,
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();

    // 5 files total had errors, but only 3 returned
    expect(data.files_with_errors).toBe(5);
    expect(data.total_errors).toBe(60);
    expect(data.files).toHaveLength(3);

    // 3 files * 5 errors = 15 returned. 60 - 15 = 45 truncated errors.
    expect(data.truncated_errors).toBe(45);

    for (const fileGroup of data.files) {
      expect(fileGroup.diagnostics).toHaveLength(5);
      expect(fileGroup.total_file_errors).toBe(12);
      expect(fileGroup.truncated_in_file).toBe(7);
    }
  });

  it('handles command failure when checker executable is not found (ENOENT)', async () => {
    writeFileSync(join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');

    const mockRunCommand = async () => {
      const err = new Error('spawn tsc ENOENT') as Error & { code?: string };
      err.code = 'ENOENT';
      throw err;
    };

    const result = await getDiagnostics(store, tmpDir, {
      runCommand: mockRunCommand,
    });

    expect(result.isErr()).toBe(true);
    const errorMsg = result._unsafeUnwrapErr().message;
    expect(errorMsg).toContain('is not installed or not in PATH');
  });

  it('handles command timeout error', async () => {
    writeFileSync(join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');

    const mockRunCommand = async () => {
      const err = new Error('timed out') as Error & { killed?: boolean };
      err.killed = true;
      throw err;
    };

    const result = await getDiagnostics(store, tmpDir, {
      runCommand: mockRunCommand,
    });

    expect(result.isErr()).toBe(true);
    const errorMsg = result._unsafeUnwrapErr().message;
    expect(errorMsg).toContain('timed out');
  });

  it('returns an error when checker exits non-zero without parseable diagnostics', async () => {
    writeFileSync(join(tmpDir, 'tsconfig.json'), '{}', 'utf-8');

    const mockRunCommand = async () => ({
      stdout: '',
      stderr: 'error TS5023: Unknown compiler option "--invalid".\n',
      exitCode: 1,
    });

    const result = await getDiagnostics(store, tmpDir, {
      runCommand: mockRunCommand,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('exited with code 1');
    expect(result._unsafeUnwrapErr().message).toContain('Unknown compiler option');
  });
});
