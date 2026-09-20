/**
 * then_validate — Action Fusion port for the mutating tools (TRA-1701).
 *
 * Inspired by SoL-Pi's Action Fusion (NVlabs, MIT License,
 * https://github.com/NVlabs/SoL-Pi — src/sol-pi/extensions/action-fusion/):
 * a file mutation and its follow-up validation run inside one tool call and
 * return a single combined observation, removing the intermediate model
 * round-trip. Ported mechanics: per-file serialization queue (canonical
 * realpath keys), hash the target(s) after the mutation and skip validation
 * on an intervening change, skip validation when the mutation fails, and
 * never roll back the mutation when validation fails.
 *
 * Adapted for trace-mcp (harness-agnostic, no Pi dependency): validation runs
 * the in-process get_diagnostics type-checker (TRA-1222) scoped to the
 * modified files instead of an arbitrary shell command — an MCP refactoring
 * flag must not become remote code execution. Fail-open throughout: any
 * validation infrastructure error leaves the mutation result untouched.
 */

import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Store } from '../../db/store.js';
import { type CheckerType, type FileDiagnostics, getDiagnostics } from '../quality/diagnostics.js';
import type { RefactorResult } from './shared.js';

export const THEN_VALIDATE_SUCCEEDED = '[then_validate:succeeded]';
export const THEN_VALIDATE_FAILED = '[then_validate:failed]';
export const THEN_VALIDATE_SKIPPED = '[then_validate:skipped]';

/** One-line param help, shared by all four mutating tools (schema budget). */
export const THEN_VALIDATE_DESCRIPTION = 'Type-check after apply';

/** Compact validation report: diagnostics scoped to the modified files. */
export interface ThenValidationReport {
  checker: CheckerType;
  total_errors: number;
  files: FileDiagnostics[];
}

/** Injectable validation runner (default: get_diagnostics, scoped to modified files). */
export type ThenValidateRunner = (
  store: Store | null,
  projectRoot: string,
  modifiedFiles: string[],
) => Promise<ThenValidationReport>;

// ════════════════════════════════════════════════════════════════════════
// PER-FILE QUEUE (ported from SoL-Pi file-queue.ts, MIT)
// ════════════════════════════════════════════════════════════════════════

const queueTails = new Map<string, Promise<void>>();

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'ENOENT' ||
      (error as { code?: unknown }).code === 'ENOTDIR')
  );
}

async function canonicalQueueKey(filePath: string): Promise<string> {
  const resolvedPath = resolve(filePath);
  let current = resolvedPath;
  const missingSegments: string[] = [];

  while (true) {
    try {
      return resolve(await realpath(current), ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(current);
      if (parent === current) return resolvedPath;
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Serialize fused operations for one canonical file path so concurrent
 * fused mutations of the same file cannot interleave between the mutation
 * and its validation.
 */
export async function withFusedFileQueue<T>(filePath: string, work: () => Promise<T>): Promise<T> {
  const key = await canonicalQueueKey(filePath);
  const previous = queueTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const owned = new Promise<void>((resolveOwned) => {
    release = resolveOwned;
  });
  const tail = previous.then(() => owned);
  queueTails.set(key, tail);

  await previous;
  try {
    return await work();
  } finally {
    release();
    if (queueTails.get(key) === tail) queueTails.delete(key);
  }
}

// ════════════════════════════════════════════════════════════════════════
// HASH GUARD (ported from SoL-Pi then-run.ts assertUnchangedBeforeCommand)
// ════════════════════════════════════════════════════════════════════════

async function sha256File(absPath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(absPath))
    .digest('hex');
}

/**
 * Hash the mutated files, yield to the event loop, re-hash. Throws when any
 * target changed (or vanished) in between — the caller converts that into a
 * skipped validation, never into a mutation failure.
 */
export async function assertFilesUnchanged(
  absPaths: string[],
  yieldForInterference: () => Promise<void> = () =>
    new Promise<void>((resolve) => setImmediate(resolve)),
): Promise<void> {
  let before: string[];
  try {
    before = await Promise.all(absPaths.map(sha256File));
  } catch (error) {
    throw new Error(
      `${THEN_VALIDATE_SKIPPED} cannot hash mutated file(s): ${errorText(error)}; validation not run.`,
    );
  }
  await yieldForInterference();
  let after: string[];
  try {
    after = await Promise.all(absPaths.map(sha256File));
  } catch (error) {
    throw new Error(
      `${THEN_VALIDATE_SKIPPED} mutated file(s) unreadable before validation: ${errorText(error)}; validation not run.`,
    );
  }
  if (before.some((h, i) => h !== after[i])) {
    throw new Error(
      `${THEN_VALIDATE_SKIPPED} target content changed after the fused mutation; validation not run.`,
    );
  }
}

// ════════════════════════════════════════════════════════════════════════
// FUSED EXECUTION
// ════════════════════════════════════════════════════════════════════════

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolve a symbol's definition file to an absolute queue key. */
export function symbolFileAbs(
  store: Store,
  projectRoot: string,
  symbolId: string,
): string | undefined {
  try {
    const symbol = store.getSymbolBySymbolId(symbolId);
    if (!symbol) return undefined;
    const file = store.getFileById(symbol.file_id);
    if (!file) return undefined;
    return resolve(projectRoot, stripFilePrefix(file.path));
  } catch {
    return undefined;
  }
}

function stripFilePrefix(filePath: string): string {
  // Store paths are project-relative; tolerate file:// URLs and ~ like SoL-Pi.
  const expanded = filePath.startsWith('file://') ? fileURLToPath(filePath) : filePath;
  if (expanded === '~') return homedir();
  if (expanded.startsWith('~/')) return resolve(homedir(), expanded.slice(2));
  return expanded;
}

/** Default runner: one get_diagnostics pass, reporting limited to modified files. */
export async function runThenValidation(
  store: Store | null,
  projectRoot: string,
  modifiedFiles: string[],
): Promise<ThenValidationReport> {
  const full = await getDiagnostics(store, projectRoot, { maxPerFile: 5, maxFiles: 10 });
  if (full.isErr()) {
    const errValue = full.error;
    throw new Error('message' in errValue ? errValue.message : errValue.code);
  }
  const value = full.value;
  if (value.status === 'no_checker_configured') {
    throw new Error(value.message ?? 'no type-checker configured for this workspace');
  }
  if (!value.checker) {
    throw new Error('type-checker reported no result');
  }
  const inScope = new Set(modifiedFiles);
  const files = value.files.filter((f) => inScope.has(f.file));
  return {
    checker: value.checker,
    total_errors: files.reduce((sum, f) => sum + f.total_file_errors, 0),
    files,
  };
}

export interface FusedMutationOptions {
  store: Store | null;
  projectRoot: string;
  /** Absolute path of the primary file; undefined skips the queue (fail-open). */
  queueKey: string | undefined;
  thenValidate: boolean | undefined;
  /** True when the caller asked for a dry-run preview (nothing was written). */
  dryRun: boolean;
  mutate: () => RefactorResult | Promise<RefactorResult>;
  runValidation?: ThenValidateRunner;
}

/**
 * Apply a refactoring mutation and, when the caller passed then_validate,
 * run type-checker validation before returning a single combined result.
 *
 * Without the flag this returns mutate() verbatim — no queue, no hashing,
 * byte-identical responses. With the flag: failure/dry-run/empty diff skips
 * validation; an intervening change skips it; checker errors are reported
 * but never roll back the mutation.
 */
export async function executeMutationThenValidate(
  options: FusedMutationOptions,
): Promise<RefactorResult> {
  const { store, projectRoot, queueKey, thenValidate, dryRun, mutate, runValidation } = options;

  if (!thenValidate) {
    return mutate();
  }

  const fused = async (): Promise<RefactorResult> => {
    const result = await mutate();

    if (!result.success) {
      result.validation = {
        marker: THEN_VALIDATE_SKIPPED,
        reason: 'mutation failed; validation not run',
      };
      return result;
    }
    if (dryRun) {
      result.validation = {
        marker: THEN_VALIDATE_SKIPPED,
        reason: 'dry_run preview; no files modified',
      };
      return result;
    }
    if (result.files_modified.length === 0) {
      result.validation = {
        marker: THEN_VALIDATE_SKIPPED,
        reason: 'no files modified; nothing to validate',
      };
      return result;
    }

    try {
      await assertFilesUnchanged(result.files_modified.map((f) => resolve(projectRoot, f)));
    } catch (error) {
      const reason = errorText(error).replace(`${THEN_VALIDATE_SKIPPED} `, '');
      result.validation = { marker: THEN_VALIDATE_SKIPPED, reason };
      result.warnings.push(`then_validate skipped: ${reason}`);
      return result;
    }

    try {
      const report = await (runValidation ?? runThenValidation)(
        store,
        projectRoot,
        result.files_modified,
      );
      if (report.total_errors === 0) {
        result.validation = {
          marker: THEN_VALIDATE_SUCCEEDED,
          checker: report.checker,
          total_errors: 0,
          files: [],
        };
      } else {
        result.validation = {
          marker: THEN_VALIDATE_FAILED,
          checker: report.checker,
          total_errors: report.total_errors,
          files: report.files.map((f) => ({
            file: f.file,
            total_file_errors: f.total_file_errors,
            diagnostics: f.diagnostics.map((d) => ({
              line: d.line,
              column: d.column,
              severity: d.severity,
              message: d.message,
              ...(d.code ? { code: d.code } : {}),
            })),
          })),
        };
        result.warnings.push(
          `then_validate: ${report.total_errors} type error(s) in modified files (${report.checker}); mutation kept.`,
        );
      }
    } catch (error) {
      // Fail-open: the mutation stands, validation is reported as skipped.
      const reason = `validation unavailable: ${errorText(error)}`;
      result.validation = { marker: THEN_VALIDATE_SKIPPED, reason };
      result.warnings.push(`then_validate skipped: ${errorText(error)}`);
    }
    return result;
  };

  if (queueKey) {
    return withFusedFileQueue(queueKey, fused);
  }
  return fused();
}
