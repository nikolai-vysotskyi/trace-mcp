/**
 * TRA-1768: a broken environment fails EVERY file of a language with the
 * identical message. FileExtractor used to log one L50 `Language plugin
 * failed` per file — 112 lines for a single cause — into the shared
 * daemon.log. Now the first occurrence keeps the full error log, repeats go
 * to debug, and every 50th repeat emits a warn summary.
 *
 * NOTE: a missing-WASM ENOENT no longer reaches this path — TRA-1807
 * promotes it to a process-once config-fatal (see
 * file-extractor-missing-wasm-env.test.ts). The message below is therefore
 * deliberately a generic parse failure, not an ENOENT.
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
import { FileExtractor, resetLanguagePluginFailureDedupForTests } from '../file-extractor.js';

const GENERIC_MESSAGE = 'TypeScript parse failed: unexpected token `}` at offset 42';

function failingPluginFor(message: string): LanguagePlugin {
  return {
    manifest: { name: 'test-ts' },
    supportedExtensions: ['.tsx'],
    extractSymbols: (filePath: string) => Promise.resolve(err(parseError(filePath, message))),
  } as unknown as LanguagePlugin;
}

describe('FileExtractor language-plugin failure dedup (TRA-1768)', () => {
  let tmpRoot: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    resetLanguagePluginFailureDedupForTests();
    await initContentHasher();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-1768-extract-'));
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetLanguagePluginFailureDedupForTests();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function extractorFor(rootPath: string, message: string): FileExtractor {
    const plugin = failingPluginFor(message);
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

  function writeTsx(relPath: string): string {
    const abs = path.join(tmpRoot, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'export const x: number = 1;\n', 'utf-8');
    return relPath;
  }

  it('logs the first identical failure as error, repeats as debug, every 50th as warn', async () => {
    const extractor = extractorFor(tmpRoot, GENERIC_MESSAGE);
    const files = Array.from({ length: 55 }, (_, i) => writeTsx(`src/a${i}.tsx`));

    for (const f of files) {
      const res = await extractor.extract(f, true);
      expect(res.kind).toBe('error');
    }

    // 1 full error + 1 warn summary (50th) + 53 debug repeats = 55.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatchObject({ file: files[0], rootPath: tmpRoot });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [warnObj, warnMsg] = warnSpy.mock.calls[0];
    expect(warnObj).toMatchObject({ rootPath: tmpRoot, repeatCount: 50 });
    expect(String(warnMsg)).toMatch(/same error/);
    expect(debugSpy).toHaveBeenCalledTimes(53);
  });

  it('a different error message gets its own error log', async () => {
    const extractor = extractorFor(tmpRoot, GENERIC_MESSAGE);
    await extractor.extract(writeTsx('src/a.tsx'), true);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const other = extractorFor(tmpRoot, 'TypeScript parse failed: unexpected token `}`');
    await other.extract(writeTsx('src/b.tsx'), true);

    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls[1][0]).toMatchObject({ file: 'src/b.tsx' });
  });

  it('the same message under a different root gets its own error log', async () => {
    const extractor = extractorFor(tmpRoot, GENERIC_MESSAGE);
    await extractor.extract(writeTsx('src/a.tsx'), true);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-1768-other-'));
    try {
      const other = extractorFor(otherRoot, GENERIC_MESSAGE);
      const abs = path.join(otherRoot, 'src/c.tsx');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'export const y = 2;\n', 'utf-8');
      await other.extract('src/c.tsx', true);

      expect(errorSpy).toHaveBeenCalledTimes(2);
      expect(errorSpy.mock.calls[1][0]).toMatchObject({ rootPath: otherRoot });
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
