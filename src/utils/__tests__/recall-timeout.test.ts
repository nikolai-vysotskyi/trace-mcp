/**
 * Behavioural coverage for `withRecallTimeout`.
 *
 * Slowness must be silently degraded; bugs must propagate. These tests pin
 * both halves so a future refactor can't accidentally swallow real errors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../logger.js';
import { withRecallTimeout } from '../recall-timeout.js';

describe('withRecallTimeout', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns the actual value when the work resolves under budget', async () => {
    const result = await withRecallTimeout(() => Promise.resolve(42), {
      timeoutMs: 1000,
      fallback: -1,
      toolName: 'fast',
    });
    expect(result).toBe(42);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns the fallback when the work exceeds the budget', async () => {
    // 200ms work vs 50ms budget — fallback wins, warn logged once.
    const slow = () =>
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('too-late'), 200);
      });
    const result = await withRecallTimeout(slow, {
      timeoutMs: 50,
      fallback: 'fallback-payload',
      toolName: 'slow',
    });
    expect(result).toBe('fallback-payload');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Structured log: first arg is the metadata bag, second is the message.
    const [meta, msg] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(meta).toMatchObject({
      toolName: 'slow',
      timeoutMs: 50,
      counter: 'recall_timeouts_total',
    });
    expect(msg).toMatch(/recall timeout/i);
  });

  it('propagates synchronous and asynchronous errors without swallowing them', async () => {
    const boom = () => {
      throw new Error('boom-sync');
    };
    await expect(
      withRecallTimeout(boom, { timeoutMs: 1000, fallback: 'ignored', toolName: 'err' }),
    ).rejects.toThrow('boom-sync');

    const asyncBoom = () => Promise.reject(new Error('boom-async'));
    await expect(
      withRecallTimeout(asyncBoom, {
        timeoutMs: 1000,
        fallback: 'ignored',
        toolName: 'err',
      }),
    ).rejects.toThrow('boom-async');

    // Errors are bugs, not slowness. No timeout warning should fire.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('lifts a synchronous return value through the Promise.race', async () => {
    const result = await withRecallTimeout(() => 'sync-value', {
      timeoutMs: 1000,
      fallback: 'fallback',
      toolName: 'sync',
    });
    expect(result).toBe('sync-value');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns the fallback when timeoutMs is 0 instead of deadlocking', async () => {
    // 0ms budget vs a 30ms work — the timeout fires on the next microtask tick
    // so the work has no chance to settle first.
    const slow = () =>
      new Promise<number>((resolve) => {
        setTimeout(() => resolve(99), 30);
      });
    const result = await withRecallTimeout(slow, {
      timeoutMs: 0,
      fallback: -1,
      toolName: 'zero-budget',
    });
    expect(result).toBe(-1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('does not surface an unhandled rejection when the abandoned work later fails', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const slow = () =>
        new Promise<string>((_resolve, reject) => {
          setTimeout(() => reject(new Error('after-timeout')), 30);
        });
      const result = await withRecallTimeout(slow, {
        timeoutMs: 5,
        fallback: 'fallback',
        toolName: 'orphan',
      });
      expect(result).toBe('fallback');
      // Give the abandoned promise a chance to reject.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
