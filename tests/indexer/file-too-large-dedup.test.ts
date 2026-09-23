/**
 * TRA-1841: a single live growing file generated ~400 `File too large,
 * skipping` L40 lines in one night (one warn per reconcile, no per-path
 * dedup). The skip itself is correct — only the log volume is wrong.
 * First occurrence per path keeps the full warn; repeats go to debug.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileExtractor,
  resetFileTooLargeWarnDedupForTests,
} from '../../src/indexer/file-extractor.js';
import { buildProjectContext } from '../../src/indexer/project-context.js';
import { logger } from '../../src/logger.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

describe('TRA-1841 — File too large warn is deduped per path', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = createTmpDir('trace-mcp-too-large-dedup-');
    resetFileTooLargeWarnDedupForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeTmpDir(tmpRoot);
  });

  function makeExtractor(): FileExtractor {
    return new FileExtractor({
      store: undefined,
      registry: new PluginRegistry(),
      rootPath: tmpRoot,
      workspaces: [],
      gitignore: undefined,
      fileContentCache: new Map(),
      buildProjectContext: () => buildProjectContext(tmpRoot),
    });
  }

  it('repeated reconciles of the same growing file warn once, repeats go to debug', async () => {
    const rel = path.join('scratchpad', 'channel_discovery', 'account_actions.jsonl');
    const abs = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // Start oversized (>1 MB default cap), like the live scraper scratchpad.
    fs.writeFileSync(abs, `${'x'.repeat(1_200_000)}\n`);

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const extractor = makeExtractor();

    // Three reconciles; the file grows between them (live scraper appends).
    for (let i = 0; i < 3; i++) {
      const r = await extractor.extract(rel, false);
      expect(r.kind).toBe('error');
      fs.appendFileSync(abs, `${'y'.repeat(100_000)}\n`);
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledTimes(2);

    // The surviving warn stays informative: path + size + limit.
    const [meta, msg] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe('File too large, skipping');
    expect(meta).toMatchObject({ file: rel, size: 1_200_001, limit: 1_048_576 });
  });

  it('distinct paths warn independently', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const extractor = makeExtractor();

    for (const rel of ['big-a.jsonl', 'big-b.jsonl']) {
      fs.writeFileSync(path.join(tmpRoot, rel), `${'z'.repeat(1_100_000)}\n`);
      const r = await extractor.extract(rel, false);
      expect(r.kind).toBe('error');
    }
    // Second pass over both: no new warns.
    for (const rel of ['big-a.jsonl', 'big-b.jsonl']) {
      const r = await extractor.extract(rel, false);
      expect(r.kind).toBe('error');
    }

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
