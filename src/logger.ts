import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const level = process.env.TRACE_MCP_LOG_LEVEL ?? 'info';

export const logger = pino({
  name: 'trace-mcp',
  level,
}, process.stderr);

/**
 * Resolve ~ in paths to the user's home directory.
 */
function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Rotate the log file if it exceeds maxSizeBytes.
 * Simple strategy: truncate the file by keeping only the last ~50% of content.
 */
function rotateIfNeeded(filePath: string, maxSizeBytes: number): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= maxSizeBytes) return;

    // Read file, keep last half (find first newline after midpoint)
    const buf = fs.readFileSync(filePath);
    const mid = Math.floor(buf.length / 2);
    const newlineIdx = buf.indexOf(0x0a, mid); // '\n'
    if (newlineIdx === -1) {
      // No newline found — just truncate
      fs.writeFileSync(filePath, '');
      return;
    }
    fs.writeFileSync(filePath, buf.subarray(newlineIdx + 1));
  } catch {
    // File doesn't exist yet or can't be read — ignore
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
  const maxSizeBytes = config.max_size_mb * 1024 * 1024;

  // Ensure parent directory exists
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Rotate before opening
  rotateIfNeeded(filePath, maxSizeBytes);

  // Open append stream
  const fileStream = fs.createWriteStream(filePath, { flags: 'a' });

  // Add a child logger destination — pipe all log events to the file
  const fileLogger = pino({ name: 'trace-mcp', level: config.level }, fileStream);

  // Intercept logger methods to also write to file
  const methods = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
  for (const m of methods) {
    const original = logger[m].bind(logger);
    // @ts-expect-error — pino method reassignment
    logger[m] = (...args: Parameters<typeof original>) => {
      original(...args);
      // @ts-expect-error — same signature
      fileLogger[m](...args);
    };
  }

  // Periodic rotation check (every 60s)
  const timer = setInterval(() => {
    rotateIfNeeded(filePath, maxSizeBytes);
  }, 60_000);
  timer.unref();
}
