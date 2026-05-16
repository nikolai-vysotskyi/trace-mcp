import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';

const level = process.env.TRACE_MCP_LOG_LEVEL ?? 'info';

export const logger = pino(
  {
    name: 'trace-mcp',
    level,
  },
  process.stderr,
);

// Resolve ~ in paths to the user's home directory.
function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

// Check rotation every Nth write. Cheap stat call; bounds size between checks.
const WRITE_CHECK_INTERVAL = 256;
// Backstop timer interval. Short enough that an idle-but-slowly-growing log still rotates.
const TIMER_INTERVAL_MS = 5_000;

/**
 * Atomic-rename rotation. O(1) regardless of file size — never reads the file.
 * Renames filePath -> filePath.1 (overwriting any prior .1), then the caller opens
 * a fresh stream. Keeps one previous generation; older content is discarded.
 */
function rotateAtomic(filePath: string): void {
  const rotated = `${filePath}.1`;
  try {
    fs.renameSync(filePath, rotated);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Original gone is fine; anything else we swallow — logger must not throw.
    if (code !== 'ENOENT') return;
  }
}

/**
 * Attach a file transport to the logger based on config.
 * Call this after config is loaded (logger is created early, before config).
 */
export function attachFileLogging(config: {
  file: boolean;
  path: string;
  level: string;
  max_size_mb: number;
}): void {
  if (!config.file) return;

  const filePath = expandHome(config.path);
  const maxSizeBytes = Math.max(1, config.max_size_mb) * 1024 * 1024;

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // 'error' listener prevents fd write failures (ENOENT after dir removal,
  // EACCES, ENOSPC) from crashing the daemon — logger is best-effort.
  const swallow = (s: fs.WriteStream): fs.WriteStream => {
    s.on('error', () => {});
    return s;
  };

  // State the rotator + writes share.
  let fileStream = swallow(fs.createWriteStream(filePath, { flags: 'a' }));
  let fileLogger = pino({ name: 'trace-mcp', level: config.level }, fileStream);
  let writeCounter = 0;
  let rotating = false;

  const rotateIfOversize = (): void => {
    if (rotating) return;
    let size: number;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return; // File missing or unreadable — nothing to do.
    }
    if (size <= maxSizeBytes) return;

    rotating = true;
    try {
      // End the current stream before renaming so the fd is closed cleanly.
      const oldStream = fileStream;
      oldStream.end();

      rotateAtomic(filePath);

      // Open a fresh stream. Any writes that race in here go to it.
      fileStream = swallow(fs.createWriteStream(filePath, { flags: 'a' }));
      fileLogger = pino({ name: 'trace-mcp', level: config.level }, fileStream);
    } catch {
      // Swallow — logger must never throw at call sites.
    } finally {
      rotating = false;
    }
  };

  const methods = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
  for (const m of methods) {
    const original = logger[m].bind(logger);
    // @ts-expect-error — pino method reassignment
    logger[m] = (...args: Parameters<typeof original>) => {
      original(...args);
      // @ts-expect-error — same signature
      fileLogger[m](...args);
      writeCounter++;
      if (writeCounter >= WRITE_CHECK_INTERVAL) {
        writeCounter = 0;
        rotateIfOversize();
      }
    };
  }

  // Backstop: a slow trickle of writes still gets rotated on time.
  const timer = setInterval(rotateIfOversize, TIMER_INTERVAL_MS);
  timer.unref();
}
