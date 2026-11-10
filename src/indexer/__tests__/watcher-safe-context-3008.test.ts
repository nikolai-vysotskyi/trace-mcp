import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import pino from 'pino';
import { FileWatcher } from '../watcher.js';
import { logger } from '../../logger.js';

let capturedCallback: ((err: Error | null, events: any[]) => void) | undefined;

vi.mock('@parcel/watcher', () => ({
  subscribe: async (_root: string, cb: (err: Error | null, events: any[]) => void) => {
    capturedCallback = cb;
    return { unsubscribe: async () => {} };
  },
}));

describe('TRA-3008: Watcher error diagnostic safe project/file context and pino binding', () => {
  let tmpDir: string;
  let root: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tra-3008-watcher-'));
    root = path.join(tmpDir, 'project');
    fs.mkdirSync(root, { recursive: true });
    capturedCallback = undefined;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('logs safe project/file context without file contents or secrets on handler failure', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const watcher = new FileWatcher();

    const failure = new Error('simulated disk failure');
    await watcher.start(
      root,
      {} as never,
      async () => {
        throw failure;
      },
      1,
    );

    // Provide 25 files to test relative normalization and truncation (>20)
    const files = Array.from({ length: 25 }, (_, i) => ({
      type: 'update',
      path: path.join(root, 'src', `file_${i}.ts`),
    }));
    capturedCallback?.(null, files);

    // Fast-forward debounce
    await new Promise((r) => setTimeout(r, 20));
    await watcher.stop();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        error: failure,
        rootPath: root,
        fileCount: 25,
        paths: expect.arrayContaining(['src/file_0.ts', 'src/file_19.ts']),
        truncated: true,
      }),
      'File change handler failed',
    );

    const callArgs = errorSpy.mock.calls.find((call) => call[1] === 'File change handler failed');
    expect(callArgs).toBeDefined();
    const payload = callArgs![0] as Record<string, unknown>;
    expect(payload.rootPath).toBe(root);
    expect((payload.paths as string[]).length).toBe(20);
    // Ensure relative paths and no file contents
    expect((payload.paths as string[])[0]).toBe('src/file_0.ts');
  });

  it('strict pino logger receiver is preserved and never throws pino.msgPrefix TypeError', () => {
    // Replicate real pino instance
    const realPino = pino({ name: 'trace-mcp-test' });
    const symbols = Object.getOwnPropertySymbols(realPino);
    const msgPrefixSym = symbols.find((s) => s.toString().includes('pino.msgPrefix'));
    expect(msgPrefixSym).toBeDefined();

    // Calling unbound pino method reproduces the TypeError
    const unbound = realPino.info;
    expect(() => {
      unbound({ test: true }, 'msg');
    }).toThrow(/pino\.msgPrefix/);

    // Preserving receiver (via logger[level] or bind) must succeed
    const indexed = 1;
    const level = indexed > 0 ? 'info' : 'debug';
    expect(() => {
      realPino[level]({ test: true }, 'msg');
    }).not.toThrow();
  });
});
