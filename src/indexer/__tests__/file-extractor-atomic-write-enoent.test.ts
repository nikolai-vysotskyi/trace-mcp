import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

// Exercise the ENOENT fallback for events that raced past the churn filter.
vi.mock('../../utils/hot-churn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/hot-churn.js')>()),
  isHotChurnPath: () => false,
}));

import { logger } from '../../logger.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { FileExtractor, resetCannotReadEnoentDedupForTests } from '../file-extractor.js';
import { buildProjectContext } from '../project-context.js';

describe('FileExtractor atomic-write ENOENT deduplication (TRA-2401)', () => {
  let rootPath: string;

  beforeEach(() => {
    rootPath = mkdtempSync(join(tmpdir(), 'trace-atomic-enoent-'));
    resetCannotReadEnoentDedupForTests();
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.debug).mockClear();
  });

  afterEach(() => {
    rmSync(rootPath, { recursive: true, force: true });
  });

  it('groups changing pid/hash for one target while preserving other targets', async () => {
    const extractor = new FileExtractor({
      registry: PluginRegistry.createWithDefaults(),
      rootPath,
      workspaces: [],
      gitignore: undefined,
      fileContentCache: new Map(),
      buildProjectContext: () => buildProjectContext(rootPath),
      existingFiles: new Map(),
    });

    await extractor.extract('src/App.ts.tmp.123.abcdef012345', false);
    await extractor.extract('src/App.ts.tmp.456.012345abcdef', false);
    await extractor.extract('src/Other.ts.tmp.456.012345abcdef', false);
    await extractor.extract('src/App.ts.tmp.abc.012345abcdef', false);

    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.debug).mock.calls[0][0]).toMatchObject({
      file: 'src/App.ts.tmp.456.012345abcdef',
      code: 'ENOENT',
    });
  });
});
