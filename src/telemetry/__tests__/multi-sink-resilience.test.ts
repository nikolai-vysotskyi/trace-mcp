import { describe, expect, it, vi } from 'vitest';
import { MultiSink } from '../sink.js';
import type { Attributes, Span, TelemetrySink } from '../types.js';

/**
 * Stub sink that records calls to `flush()` / `shutdown()` and can be
 * configured to reject either operation. Used to verify that MultiSink
 * isolates failures so each sibling sink still gets its chance to run.
 */
class StubSink implements TelemetrySink {
  readonly name: string;
  flush = vi.fn(async () => {});
  shutdown = vi.fn(async () => {});

  constructor(name: string) {
    this.name = name;
  }

  startSpan(name: string, _attributes?: Attributes): Span {
    return {
      id: '',
      name,
      setAttribute() {},
      setAttributes() {},
      recordError() {},
      setStatus() {},
      end() {},
    };
  }
  emit(_eventName: string, _attributes?: Attributes): void {}
}

describe('MultiSink resilience', () => {
  it('flush(): a rejecting sibling does not stop the resolving one from completing', async () => {
    const failing = new StubSink('failing');
    failing.flush.mockRejectedValueOnce(new Error('boom'));
    const healthy = new StubSink('healthy');

    const sink = new MultiSink([failing, healthy]);
    await expect(sink.flush()).resolves.toBeUndefined();

    expect(failing.flush).toHaveBeenCalledTimes(1);
    expect(healthy.flush).toHaveBeenCalledTimes(1);
  });

  it('shutdown(): a rejecting sibling does not stop the resolving one from completing', async () => {
    const failing = new StubSink('failing');
    failing.shutdown.mockRejectedValueOnce(new Error('boom'));
    const healthy = new StubSink('healthy');

    const sink = new MultiSink([failing, healthy]);
    await expect(sink.shutdown()).resolves.toBeUndefined();

    expect(failing.shutdown).toHaveBeenCalledTimes(1);
    expect(healthy.shutdown).toHaveBeenCalledTimes(1);
  });
});
