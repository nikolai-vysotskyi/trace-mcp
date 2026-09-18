/**
 * TRA-1642 — the daemon answers a project it doesn't serve with a JSON
 * envelope `{ error, reason }`. The Notebook used to throw that envelope
 * verbatim (`HTTP 404: {"error":"…"}`), painting the wire protocol on the
 * screen while the Graph tab showed the daemon's sentence under a title.
 * These drive the unwrapping in notebook-runtime: the thrown error carries
 * the daemon's sentence and its `reason`, so the cell can render a friendly
 * state instead of raw JSON.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonError, daemonError, defaultNotebookClient } from '../notebook-runtime.js';

const NOT_REGISTERED_BODY = JSON.stringify({
  error: `"trace-mcp" isn't registered with this daemon. Add it from the app's project list.`,
  reason: 'not_registered',
});

const root = '/Users/someone/code/my-project';

/** Stub the single fetch the `search` path issues. */
function stubSearch(status: number, body: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status, text: async () => body }) as unknown as Response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('daemonError', () => {
  it('unwraps the `{ error, reason }` envelope to the daemon sentence', () => {
    const err = daemonError(404, NOT_REGISTERED_BODY);
    expect(err).toBeInstanceOf(DaemonError);
    expect(err.message).toBe(
      `"trace-mcp" isn't registered with this daemon. Add it from the app's project list.`,
    );
    expect(err.reason).toBe('not_registered');
    expect(err.status).toBe(404);
  });

  it('falls back to the bare status when the body is not the envelope', () => {
    expect(daemonError(500, 'boom').message).toBe('HTTP 500: boom');
    expect(daemonError(500, 'boom').reason).toBeUndefined();
    expect(daemonError(404, '').message).toBe('HTTP 404');
  });

  it('falls back when `error` is missing or blank', () => {
    expect(daemonError(404, JSON.stringify({ reason: 'not_registered' })).message).toBe(
      `HTTP 404: ${JSON.stringify({ reason: 'not_registered' })}`,
    );
  });
});

describe('defaultNotebookClient error shaping (TRA-1642)', () => {
  it('rejects `search` against an unregistered project with the daemon sentence, not raw JSON', async () => {
    stubSearch(404, NOT_REGISTERED_BODY);
    const failure = await defaultNotebookClient
      .callTool('search', { query: 'registerTool' }, root)
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(failure).toBeInstanceOf(DaemonError);
    const err = failure as DaemonError;
    expect(err.message).not.toMatch(/HTTP 404/);
    expect(err.message).not.toMatch(/\\"/);
    expect(err.message).toBe(
      `"trace-mcp" isn't registered with this daemon. Add it from the app's project list.`,
    );
    expect(err.reason).toBe('not_registered');
  });
});
