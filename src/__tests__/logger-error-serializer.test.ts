// TRA-420: the daemon logged 196 errors in one day as `"error":{}` — no name,
// no message, no stack — because pino only applies its error serializer to the
// `err` key while 80 call sites in this repo log under `error`. Without the
// serializer, every "Watcher error" / "Embedding batch failed" entry in
// daemon.log is undiagnosable, which is exactly what blocked root-causing the
// daemon restart storm. Asserts against the real logger, not a local pino.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger.js';

/** Emit one line through the real logger and parse what hit stderr. */
function logAndCapture(bindings: Record<string, unknown>): Record<string, unknown> {
  let line = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    line = String(chunk);
    return true;
  });
  try {
    logger.error(bindings, 'boom');
  } finally {
    spy.mockRestore();
  }
  expect(line, 'logger wrote nothing to stderr — is the level above error?').not.toBe('');
  return JSON.parse(line);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logger error serialization', () => {
  for (const key of ['error', 'err']) {
    it(`serializes an Error logged under "${key}" into type/message/stack`, () => {
      const out = logAndCapture({ [key]: new TypeError('watcher exploded') });
      const payload = out[key] as Record<string, unknown>;

      expect(payload).toBeTruthy();
      expect(payload.type).toBe('TypeError');
      expect(payload.message).toBe('watcher exploded');
      expect(String(payload.stack)).toContain('watcher exploded');
      // The regression: an unserialized Error stringifies to exactly `{}`.
      expect(JSON.stringify(payload)).not.toBe('{}');
    });
  }

  it('leaves a non-Error value under "error" usable', () => {
    const out = logAndCapture({ error: 'plain string failure' });
    expect(out.error).toBe('plain string failure');
  });
});
