/**
 * get_diagnostics — Executes the repository's configured type-checker
 * (tsc, mypy, pyright), parses compiler errors into structured findings,
 * and maps each error location to its enclosing AST symbol in trace-mcp's
 * symbol index.
 *
 * Implements TRA-1222.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { err, ok } from 'neverthrow';
import type { Store } from '../../db/store.js';
import { type TraceMcpResult, validationError } from '../../errors.js';

export type CheckerType = 'tsc' | 'mypy' | 'pyright';

export interface RawDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'note';
  code?: string;
  message: string;
}

export interface EnclosingSymbol {
  name: string;
  kind: string;
  id: string;
}

export interface Diagnostic {
  line: number;
  column: number;
  code?: string;
  severity: 'error' | 'warning' | 'note';
  message: string;
  enclosing_symbol?: EnclosingSymbol;
}

export interface FileDiagnostics {
  file: string;
  total_file_errors: number;
  truncated_in_file: number;
  diagnostics: Diagnostic[];
}

export interface DiagnosticsResult {
  checker?: CheckerType;
  status?: string;
  message?: string;
  total_errors: number;
  files_with_errors: number;
  truncated_errors: number;
  files: FileDiagnostics[];
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface GetDiagnosticsOptions {
  filePath?: string;
  checker?: CheckerType;
  maxPerFile?: number;
  maxFiles?: number;
  timeoutMs?: number;
  /** Custom command runner (useful for testing) */
  runCommand?: (
    checker: CheckerType,
    projectRoot: string,
    timeoutMs: number,
  ) => Promise<ExecutionResult>;
}

/** Normalizes a file path to forward slashes, relative to projectRoot, with no leading `./`. */
export function normalizeFilePath(filePath: string, projectRoot?: string): string {
  let p = filePath.replace(/\\/g, '/');
  if (projectRoot) {
    const rootNorm = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (isAbsolute(p) || p.startsWith(rootNorm)) {
      if (p.startsWith(rootNorm)) {
        p = p.slice(rootNorm.length);
      } else {
        p = relative(projectRoot, filePath).replace(/\\/g, '/');
      }
    }
  }
  return p.replace(/^\.?\/+/, '');
}

/** Checks whether a diagnostic file path matches the user-supplied filter path. */
export function matchesFilePath(diagnosticFile: string, filterPath: string): boolean {
  const normDiag = diagnosticFile.replace(/\\/g, '/').replace(/^\.?\/+/, '');
  const normFilter = filterPath.replace(/\\/g, '/').replace(/^\.?\/+/, '');
  return (
    normDiag === normFilter || normDiag.endsWith(`/${normFilter}`) || normDiag.endsWith(normFilter)
  );
}

/**
 * Auto-detects type-checker configured in projectRoot:
 * - TypeScript: tsconfig.json exists → tsc
 * - Python (mypy): [tool.mypy] in pyproject.toml or mypy.ini exists → mypy
 * - Python (pyright): [tool.pyright] in pyproject.toml or pyrightconfig.json exists → pyright
 */
export function detectChecker(projectRoot: string): CheckerType | null {
  // 1. TypeScript: tsconfig.json in project root
  if (existsSync(join(projectRoot, 'tsconfig.json'))) {
    return 'tsc';
  }

  // 2. Python (mypy or pyright)
  const pyprojectPath = join(projectRoot, 'pyproject.toml');
  let pyprojectContent = '';
  if (existsSync(pyprojectPath)) {
    try {
      pyprojectContent = readFileSync(pyprojectPath, 'utf8');
    } catch {
      // ignore read failures
    }
  }

  const hasPyright =
    existsSync(join(projectRoot, 'pyrightconfig.json')) ||
    /(?:^|\n)\[tool\.pyright(?:\]|\.)/m.test(pyprojectContent);

  const hasMypy =
    existsSync(join(projectRoot, 'mypy.ini')) ||
    /(?:^|\n)\[tool\.mypy(?:\]|\.)/m.test(pyprojectContent);

  if (hasPyright && !hasMypy) {
    return 'pyright';
  }
  if (hasMypy) {
    return 'mypy';
  }
  if (hasPyright) {
    return 'pyright';
  }

  return null;
}

/** Parses standard `tsc` output (e.g. from `tsc --noEmit --pretty false`). */
export function parseTscOutput(output: string, projectRoot?: string): RawDiagnostic[] {
  const diagnostics: RawDiagnostic[] = [];
  const lines = output.split(/\r?\n/);
  let current: RawDiagnostic | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;

    // Format 1: file:line:col - (error|warning) TS\d+: message
    const m1 = line.match(/^(.+?):(\d+):(\d+)\s*-\s*(error|warning)\s+([A-Za-z0-9]+):\s*(.*)$/i);
    if (m1) {
      current = {
        file: normalizeFilePath(m1[1], projectRoot),
        line: Number.parseInt(m1[2], 10),
        column: Number.parseInt(m1[3], 10),
        severity: m1[4].toLowerCase() === 'warning' ? 'warning' : 'error',
        code: m1[5],
        message: m1[6].trim(),
      };
      diagnostics.push(current);
      continue;
    }

    // Format 2: file(line,col): (error|warning) TS\d+: message or file(line): ...
    const m2 = line.match(
      /^(.+?)\((\d+)(?:,(\d+))?\):\s*(error|warning)\s+([A-Za-z0-9]+):\s*(.*)$/i,
    );
    if (m2) {
      current = {
        file: normalizeFilePath(m2[1], projectRoot),
        line: Number.parseInt(m2[2], 10),
        column: m2[3] ? Number.parseInt(m2[3], 10) : 1,
        severity: m2[4].toLowerCase() === 'warning' ? 'warning' : 'error',
        code: m2[5],
        message: m2[6].trim(),
      };
      diagnostics.push(current);
      continue;
    }

    // Continuation lines for multiline errors (indented with 2+ spaces)
    if (current && /^\s{2,}\S/.test(line)) {
      const trimmed = line.trim();
      if (!/^Found \d+ error/i.test(trimmed) && !/^~+$/.test(trimmed)) {
        if (!current.message.includes(trimmed)) {
          current.message += ` ${trimmed}`;
        }
      }
      continue;
    }

    current = null;
  }

  return diagnostics;
}

/** Parses standard `mypy` output (e.g. from `mypy --no-color-output --no-error-summary .`). */
export function parseMypyOutput(output: string, projectRoot?: string): RawDiagnostic[] {
  const diagnostics: RawDiagnostic[] = [];
  const lines = output.split(/\r?\n/);
  let current: RawDiagnostic | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;

    // Format: file:line[:col]: (error|warning|note): message  [code]
    const m = line.match(
      /^(.+?):(\d+)(?::(\d+))?:\s*(error|warning|note):\s*(.*?)(?:\s\s*\[([a-zA-Z0-9_\-]+)\])?$/i,
    );
    if (m) {
      const sevRaw = m[4].toLowerCase();
      const severity: 'error' | 'warning' | 'note' =
        sevRaw === 'warning' ? 'warning' : sevRaw === 'note' ? 'note' : 'error';

      current = {
        file: normalizeFilePath(m[1], projectRoot),
        line: Number.parseInt(m[2], 10),
        column: m[3] ? Number.parseInt(m[3], 10) : 1,
        severity,
        code: m[6] || undefined,
        message: m[5].trim(),
      };
      diagnostics.push(current);
      continue;
    }

    // Continuation line
    if (current && /^\s{2,}\S/.test(line)) {
      const trimmed = line.trim();
      if (!/^Found \d+ error/i.test(trimmed) && !/^Success:/i.test(trimmed)) {
        if (!current.message.includes(trimmed)) {
          current.message += ` ${trimmed}`;
        }
      }
      continue;
    }

    current = null;
  }

  return diagnostics;
}

/** Parses `pyright` JSON or text output (e.g. from `pyright --outputjson`). */
export function parsePyrightOutput(output: string, projectRoot?: string): RawDiagnostic[] {
  const trimmed = output.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const data = JSON.parse(trimmed) as {
        generalDiagnostics?: Array<{
          file?: string;
          severity?: string;
          message?: string;
          range?: {
            start?: { line?: number; character?: number };
            end?: { line?: number; character?: number };
          };
          rule?: string;
        }>;
      };

      if (Array.isArray(data.generalDiagnostics)) {
        return data.generalDiagnostics.map((d) => {
          const file = normalizeFilePath(d.file ?? '', projectRoot);
          const line = (d.range?.start?.line ?? 0) + 1;
          const column = (d.range?.start?.character ?? 0) + 1;
          const sev = d.severity?.toLowerCase();
          const severity: 'error' | 'warning' | 'note' =
            sev === 'warning'
              ? 'warning'
              : sev === 'information' || sev === 'hint' || sev === 'note'
                ? 'note'
                : 'error';
          return {
            file,
            line,
            column,
            severity,
            code: d.rule || undefined,
            message: d.message?.trim() ?? '',
          };
        });
      }
    } catch {
      // Fallback to text parsing
    }
  }

  // Fallback text parser for pyright text output
  const diagnostics: RawDiagnostic[] = [];
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(
      /^(.+?):(\d+):(\d+)\s*-\s*(error|warning|information|note):\s*(.*?)(?:\s*\(([a-zA-Z0-9_\-]+)\))?$/i,
    );
    if (m) {
      const sevRaw = m[4].toLowerCase();
      const severity: 'error' | 'warning' | 'note' =
        sevRaw === 'warning'
          ? 'warning'
          : sevRaw === 'information' || sevRaw === 'note'
            ? 'note'
            : 'error';
      diagnostics.push({
        file: normalizeFilePath(m[1], projectRoot),
        line: Number.parseInt(m[2], 10),
        column: Number.parseInt(m[3], 10),
        severity,
        code: m[6] || undefined,
        message: m[5].trim(),
      });
    }
  }

  return diagnostics;
}

/** Resolves enclosing AST symbol from trace-mcp Store. */
export function resolveEnclosingSymbol(
  store: Store,
  filePath: string,
  line: number,
): EnclosingSymbol | undefined {
  const fileRow = store.resolveFile(filePath) ?? store.getFile(filePath);
  if (!fileRow) return undefined;

  const symbols = store.getSymbolsByFile(fileRow.id);
  if (!symbols || symbols.length === 0) return undefined;

  const ENCLOSING_KINDS = new Set(['function', 'method', 'class', 'interface', 'constructor']);

  const candidates = symbols.filter((s) => {
    if (!ENCLOSING_KINDS.has(s.kind)) return false;
    if (s.line_start == null || s.line_end == null) return false;
    return line >= s.line_start && line <= s.line_end;
  });

  if (candidates.length === 0) return undefined;

  // Sort by smallest line span (innermost enclosing symbol)
  candidates.sort((a, b) => {
    const spanA = (a.line_end ?? 0) - (a.line_start ?? 0);
    const spanB = (b.line_end ?? 0) - (b.line_start ?? 0);
    if (spanA !== spanB) return spanA - spanB;
    // Tie-breaker: largest line_start (starts deeper/later)
    return (b.line_start ?? 0) - (a.line_start ?? 0);
  });

  const innermost = candidates[0];
  return {
    name: innermost.name,
    kind: innermost.kind,
    id: innermost.symbol_id,
  };
}

/** Executes the type-checker command via execFile (safe, no shell). */
export function runCheckerCommand(
  checker: CheckerType,
  projectRoot: string,
  timeoutMs: number,
): Promise<ExecutionResult> {
  let file: string;
  let args: string[];

  switch (checker) {
    case 'tsc':
      file = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      args = ['--no-install', 'tsc', '--noEmit', '--pretty', 'false'];
      break;
    case 'mypy':
      file = process.platform === 'win32' ? 'mypy.exe' : 'mypy';
      args = ['--no-color-output', '--no-error-summary', '.'];
      break;
    case 'pyright':
      file = process.platform === 'win32' ? 'pyright.cmd' : 'pyright';
      args = ['--outputjson'];
      break;
  }

  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: projectRoot,
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const stdoutStr = stdout?.toString() ?? '';
        const stderrStr = stderr?.toString() ?? '';

        if (err) {
          if (err.killed) {
            return reject(new Error(`Type-checker '${checker}' timed out after ${timeoutMs}ms`));
          }
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return reject(
              new Error(
                `Type-checker executable '${file}' not found. Ensure it is installed and on PATH.`,
              ),
            );
          }
          // Compilers exit non-zero (e.g. 1 or 2) when type errors exist
          return resolve({
            stdout: stdoutStr,
            stderr: stderrStr,
            exitCode: typeof err.code === 'number' ? err.code : 1,
          });
        }

        resolve({
          stdout: stdoutStr,
          stderr: stderrStr,
          exitCode: 0,
        });
      },
    );
  });
}

/**
 * Main entry point for get_diagnostics.
 */
export async function getDiagnostics(
  store: Store | null,
  projectRoot: string,
  options: GetDiagnosticsOptions = {},
): Promise<TraceMcpResult<DiagnosticsResult>> {
  const {
    filePath,
    checker: forcedChecker,
    maxPerFile = 10,
    maxFiles = 15,
    timeoutMs = 180000,
    runCommand = runCheckerCommand,
  } = options;

  const checker = forcedChecker ?? detectChecker(projectRoot);
  if (!checker) {
    return ok({
      status: 'no_checker_configured',
      message: 'No supported type-checker (tsc, mypy, pyright) is configured for this workspace.',
      total_errors: 0,
      files_with_errors: 0,
      truncated_errors: 0,
      files: [],
    });
  }

  let execResult: ExecutionResult;
  try {
    execResult = await runCommand(checker, projectRoot, timeoutMs);
  } catch (e: unknown) {
    const errObj = e as { code?: string; message?: string };
    if (errObj.code === 'ENOENT' || errObj.message?.includes('ENOENT')) {
      return err(
        validationError(
          `Type-checker '${checker}' is not installed or not in PATH. Install '${checker}' to enable type diagnostics.`,
        ),
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    return err(validationError(`Failed to run type-checker '${checker}': ${msg}`));
  }

  const combinedOutput = `${execResult.stdout}\n${execResult.stderr}`;
  let rawDiagnostics: RawDiagnostic[];

  switch (checker) {
    case 'tsc':
      rawDiagnostics = parseTscOutput(combinedOutput, projectRoot);
      break;
    case 'mypy':
      rawDiagnostics = parseMypyOutput(combinedOutput, projectRoot);
      break;
    case 'pyright':
      rawDiagnostics = parsePyrightOutput(execResult.stdout || combinedOutput, projectRoot);
      break;
  }

  // Restrict checking or reporting to a specific file or path suffix if filePath provided
  const filtered = filePath
    ? rawDiagnostics.filter((d) => matchesFilePath(d.file, filePath))
    : rawDiagnostics;

  // Group diagnostics by file (preserving first-seen order)
  const fileMap = new Map<string, RawDiagnostic[]>();
  for (const diag of filtered) {
    const list = fileMap.get(diag.file);
    if (list) {
      list.push(diag);
    } else {
      fileMap.set(diag.file, [diag]);
    }
  }

  const total_errors = filtered.length;
  const files_with_errors = fileMap.size;

  const fileEntries = Array.from(fileMap.entries()).slice(0, maxFiles);
  const files: FileDiagnostics[] = [];

  for (const [file, diags] of fileEntries) {
    const total_file_errors = diags.length;
    const sliced = diags.slice(0, maxPerFile);
    const truncated_in_file = total_file_errors - sliced.length;

    const resolvedDiags: Diagnostic[] = sliced.map((d) => {
      const enclosing = store ? resolveEnclosingSymbol(store, d.file, d.line) : undefined;
      const diagRecord: Diagnostic = {
        line: d.line,
        column: d.column,
        severity: d.severity,
        message: d.message,
      };
      if (d.code) diagRecord.code = d.code;
      if (enclosing) diagRecord.enclosing_symbol = enclosing;
      return diagRecord;
    });

    files.push({
      file,
      total_file_errors,
      truncated_in_file,
      diagnostics: resolvedDiags,
    });
  }

  const reportedTotal = files.reduce((sum, f) => sum + f.diagnostics.length, 0);
  const truncated_errors = total_errors - reportedTotal;

  const resultData: DiagnosticsResult = {
    checker,
    total_errors,
    files_with_errors,
    truncated_errors,
    files,
  };
  if (total_errors === 0) {
    resultData.status = 'no_errors';
  }

  return ok(resultData);
}
