import { describe, expect, it } from 'vitest';
import { createTelemetrySink } from '../index.js';

describe('createTelemetrySink', () => {
  it('returns NoopSink when observability is disabled', async () => {
    const sink = await createTelemetrySink({ enabled: false, sink: 'otlp' });
    expect(sink.name).toBe('noop');
  });

  it('returns NoopSink when config is undefined', async () => {
    const sink = await createTelemetrySink(undefined);
    expect(sink.name).toBe('noop');
  });

  it('returns NoopSink when sink="noop" even if enabled=true', async () => {
    const sink = await createTelemetrySink({ enabled: true, sink: 'noop' });
    expect(sink.name).toBe('noop');
  });

  it('returns OtlpSink when configured', async () => {
    const sink = await createTelemetrySink({
      enabled: true,
      sink: 'otlp',
      otlp: { endpoint: 'http://localhost:4318/v1/traces' },
    });
    expect(sink.name).toBe('otlp');
    await sink.shutdown();
  });

  it('falls back to noop when langfuse keys are missing', async () => {
    const sink = await createTelemetrySink({
      enabled: true,
      sink: 'langfuse',
      langfuse: { endpoint: 'https://cloud.langfuse.com' },
    });
    expect(sink.name).toBe('noop');
  });

  it('wraps with SamplingSink when sampleRate < 1', async () => {
    const sink = await createTelemetrySink({
      enabled: true,
      sink: 'otlp',
      sampleRate: 0.25,
      otlp: { endpoint: 'http://localhost:4318/v1/traces' },
    });
    expect(sink.name).toMatch(/^sampled/);
    await sink.shutdown();
  });
});
