import { describe, expect, it, vi } from 'vitest';
import { MultiSink, NoopSink, SamplingSink } from '../sink.js';
import type { Attributes, Span, TelemetrySink } from '../types.js';

/** A simple recording sink used to assert what fan-out / sampling actually let through. */
class CountingSink implements TelemetrySink {
  readonly name = 'counting';
  spans = 0;
  events = 0;
  startSpan(name: string, _attributes?: Attributes): Span {
    this.spans++;
    return {
      id: String(this.spans),
      name,
      setAttribute() {},
      setAttributes() {},
      recordError() {},
      setStatus() {},
      end() {},
    };
  }
  emit(_eventName: string, _attributes?: Attributes): void {
    this.events++;
  }
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

describe('SamplingSink', () => {
  it('keeps every span when sampleRate >= 1', () => {
    const inner = new CountingSink();
    const sink = new SamplingSink(inner, 1);
    for (let i = 0; i < 50; i++) sink.startSpan('x').end();
    expect(inner.spans).toBe(50);
  });

  it('drops every span when sampleRate <= 0', () => {
    const inner = new CountingSink();
    const sink = new SamplingSink(inner, 0);
    for (let i = 0; i < 50; i++) sink.startSpan('x').end();
    expect(inner.spans).toBe(0);
  });

  it('samples roughly at the configured rate', () => {
    const inner = new CountingSink();
    const sink = new SamplingSink(inner, 0.5);
    // Use a seeded Math.random for determinism in CI.
    let i = 0;
    const seq = [0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6];
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => seq[i++ % seq.length] ?? 0.5);
    try {
      for (let n = 0; n < 8; n++) sink.startSpan('x').end();
    } finally {
      spy.mockRestore();
    }
    // 4 of the 8 sequence values are < 0.5 → 4 spans pass through.
    expect(inner.spans).toBe(4);
  });
});

describe('MultiSink', () => {
  it('fans out spans to every wrapped sink', () => {
    const a = new CountingSink();
    const b = new CountingSink();
    const sink = new MultiSink([a, b]);
    sink.startSpan('hi').end();
    expect(a.spans).toBe(1);
    expect(b.spans).toBe(1);
  });

  it('fans out emit() calls', () => {
    const a = new CountingSink();
    const b = new CountingSink();
    const sink = new MultiSink([a, b]);
    sink.emit('ping');
    expect(a.events).toBe(1);
    expect(b.events).toBe(1);
  });

  it('shutdown resolves when every inner sink does', async () => {
    const sink = new MultiSink([new NoopSink(), new NoopSink()]);
    await expect(sink.shutdown()).resolves.toBeUndefined();
  });
});
