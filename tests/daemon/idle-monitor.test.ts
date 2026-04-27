import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DaemonIdleMonitor } from '../../src/daemon/idle-monitor.js';

describe('DaemonIdleMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onIdle after idleTimeoutMs of zero busy', () => {
    let busy = false;
    const onIdle = vi.fn();
    const m = new DaemonIdleMonitor({ idleTimeoutMs: 1_000, isBusy: () => busy, onIdle });
    m.onActivity();
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('does NOT call onIdle when isBusy is true', () => {
    let busy = true;
    const onIdle = vi.fn();
    const m = new DaemonIdleMonitor({ idleTimeoutMs: 500, isBusy: () => busy, onIdle });
    m.onActivity();
    vi.advanceTimersByTime(5_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('cancels the armed timer when a client connects before timeout', () => {
    let busy = false;
    const onIdle = vi.fn();
    const m = new DaemonIdleMonitor({ idleTimeoutMs: 1_000, isBusy: () => busy, onIdle });
    m.onActivity();

    // Client connects mid-flight.
    vi.advanceTimersByTime(400);
    busy = true;
    m.onActivity();

    vi.advanceTimersByTime(5_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('re-arms after a client disconnects', () => {
    let busy = true;
    const onIdle = vi.fn();
    const m = new DaemonIdleMonitor({ idleTimeoutMs: 500, isBusy: () => busy, onIdle });
    m.onActivity();
    vi.advanceTimersByTime(2_000);
    expect(onIdle).not.toHaveBeenCalled();

    busy = false;
    m.onActivity();
    vi.advanceTimersByTime(500);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('re-checks isBusy at fire time — suppresses exit if client connected last-ms', () => {
    let busy = false;
    const onIdle = vi.fn();
    const m = new DaemonIdleMonitor({ idleTimeoutMs: 1_000, isBusy: () => busy, onIdle });
    m.onActivity();

    vi.advanceTimersByTime(999);
    // Last-millisecond connect — client bumps busy flag but onActivity NOT called.
    busy = true;
    vi.advanceTimersByTime(10);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('stop() cancels any pending timer and disables further callbacks', () => {
    let busy = false;
    const onIdle = vi.fn();
    const m = new DaemonIdleMonitor({ idleTimeoutMs: 500, isBusy: () => busy, onIdle });
    m.onActivity();
    m.stop();
    vi.advanceTimersByTime(5_000);
    expect(onIdle).not.toHaveBeenCalled();

    // After stop(), further onActivity is a noop.
    m.onActivity();
    vi.advanceTimersByTime(5_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('disabled when idleTimeoutMs <= 0', () => {
    let busy = false;
    const onIdle = vi.fn();
    const m = new DaemonIdleMonitor({ idleTimeoutMs: 0, isBusy: () => busy, onIdle });
    expect(m.enabled).toBe(false);
    m.onActivity();
    vi.advanceTimersByTime(10_000_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
