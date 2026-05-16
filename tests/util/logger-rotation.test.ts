import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachFileLogging, logger } from '../../src/logger.js';

// Save and restore the logger's methods around each test so that the in-place
// patching done by attachFileLogging doesn't leak between cases.
const ORIGINAL_METHODS = {
  trace: logger.trace.bind(logger),
  debug: logger.debug.bind(logger),
  info: logger.info.bind(logger),
  warn: logger.warn.bind(logger),
  error: logger.error.bind(logger),
  fatal: logger.fatal.bind(logger),
} as const;

function restoreLogger(): void {
  for (const [k, v] of Object.entries(ORIGINAL_METHODS)) {
    // @ts-expect-error — same shape as attach does
    logger[k] = v;
  }
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-logger-'));
}

describe('logger rotation', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = makeTmpDir();
    filePath = path.join(dir, 'daemon.log');
    // Silence the pino stderr child during the storm tests.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    restoreLogger();
    // Let any in-flight async writes complete before yanking the dir.
    await new Promise((r) => setTimeout(r, 25));
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    vi.restoreAllMocks();
  });

  it('rotates without ever calling readFileSync on the log file', () => {
    // Pre-seed a 2 MB log to look like a multi-MB run.
    const big = Buffer.alloc(2 * 1024 * 1024, 0x61); // 'a'
    fs.writeFileSync(filePath, big);

    const readSpy = vi.spyOn(fs, 'readFileSync');

    attachFileLogging({ file: true, path: filePath, level: 'info', max_size_mb: 1 });

    // Drive enough writes to definitely trip the write-counter rotation trigger.
    for (let i = 0; i < 2000; i++) {
      logger.info({ i }, 'hello');
    }

    const readsAgainstLog = readSpy.mock.calls.filter(([p]) => {
      const target = typeof p === 'string' ? p : p instanceof Buffer ? p.toString() : '';
      return target === filePath;
    });
    expect(readsAgainstLog).toHaveLength(0);

    // Original log was renamed to .1.
    expect(fs.existsSync(`${filePath}.1`)).toBe(true);
  });

  it('keeps file size bounded under a write storm', async () => {
    const maxMb = 1;
    attachFileLogging({ file: true, path: filePath, level: 'info', max_size_mb: maxMb });

    // ~3 MB of payload distributed across many writes; well past the 1 MB cap.
    const payload = 'x'.repeat(2048);
    for (let i = 0; i < 1500; i++) {
      logger.info({ i, payload }, 'storm');
    }

    // Let buffered writes flush.
    await new Promise((r) => setImmediate(r));

    const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    // Generous margin — write-counter fires every 256 writes, and a few KB of
    // post-rotation writes is normal. Anything under ~5x the cap proves the
    // pathological multi-GB bug is gone.
    expect(size).toBeLessThan(maxMb * 1024 * 1024 * 5);
  });

  it('survives concurrent rotation triggers without crashing', async () => {
    attachFileLogging({ file: true, path: filePath, level: 'info', max_size_mb: 1 });

    // Fan out writes from multiple ticks to simulate concurrent triggers
    // racing with the rotation guard.
    const bursts = Array.from({ length: 8 }, (_, b) =>
      Promise.resolve().then(() => {
        const payload = 'y'.repeat(4096);
        for (let i = 0; i < 400; i++) {
          logger.info({ b, i, payload }, 'race');
        }
      }),
    );

    await expect(Promise.all(bursts)).resolves.toBeDefined();
    await new Promise((r) => setImmediate(r));

    // Live log must still be writable after the storm.
    expect(() => logger.info('post-race')).not.toThrow();
  });

  it('is a no-op when config.file is false', () => {
    const before = logger.info;
    attachFileLogging({ file: false, path: filePath, level: 'info', max_size_mb: 1 });
    expect(logger.info).toBe(before);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
