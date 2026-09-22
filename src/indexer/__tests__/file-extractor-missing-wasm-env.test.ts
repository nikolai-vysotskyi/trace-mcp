/**
 * TRA-1807: when the daemon's own tree-sitter WASM tree is gone (install dir
 * deleted under a running process), EVERY parse fails with the same ENOENT.
 * That is a config-level fatal, not a per-file problem: the first occurrence
 * logs one loud error naming the running entry + remediation, everything
 * after goes to debug with no per-root counters (the incident reached
 * 4750+ summary repeats).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { err, parseError } from '../../errors.js';
import { logger } from '../../logger.js';
import type { LanguagePlugin } from '../../plugin-api/types.js';
import { initContentHasher } from '../../util/hash.js';
import { buildProjectContext } from '../project-context.js';
import {
  FileExtractor,
  resetLanguagePluginFailureDedupForTests,
  resetMissingWasmEnvWarnForTests,
} from '../file-extractor.js';

const WASM_ENOENT_MESSAGE =
  "TypeScript parse failed: ENOENT: no such file or directory, open '/private/tmp/multica-task-3847237843/pinned-latest/node_modules/tree-sitter-wasm/out/tsx/tree-sitter-tsx.wasm'";

function failingPluginFor(message: string): LanguagePlugin {
  return {
    manifest: { name: 'test-ts' },
    supportedExtensions: ['.tsx'],
    extractSymbols: (filePath: string) => Promise.resolve(err(parseError(filePath, message))),
  } as unknown as LanguagePlugin;
}

describe('FileExtractor missing-WASM config-fatal (TRA-1807)', () => {
  let tmpRoot: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    resetLanguagePluginFailureDedupForTests();
    resetMissingWasmEnvWarnForTests();
    await initContentHasher();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-1807-extract-'));
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetLanguagePluginFailureDedupForTests();
    resetMissingWasmEnvWarnForTests();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function extractorFor(rootPath: string): FileExtractor {
    const plugin = failingPluginFor(WASM_ENOENT_MESSAGE);
    return new FileExtractor({
      registry: {
        getLanguagePluginForFileWithFallback: () => plugin,
      } as unknown as import('../../plugin-api/registry.js').PluginRegistry,
      rootPath,
      workspaces: [],
      gitignore: undefined,
      fileContentCache: new Map<string, string>(),
      buildProjectContext: () => buildProjectContext(rootPath),
    });
  }

  function writeTsxInto(root: string, relPath: string): void {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'export const x: number = 1;\n', 'utf-8');
  }

  function writeTsx(relPath: string): string {
    writeTsxInto(tmpRoot, relPath);
    return relPath;
  }

  it('logs one loud error for the whole storm, no warn summaries, no counters', async () => {
    const extractor = extractorFor(tmpRoot);
    const files = Array.from({ length: 120 }, (_, i) => writeTsx(`src/a${i}.tsx`));

    for (const f of files) {
      const res = await extractor.extract(f, true);
      expect(res.kind).toBe('error');
    }

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [errObj, errMsg] = errorSpy.mock.calls[0];
    expect(errObj).toMatchObject({ file: files[0], rootPath: tmpRoot });
    expect(String(errMsg)).toMatch(/TRA-1807/);
    expect(String(errMsg)).toMatch(/ENOENT/);
    // No 50th-repeat warn summaries and no per-root counter growth.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledTimes(119);
  });

  it('stays process-global across roots: a second root adds no new error', async () => {
    const extractor = extractorFor(tmpRoot);
    await extractor.extract(writeTsx('src/a.tsx'), true);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-1807-other-'));
    try {
      writeTsxInto(otherRoot, 'src/c.tsx');
      const res = await extractorFor(otherRoot).extract('src/c.tsx', true);
      expect(res.kind).toBe('error');
      // Still exactly one loud error for the whole process, not one per root.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
