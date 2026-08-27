import { describe, expect, it } from 'vitest';
import { type DaemonProgress, toProgressSnapshot } from '../useDaemon';

/** Shape captured verbatim off `GET /api/events` for an idle project. */
const idlePayload: DaemonProgress = {
  indexing: { phase: 'completed', processed: 0, total: 0, percentage: null, elapsedMs: 544 },
  summarization: { phase: 'idle', processed: 0, total: 0, percentage: null, elapsedMs: 0 },
  embedding: { phase: 'completed', processed: 279, total: 279, percentage: 100, elapsedMs: 31389 },
};

describe('toProgressSnapshot', () => {
  it('returns undefined when no pipeline is running', () => {
    expect(toProgressSnapshot(idlePayload)).toBeUndefined();
    expect(toProgressSnapshot(undefined)).toBeUndefined();
    expect(toProgressSnapshot({} as DaemonProgress)).toBeUndefined();
  });

  it('flattens the running pipeline', () => {
    const snap = toProgressSnapshot({
      ...idlePayload,
      embedding: { phase: 'running', processed: 40, total: 200, percentage: 20, elapsedMs: 100 },
    });
    expect(snap).toEqual({ phase: 'embedding', current: 40, total: 200, percent: 20 });
  });

  it('picks indexing over a later running pipeline', () => {
    const snap = toProgressSnapshot({
      indexing: { phase: 'running', processed: 1, total: 4, percentage: 25, elapsedMs: 10 },
      embedding: { phase: 'running', processed: 40, total: 200, percentage: 20, elapsedMs: 100 },
    });
    expect(snap?.phase).toBe('indexing');
  });

  it('falls back to 0% when the daemon reports a null percentage', () => {
    const snap = toProgressSnapshot({
      indexing: { phase: 'running', processed: 0, total: 0, percentage: null, elapsedMs: 0 },
    });
    expect(snap).toEqual({ phase: 'indexing', current: 0, total: 0, percent: 0 });
  });
});
