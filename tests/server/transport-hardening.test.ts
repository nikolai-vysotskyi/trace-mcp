import { ReadBuffer } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _isStdoutGuardArmedForTest,
  armStdoutGuard,
  disarmStdoutGuard,
  forceUtf8Stdio,
  hardenStdio,
} from '../../src/server/transport-hardening.js';

const INIT_FRAME =
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.0"}}}\n';

describe('transport-hardening', () => {
  afterEach(() => {
    // Restore real stdout regardless of what the test did.
    disarmStdoutGuard();
    vi.restoreAllMocks();
  });

  it('forceUtf8Stdio does not throw on this platform', () => {
    expect(() => forceUtf8Stdio()).not.toThrow();
  });

  it('forceUtf8Stdio never calls setEncoding on stdin — would crash MCP ReadBuffer.subarray', () => {
    const stdinSpy = vi.spyOn(process.stdin, 'setEncoding');
    forceUtf8Stdio();
    expect(stdinSpy).not.toHaveBeenCalled();
  });

  it('armStdoutGuard is idempotent', () => {
    armStdoutGuard();
    expect(_isStdoutGuardArmedForTest()).toBe(true);
    armStdoutGuard(); // second call is a no-op
    expect(_isStdoutGuardArmedForTest()).toBe(true);
    disarmStdoutGuard();
  });

  it('disarmStdoutGuard is safe to call when not armed', () => {
    expect(_isStdoutGuardArmedForTest()).toBe(false);
    expect(() => disarmStdoutGuard()).not.toThrow();
  });

  it('routes stdout.write to stderr while armed', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    armStdoutGuard();
    process.stdout.write('hello stdout\n');
    expect(stderrSpy).toHaveBeenCalled();
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('hello stdout'))).toBe(true);
    disarmStdoutGuard();
  });

  it('restores native stdout.write after disarm', () => {
    const beforeArm = process.stdout.write;
    armStdoutGuard();
    expect(process.stdout.write).not.toBe(beforeArm);
    disarmStdoutGuard();
    expect(process.stdout.write).toBe(beforeArm);
  });

  it('hardenStdio installs UTF-8 + stdout guard in one call', () => {
    expect(_isStdoutGuardArmedForTest()).toBe(false);
    hardenStdio();
    expect(_isStdoutGuardArmedForTest()).toBe(true);
    disarmStdoutGuard();
  });

  // The two tests below pin the upstream SDK invariant that motivates
  // forceUtf8Stdio NOT touching stdin. The SDK's ReadBuffer assumes Buffer
  // chunks and calls `.subarray()` on the accumulated buffer; if stdin is
  // ever flipped into string-emitting mode (e.g. via setEncoding) the SDK
  // crashes on every frame.

  it('SDK ReadBuffer parses a JSON-RPC frame from a Buffer chunk (happy path)', () => {
    const buf = new ReadBuffer();
    buf.append(Buffer.from(INIT_FRAME, 'utf8'));
    const msg = buf.readMessage() as { method?: string; id?: number } | null;
    expect(msg).not.toBeNull();
    expect(msg?.method).toBe('initialize');
    expect(msg?.id).toBe(1);
  });

  it('SDK ReadBuffer crashes on string chunks — pins the invariant fix relies on', () => {
    const buf = new ReadBuffer();
    // Simulate what stdin would emit if forceUtf8Stdio ever set its encoding
    // to utf8: chunks arrive as strings instead of Buffers.
    // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the SDK type to reproduce the bug
    (buf as any).append(INIT_FRAME);
    expect(() => buf.readMessage()).toThrowError(/subarray is not a function/);
  });
});
