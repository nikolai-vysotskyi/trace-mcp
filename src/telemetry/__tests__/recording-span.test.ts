import { describe, expect, it } from 'vitest';
import { MAX_SPAN_EVENTS, RecordingSpan } from '../sink.js';

describe('RecordingSpan event cap', () => {
  it('caps stored events at MAX_SPAN_EVENTS, dropping the oldest', () => {
    const span = new RecordingSpan('long-lived', undefined, () => {});
    for (let i = 0; i < MAX_SPAN_EVENTS + 50; i++) {
      span.recordError(new Error(`boom ${i}`));
    }
    expect(span.events.length).toBe(MAX_SPAN_EVENTS);
    expect(span.droppedEvents).toBe(50);
    // Oldest dropped: the most recent event must remain.
    const last = span.events[span.events.length - 1];
    const msg = last?.attributes?.['exception.message'];
    expect(msg).toBe(`boom ${MAX_SPAN_EVENTS + 50 - 1}`);
  });

  it('fires onDrop exactly once even if many overflow events happen', () => {
    const drops: Array<{ count: number }> = [];
    const span = new RecordingSpan('s', undefined, () => {}, {
      maxEvents: 5,
      onDrop: (_s, count) => drops.push({ count }),
    });
    for (let i = 0; i < 20; i++) span.recordError(new Error(`e${i}`));
    expect(drops.length).toBe(1);
    expect(drops[0]!.count).toBe(1); // first overflow drop
    expect(span.droppedEvents).toBe(15);
    expect(span.events.length).toBe(5);
  });

  it('respects a custom maxEvents value', () => {
    const span = new RecordingSpan('s', undefined, () => {}, { maxEvents: 3 });
    span.recordError(new Error('a'));
    span.recordError(new Error('b'));
    span.recordError(new Error('c'));
    span.recordError(new Error('d'));
    expect(span.events.length).toBe(3);
    expect(span.droppedEvents).toBe(1);
    expect(span.events[0]?.attributes?.['exception.message']).toBe('b');
  });

  it('does not push events after end()', () => {
    const span = new RecordingSpan('s', undefined, () => {});
    span.recordError(new Error('first'));
    span.end();
    span.recordError(new Error('second'));
    expect(span.events.length).toBe(1);
  });
});
