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

/**
 * Flush the debounce timer.
 * We use debounceMs=0 in tests so the timer fires in the next event-loop tick.
 * A single `await Promise.resolve()` drains that tick.
 */
async function flushDebounce() {
  // setTimeout(fn, 0) in the watcher fires after macrotask queue drains.
  // We need two macrotask ticks: one for the timer to fire, one for its async body.
  await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 10));
}

describe('FileWatcher', () => {
  let watcher: FileWatcher;
  let mockUnsubscribe: ReturnType<typeof vi.fn>;
  let capturedCallback: WatchCallback;

  beforeEach(() => {
    watcher = new FileWatcher();
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
    await watcher.start('/project', mockConfig, onChanges, 0);

    await capturedCallback(null, [
      { type: 'create', path: '/project/src/foo.ts' },
      { type: 'update', path: '/project/src/bar.ts' },
    ]);

    // Not fired yet — debounce pending
    expect(onChanges).not.toHaveBeenCalled();

    await flushDebounce();

    expect(onChanges).toHaveBeenCalledOnce();
    const [paths] = onChanges.mock.calls[0];
    expect(paths).toContain('/project/src/foo.ts');
    expect(paths).toContain('/project/src/bar.ts');
  });

  it('ignores delete events', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges, 0);

    await capturedCallback(null, [{ type: 'delete', path: '/project/src/gone.ts' }]);
    await flushDebounce();

    expect(onChanges).not.toHaveBeenCalled();
  });

  it('filters out files inside ignored directories', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges, 0);

    await capturedCallback(null, [
      { type: 'update', path: '/project/node_modules/pkg/index.js' },
      { type: 'update', path: '/project/vendor/lib/Foo.php' },
      { type: 'update', path: '/project/src/app.ts' },
    ]);
    await flushDebounce();

    expect(onChanges).toHaveBeenCalledWith(['/project/src/app.ts']);
  });

  it('does not call onChanges when event list is empty', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges, 0);

    await capturedCallback(null, []);
    await flushDebounce();

    expect(onChanges).not.toHaveBeenCalled();
  });

  it('does not call onChanges when all events are filtered out', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges, 0);

    await capturedCallback(null, [
      { type: 'delete', path: '/project/src/old.ts' },
      { type: 'update', path: '/project/node_modules/x/y.js' },
    ]);
    await flushDebounce();

    expect(onChanges).not.toHaveBeenCalled();
  });

  // ── Debounce-specific ────────────────────────────────────────

  it('coalesces rapid events into a single onChanges call', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges, 0);

    // Three rapid bursts without flushing in between
    await capturedCallback(null, [{ type: 'update', path: '/project/src/a.ts' }]);
    await capturedCallback(null, [{ type: 'update', path: '/project/src/b.ts' }]);
    await capturedCallback(null, [{ type: 'update', path: '/project/src/c.ts' }]);

    expect(onChanges).not.toHaveBeenCalled();
    await flushDebounce();

    // All paths collapsed into one call
    expect(onChanges).toHaveBeenCalledOnce();
    const [paths] = onChanges.mock.calls[0];
    expect(paths).toContain('/project/src/a.ts');
    expect(paths).toContain('/project/src/b.ts');
    expect(paths).toContain('/project/src/c.ts');
  });

  it('deduplicates paths that appear in multiple rapid events', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges, 0);

    // Same path saved twice (editor write + format-on-save)
    await capturedCallback(null, [{ type: 'update', path: '/project/src/foo.ts' }]);
    await capturedCallback(null, [{ type: 'update', path: '/project/src/foo.ts' }]);

    await flushDebounce();

    expect(onChanges).toHaveBeenCalledOnce();
    const [paths] = onChanges.mock.calls[0];
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe('/project/src/foo.ts');
  });

  it('stop before debounce fires cancels the pending call', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges, 0);

    await capturedCallback(null, [{ type: 'update', path: '/project/src/foo.ts' }]);
    expect(onChanges).not.toHaveBeenCalled(); // not fired yet

    // Stop cancels the pending debounce timer
    await watcher.stop();
    await flushDebounce(); // nothing to flush

    expect(onChanges).not.toHaveBeenCalled();
  });

  it('two separate event batches after debounce each fire once', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges, 0);

    await capturedCallback(null, [{ type: 'update', path: '/project/src/a.ts' }]);
    await flushDebounce();

    await capturedCallback(null, [{ type: 'update', path: '/project/src/b.ts' }]);
    await flushDebounce();

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
