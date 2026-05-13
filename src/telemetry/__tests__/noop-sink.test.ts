import { describe, expect, it } from 'vitest';
import {
  getGlobalTelemetrySink,
  instrumentAiCall,
  NoopSink,
  setGlobalTelemetrySink,
} from '../index.js';

describe('NoopSink', () => {
  it('returns a span that no-ops on every method', () => {
    const sink = new NoopSink();
    const span = sink.startSpan('ai.embed', { 'ai.model': 'test-model' });
    // None of these should throw or mutate observable state.
    span.setAttribute('foo', 'bar');
    span.setAttributes({ a: 1, b: true });
    span.recordError(new Error('boom'));
    span.setStatus('error', 'still no-op');
    span.end();
    // emit is also a no-op.
    expect(() => sink.emit('test.event', { k: 'v' })).not.toThrow();
  });

  it('flush and shutdown resolve immediately', async () => {
    const sink = new NoopSink();
    await expect(sink.flush()).resolves.toBeUndefined();
    await expect(sink.shutdown()).resolves.toBeUndefined();
  });

  it('global sink defaults to noop', () => {
    setGlobalTelemetrySink(null);
    const sink = getGlobalTelemetrySink();
    expect(sink.name).toBe('noop');
  });

  it('instrumentAiCall propagates the wrapped function result and never throws on noop', async () => {
    setGlobalTelemetrySink(null);
    const sink = getGlobalTelemetrySink();
    const result = await instrumentAiCall(
      sink,
      'embed',
      { provider: 'openai', model: 'x', inputSize: 4 },
      async () => 42,
    );
    expect(result).toBe(42);
  });

  it('instrumentAiCall rethrows errors after recording on the span', async () => {
    setGlobalTelemetrySink(null);
    const sink = getGlobalTelemetrySink();
    await expect(
      instrumentAiCall(
        sink,
        'generate',
        { provider: 'openai', model: 'x', inputSize: 4 },
        async () => {
          throw new Error('upstream failed');
        },
      ),
    ).rejects.toThrow('upstream failed');
  });
});
