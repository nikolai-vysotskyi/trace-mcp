import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as parcelWatcher from '@parcel/watcher';
import { FileWatcher } from '../../src/indexer/watcher.js';
import type { TraceMcpConfig } from '../../src/config.js';

vi.mock('@parcel/watcher', () => ({
  subscribe: vi.fn(),
}));

const mockConfig: TraceMcpConfig = {
  root: '/project',
  include: ['src/**/*.ts'],
  exclude: [],
  db: { path: ':memory:' },
  plugins: [],
};

type WatchCallback = (err: Error | null, events: parcelWatcher.Event[]) => Promise<void>;

// ── Controlled timer stub ────────────────────────────────────
let timerId = 0;

function makeControlledTimer() {
  let pendingFn: (() => void | Promise<void>) | null = null;

  const set = vi.fn((fn: () => void | Promise<void>, _ms: number) => {
    pendingFn = fn;
    return ++timerId as unknown as ReturnType<typeof setTimeout>;
  });

  const clear = vi.fn(() => {
    pendingFn = null;
  });

  const flush = async () => {
    if (pendingFn) {
      const fn = pendingFn;
      pendingFn = null;
      await fn();
    }
  };

  const hasPending = () => pendingFn !== null;

  return { set, clear, flush, hasPending };
}

describe('FileWatcher', () => {
  let watcher: FileWatcher;
  let timer: ReturnType<typeof makeControlledTimer>;
  let mockUnsubscribe: ReturnType<typeof vi.fn>;
  let capturedCallback: WatchCallback;

  beforeEach(() => {
    timer = makeControlledTimer();
    watcher = new FileWatcher(
      timer.set as unknown as typeof setTimeout,
      timer.clear as unknown as typeof clearTimeout,
    );
    mockUnsubscribe = vi.fn().mockResolvedValue(undefined);

    vi.mocked(parcelWatcher.subscribe).mockImplementation(async (_root, cb) => {
      capturedCallback = cb as WatchCallback;
      return { unsubscribe: mockUnsubscribe };
    });
  });

  afterEach(async () => {
    await watcher.stop();
    vi.clearAllMocks();
  });

  // ── Basic event handling ─────────────────────────────────────

  it('subscribes to rootPath with ignored dirs', async () => {
    await watcher.start('/project', mockConfig, vi.fn());

    expect(parcelWatcher.subscribe).toHaveBeenCalledWith(
      '/project',
      expect.any(Function),
      expect.objectContaining({
        ignore: expect.arrayContaining([
          expect.stringContaining('node_modules'),
          expect.stringContaining('vendor'),
        ]),
      }),
    );
  });

  it('calls onChanges after debounce for create and update events', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges);

    await capturedCallback(null, [
      { type: 'create', path: '/project/src/foo.ts' },
      { type: 'update', path: '/project/src/bar.ts' },
    ]);

    // Not fired yet — debounce pending
    expect(onChanges).not.toHaveBeenCalled();
    expect(timer.hasPending()).toBe(true);

    await timer.flush();

    expect(onChanges).toHaveBeenCalledOnce();
    const [paths] = onChanges.mock.calls[0];
    expect(paths).toContain('/project/src/foo.ts');
    expect(paths).toContain('/project/src/bar.ts');
  });

  it('ignores delete events', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges);

    await capturedCallback(null, [{ type: 'delete', path: '/project/src/gone.ts' }]);
    await timer.flush();

    expect(onChanges).not.toHaveBeenCalled();
  });

  it('filters out files inside ignored directories', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges);

    await capturedCallback(null, [
      { type: 'update', path: '/project/node_modules/pkg/index.js' },
      { type: 'update', path: '/project/vendor/lib/Foo.php' },
      { type: 'update', path: '/project/src/app.ts' },
    ]);
    await timer.flush();

    expect(onChanges).toHaveBeenCalledWith(['/project/src/app.ts']);
  });

  it('does not call onChanges when event list is empty', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges);

    await capturedCallback(null, []);
    await timer.flush();

    expect(onChanges).not.toHaveBeenCalled();
  });

  it('does not call onChanges when all events are filtered out', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges);

    await capturedCallback(null, [
      { type: 'delete', path: '/project/src/old.ts' },
      { type: 'update', path: '/project/node_modules/x/y.js' },
    ]);
    await timer.flush();

    expect(onChanges).not.toHaveBeenCalled();
  });

  // ── Debounce-specific ────────────────────────────────────────

  it('coalesces rapid events into a single onChanges call', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges);

    // Three rapid bursts — each resets the timer
    await capturedCallback(null, [{ type: 'update', path: '/project/src/a.ts' }]);
    await capturedCallback(null, [{ type: 'update', path: '/project/src/b.ts' }]);
    await capturedCallback(null, [{ type: 'update', path: '/project/src/c.ts' }]);

    // Timer was rescheduled; clear was called twice
    expect(timer.clear).toHaveBeenCalledTimes(2);
    expect(onChanges).not.toHaveBeenCalled();

    await timer.flush();

    // All paths collapsed into one call
    expect(onChanges).toHaveBeenCalledOnce();
    const [paths] = onChanges.mock.calls[0];
    expect(paths).toContain('/project/src/a.ts');
    expect(paths).toContain('/project/src/b.ts');
    expect(paths).toContain('/project/src/c.ts');
  });

  it('deduplicates paths that appear in multiple rapid events', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges);

    // Same path saved twice (editor write + format-on-save)
    await capturedCallback(null, [{ type: 'update', path: '/project/src/foo.ts' }]);
    await capturedCallback(null, [{ type: 'update', path: '/project/src/foo.ts' }]);

    await timer.flush();

    expect(onChanges).toHaveBeenCalledOnce();
    const [paths] = onChanges.mock.calls[0];
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe('/project/src/foo.ts');
  });

  it('stop before debounce fires cancels the pending call', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges);

    await capturedCallback(null, [{ type: 'update', path: '/project/src/foo.ts' }]);
    expect(timer.hasPending()).toBe(true);

    // Stop cancels the pending debounce timer
    await watcher.stop();
    expect(timer.hasPending()).toBe(false);

    await timer.flush(); // nothing to flush
    expect(onChanges).not.toHaveBeenCalled();
  });

  it('two separate event batches after debounce each fire once', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges);

    await capturedCallback(null, [{ type: 'update', path: '/project/src/a.ts' }]);
    await timer.flush();

    await capturedCallback(null, [{ type: 'update', path: '/project/src/b.ts' }]);
    await timer.flush();

    expect(onChanges).toHaveBeenCalledTimes(2);
    expect(onChanges.mock.calls[0][0]).toContain('/project/src/a.ts');
    expect(onChanges.mock.calls[1][0]).toContain('/project/src/b.ts');
  });

  // ── Lifecycle ────────────────────────────────────────────────

  it('stop calls unsubscribe', async () => {
    await watcher.start('/project', mockConfig, vi.fn());
    await watcher.stop();
    expect(mockUnsubscribe).toHaveBeenCalledOnce();
  });

  it('stop clears subscription so second stop is a no-op', async () => {
    await watcher.start('/project', mockConfig, vi.fn());
    await watcher.stop();
    await watcher.stop();
    expect(mockUnsubscribe).toHaveBeenCalledOnce();
  });

  it('stop before start does not throw', async () => {
    await expect(watcher.stop()).resolves.not.toThrow();
  });
});
