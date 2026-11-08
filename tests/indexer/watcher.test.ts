import * as parcelWatcher from '@parcel/watcher';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceMcpConfigSchema, type TraceMcpConfig } from '../../src/config.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { FileWatcher } from '../../src/indexer/watcher.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';

vi.mock('@parcel/watcher', () => ({
  subscribe: vi.fn(),
}));

const mockConfig: TraceMcpConfig = {
  root: '/project',
  include: ['src/**/*.ts'],
  exclude: [],
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

  it('drops events matching config.exclude globs (runtime churn dirs)', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    const config: TraceMcpConfig = {
      ...mockConfig,
      exclude: ['**/storage/**', '**/bootstrap/cache/**'],
    };
    await watcher.start('/project', config, onChanges);

    await capturedCallback(null, [
      { type: 'create', path: '/project/storage/framework/sessions/ePOAB7aEuvxc' },
      { type: 'update', path: '/project/bootstrap/cache/services.php' },
      { type: 'update', path: '/project/src/app.ts' },
    ]);
    await timer.flush();

    expect(onChanges).toHaveBeenCalledTimes(1);
    expect(onChanges).toHaveBeenCalledWith(['/project/src/app.ts']);
  });

  it('drops repeated paths outside include before debounce but keeps source edits', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start('/project', mockConfig, onChanges);

    for (let i = 0; i < 5; i++) {
      await capturedCallback(null, [
        { type: 'update', path: '/project/gem/calls.jsonl' },
        { type: 'update', path: '/project/notes.unparsed' },
      ]);
    }
    expect(timer.hasPending()).toBe(false);
    expect(onChanges).not.toHaveBeenCalled();

    await capturedCallback(null, [{ type: 'update', path: '/project/src/app.ts' }]);
    await timer.flush();
    await capturedCallback(null, [{ type: 'update', path: '/project/src/app.ts' }]);
    await timer.flush();
    expect(onChanges).toHaveBeenCalledTimes(2);
    expect(onChanges).toHaveBeenNthCalledWith(1, ['/project/src/app.ts']);
    expect(onChanges).toHaveBeenNthCalledWith(2, ['/project/src/app.ts']);
  });

  it('keeps jsonl when a project explicitly includes it', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start(
      '/project',
      { ...mockConfig, include: ['src/**/*.ts', 'gem/**/*.jsonl'] },
      onChanges,
    );
    await capturedCallback(null, [{ type: 'update', path: '/project/gem/calls.jsonl' }]);
    await timer.flush();
    expect(onChanges).toHaveBeenCalledWith(['/project/gem/calls.jsonl']);
  });

  it('indexes repeated real source edits while ignoring append-only data and unsupported files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-watcher-include-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'gem'));
    const source = path.join(root, 'src', 'app.ts');
    const journal = path.join(root, 'gem', 'calls.jsonl');
    const unsupported = path.join(root, 'notes.unparsed');
    fs.writeFileSync(source, 'export const first = 1;\n');
    fs.writeFileSync(journal, '{}\n');
    fs.writeFileSync(unsupported, 'notes\n');
    const db: Database.Database = initializeDatabase(path.join(root, 'index.db'));
    const store = new Store(db);
    const config = TraceMcpConfigSchema.parse({ root });
    const pipeline = new IndexingPipeline(store, PluginRegistry.createWithDefaults(), config, root);
    const indexed: number[] = [];
    try {
      await watcher.start(root, config, async (paths) => {
        indexed.push((await pipeline.indexFiles(paths)).indexed);
      });
      for (let i = 0; i < 5; i++) {
        fs.appendFileSync(journal, '{}\n');
        fs.appendFileSync(unsupported, 'more\n');
        await capturedCallback(null, [
          { type: 'update', path: journal },
          { type: 'update', path: unsupported },
        ]);
      }
      expect(timer.hasPending()).toBe(false);
      expect(indexed).toEqual([]);

      await capturedCallback(null, [{ type: 'update', path: source }]);
      await timer.flush();
      await watcher.drain();
      fs.writeFileSync(source, 'export const first = 1;\nexport const second = 2;\n');
      await capturedCallback(null, [{ type: 'update', path: source }]);
      await timer.flush();
      await watcher.drain();
      expect(indexed).toEqual([1, 1]);
      const file = store.getFile('src/app.ts');
      expect(file).toBeDefined();
      expect(store.getSymbolsByFile(file!.id).map((s) => s.name)).toContain('second');
    } finally {
      await watcher.stop();
      await pipeline.dispose();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('passes nested skip-dir globs and exclude globs to the native ignore list', async () => {
    const config: TraceMcpConfig = { ...mockConfig, exclude: ['**/storage/**'] };
    await watcher.start('/project', config, vi.fn());

    expect(parcelWatcher.subscribe).toHaveBeenCalledWith(
      '/project',
      expect.any(Function),
      expect.objectContaining({
        ignore: expect.arrayContaining(['**/node_modules/**', '**/storage/**']),
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

  // ── .gitignore filtering (TRA-85 — gitignored log/DB churn) ────

  describe('.gitignore filtering', () => {
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-watcher-gitignore-'));
      fs.writeFileSync(path.join(tmpRoot, '.gitignore'), '*.log\nlogs/\n');
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('drops gitignored paths before onChanges without ever reaching the pipeline', async () => {
      const onChanges = vi.fn().mockResolvedValue(undefined);
      await watcher.start(tmpRoot, mockConfig, onChanges);

      await capturedCallback(null, [
        { type: 'update', path: path.join(tmpRoot, 'daemon.log') },
        { type: 'update', path: path.join(tmpRoot, 'logs', 'app.log') },
        { type: 'update', path: path.join(tmpRoot, 'src', 'app.ts') },
      ]);
      await timer.flush();

      expect(onChanges).toHaveBeenCalledWith([path.join(tmpRoot, 'src', 'app.ts')]);
    });

    it('drops gitignored deletes too', async () => {
      const onDeletes = vi.fn().mockResolvedValue(undefined);
      await watcher.start(tmpRoot, mockConfig, vi.fn(), undefined, onDeletes);

      await capturedCallback(null, [{ type: 'delete', path: path.join(tmpRoot, 'daemon.log') }]);
      await timer.flush();

      expect(onDeletes).not.toHaveBeenCalled();
    });
  });
});
