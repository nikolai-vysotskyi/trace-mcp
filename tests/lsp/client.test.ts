/**
 * Tests for LspClient — the JSON-RPC-over-stdio transport (Content-Length
 * framing, request/response tracking, lifecycle).
 *
 * Contract under test:
 *   - initialize() spawns the configured command, sends a framed
 *     `initialize` request, and resolves with the server's capabilities
 *   - request() times out and rejects if no response arrives within the
 *     configured window; the pending map is cleaned up (no leak)
 *   - a malformed/unparseable message on stdout is dropped without
 *     crashing the client or corrupting later well-formed messages
 *   - a partial message (split across multiple stdout chunks) is buffered
 *     until complete, then parsed correctly (Content-Length framing over
 *     multiple `data` events)
 *   - a JSON-RPC error response rejects the matching pending request with
 *     the server's error code/message
 *   - process 'exit' and 'error' events reject all in-flight requests
 *     (never hang forever on a dead process)
 *   - shutdown() sends the shutdown/exit sequence and kills the process if
 *     it does not exit in time
 *   - supportsCallHierarchy reflects the server's advertised capabilities
 *
 * We never spawn a real LSP server: node:child_process.spawn is mocked to
 * return a fake ChildProcess (EventEmitter-based stdin/stdout/stderr), and
 * the test drives the JSON-RPC wire protocol by writing framed messages
 * directly onto the fake stdout stream — exercising the real framing/parsing
 * code in client.ts without touching a real process.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { LspClient } from '../../src/lsp/client.js';

/** Minimal fake ChildProcess: EventEmitter + writable stdin + readable stdout/stderr. */
class FakeChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;

  kill(_signal?: string): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit('exit', 0, null);
    return true;
  }
}

function frame(msg: unknown): Buffer {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  return Buffer.from(header + body);
}

/** Parse the most recent request written to stdin.write() and return its id. */
function lastRequestId(writes: string[], method: string): number {
  for (let i = writes.length - 1; i >= 0; i--) {
    const bodyStart = writes[i].indexOf('\r\n\r\n') + 4;
    const parsed = JSON.parse(writes[i].slice(bodyStart));
    if (parsed.method === method) return parsed.id;
  }
  throw new Error(`no request found for method ${method}`);
}

describe('LspClient', () => {
  let proc: FakeChildProcess;
  let writes: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    proc = new FakeChildProcess();
    writes = [];
    const originalWrite = proc.stdin.write.bind(proc.stdin);
    proc.stdin.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      writes.push(chunk.toString());
      // @ts-expect-error — forwarding varargs to PassThrough.write
      return originalWrite(chunk, ...rest);
    }) as typeof proc.stdin.write;
    spawnMock.mockReturnValue(proc);
  });

  afterEach(() => {
    vi.useRealTimers();
    spawnMock.mockReset();
  });

  it('initialize() spawns the command and resolves with server capabilities', async () => {
    const client = new LspClient('typescript-language-server', ['--stdio'], '/repo');
    const initPromise = client.initialize('file:///repo');

    expect(spawnMock).toHaveBeenCalledWith(
      'typescript-language-server',
      ['--stdio'],
      expect.objectContaining({ cwd: '/repo' }),
    );

    const id = lastRequestId(writes, 'initialize');
    proc.stdout.write(
      frame({
        jsonrpc: '2.0',
        id,
        result: { capabilities: { callHierarchyProvider: true } },
      }),
    );

    const result = await initPromise;
    expect(result.capabilities.callHierarchyProvider).toBe(true);
    expect(client.supportsCallHierarchy).toBe(true);
    expect(client.isAlive()).toBe(true);
  });

  it('supportsCallHierarchy is false when the server does not advertise it', async () => {
    const client = new LspClient('gopls', ['serve'], '/repo');
    const initPromise = client.initialize('file:///repo');
    const id = lastRequestId(writes, 'initialize');
    proc.stdout.write(frame({ jsonrpc: '2.0', id, result: { capabilities: {} } }));
    await initPromise;

    expect(client.supportsCallHierarchy).toBe(false);
  });

  it('request() times out and rejects when no response arrives', async () => {
    const client = new LspClient('slow-server', [], '/repo', 30_000);
    const initPromise = client.initialize('file:///repo');
    const initId = lastRequestId(writes, 'initialize');
    proc.stdout.write(frame({ jsonrpc: '2.0', id: initId, result: { capabilities: {} } }));
    await initPromise;

    const reqPromise = client.request('textDocument/definition', {}, 5_000);
    const assertion = expect(reqPromise).rejects.toThrow(/timeout/i);
    await vi.advanceTimersByTimeAsync(5_001);
    await assertion;
  });

  it('a JSON-RPC error response rejects the matching pending request', async () => {
    const client = new LspClient('server', [], '/repo');
    const initPromise = client.initialize('file:///repo');
    const initId = lastRequestId(writes, 'initialize');
    proc.stdout.write(frame({ jsonrpc: '2.0', id: initId, result: { capabilities: {} } }));
    await initPromise;

    const reqPromise = client.request('textDocument/definition', {});
    const reqId = lastRequestId(writes, 'textDocument/definition');
    proc.stdout.write(
      frame({ jsonrpc: '2.0', id: reqId, error: { code: -32601, message: 'Method not found' } }),
    );

    await expect(reqPromise).rejects.toThrow(/Method not found/);
  });

  it('buffers a partial message split across multiple stdout chunks', async () => {
    const client = new LspClient('server', [], '/repo');
    const initPromise = client.initialize('file:///repo');
    const initId = lastRequestId(writes, 'initialize');
    const full = frame({ jsonrpc: '2.0', id: initId, result: { capabilities: {} } });

    // Split the framed message into two chunks mid-body.
    const splitPoint = Math.floor(full.length / 2);
    proc.stdout.write(full.subarray(0, splitPoint));
    // Not yet resolved — body incomplete.
    let settled = false;
    initPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    proc.stdout.write(full.subarray(splitPoint));
    const result = await initPromise;
    expect(result.capabilities).toEqual({});
  });

  it('drops a malformed message without crashing and still processes the next valid one', async () => {
    const client = new LspClient('server', [], '/repo');
    const initPromise = client.initialize('file:///repo');
    const initId = lastRequestId(writes, 'initialize');

    // Malformed JSON body with a valid Content-Length header — must be
    // skipped, not thrown, and must not corrupt the buffer for what follows.
    const garbage = 'not valid json {{{';
    const garbageMsg = Buffer.from(
      `Content-Length: ${Buffer.byteLength(garbage)}\r\n\r\n${garbage}`,
    );
    proc.stdout.write(garbageMsg);
    proc.stdout.write(frame({ jsonrpc: '2.0', id: initId, result: { capabilities: {} } }));

    const result = await initPromise;
    expect(result.capabilities).toEqual({});
  });

  it('process "exit" rejects all in-flight requests', async () => {
    const client = new LspClient('server', [], '/repo');
    const initPromise = client.initialize('file:///repo');
    const initId = lastRequestId(writes, 'initialize');
    proc.stdout.write(frame({ jsonrpc: '2.0', id: initId, result: { capabilities: {} } }));
    await initPromise;

    const reqPromise = client.request('textDocument/definition', {});
    proc.exitCode = 1;
    proc.emit('exit', 1, null);

    await expect(reqPromise).rejects.toThrow(/LSP process exited/);
    expect(client.isAlive()).toBe(false);
  });

  it('process "error" rejects all in-flight requests', async () => {
    const client = new LspClient('server', [], '/repo');
    const initPromise = client.initialize('file:///repo');
    const initId = lastRequestId(writes, 'initialize');
    proc.stdout.write(frame({ jsonrpc: '2.0', id: initId, result: { capabilities: {} } }));
    await initPromise;

    const reqPromise = client.request('textDocument/definition', {});
    proc.emit('error', new Error('spawn ENOENT'));

    await expect(reqPromise).rejects.toThrow(/LSP process error/);
  });

  it('request() rejects immediately when the client is not connected', async () => {
    const client = new LspClient('server', [], '/repo');
    // Never call initialize() — stdin is never wired up.
    await expect(client.request('foo', {})).rejects.toThrow(/not connected/);
  });

  it('shutdown() sends shutdown/exit and resolves once the process exits', async () => {
    const client = new LspClient('server', [], '/repo');
    const initPromise = client.initialize('file:///repo');
    const initId = lastRequestId(writes, 'initialize');
    proc.stdout.write(frame({ jsonrpc: '2.0', id: initId, result: { capabilities: {} } }));
    await initPromise;

    const shutdownPromise = client.shutdown();
    const shutdownId = lastRequestId(writes, 'shutdown');
    proc.stdout.write(frame({ jsonrpc: '2.0', id: shutdownId, result: null }));
    // The client's shutdown() awaits request('shutdown', ...) (a real Promise
    // chain through the PassThrough 'data' event + onMessage), THEN attaches
    // the one-time 'exit' listener inside a fresh Promise executor. Flush
    // enough microtask ticks for all of that to settle before emitting exit.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    proc.exitCode = 0;
    proc.emit('exit', 0, null);

    await shutdownPromise;
    expect(client.isAlive()).toBe(false);
  });

  it('shutdown() force-kills the process if it does not exit within the grace period', async () => {
    const client = new LspClient('server', [], '/repo');
    const initPromise = client.initialize('file:///repo');
    const initId = lastRequestId(writes, 'initialize');
    proc.stdout.write(frame({ jsonrpc: '2.0', id: initId, result: { capabilities: {} } }));
    await initPromise;

    const killSpy = vi.spyOn(proc, 'kill');
    const shutdownPromise = client.shutdown();
    const shutdownId = lastRequestId(writes, 'shutdown');
    proc.stdout.write(frame({ jsonrpc: '2.0', id: shutdownId, result: null }));
    await Promise.resolve();
    await Promise.resolve();

    // Process never emits 'exit' on its own — advance past the 3s kill timer.
    await vi.advanceTimersByTimeAsync(3_001);
    await shutdownPromise;

    expect(killSpy).toHaveBeenCalledWith('SIGKILL');
  });

  it('isAlive() is false before initialize() and true only after a successful handshake', async () => {
    const client = new LspClient('server', [], '/repo');
    expect(client.isAlive()).toBe(false);

    const initPromise = client.initialize('file:///repo');
    expect(client.isAlive()).toBe(false); // spawned but not yet initialized

    const initId = lastRequestId(writes, 'initialize');
    proc.stdout.write(frame({ jsonrpc: '2.0', id: initId, result: { capabilities: {} } }));
    await initPromise;

    expect(client.isAlive()).toBe(true);
  });
});
