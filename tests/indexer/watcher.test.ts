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

  afterEach(() => {
    vi.clearAllMocks();
  });

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

  it('calls onChanges for create and update events', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges);

    await capturedCallback(null, [
      { type: 'create', path: '/project/src/foo.ts' },
      { type: 'update', path: '/project/src/bar.ts' },
    ]);

    expect(onChanges).toHaveBeenCalledOnce();
    expect(onChanges).toHaveBeenCalledWith([
      '/project/src/foo.ts',
      '/project/src/bar.ts',
    ]);
  });

  it('ignores delete events', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges);

    await capturedCallback(null, [
      { type: 'delete', path: '/project/src/gone.ts' },
    ]);

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

    expect(onChanges).toHaveBeenCalledWith(['/project/src/app.ts']);
  });

  it('does not call onChanges when event list is empty', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges);

    await capturedCallback(null, []);

    expect(onChanges).not.toHaveBeenCalled();
  });

  it('does not call onChanges when all events are filtered out', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges);

    await capturedCallback(null, [
      { type: 'delete', path: '/project/src/old.ts' },
      { type: 'update', path: '/project/node_modules/x/y.js' },
    ]);

    expect(onChanges).not.toHaveBeenCalled();
  });

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
