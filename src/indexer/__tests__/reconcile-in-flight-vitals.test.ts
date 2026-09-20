/**
 * TRA-1763: the TRA-1125 counter covered only the single-file paths (HTTP
 * handler + `register_edit`), so it still lied the same way on every other
 * path that runs after `status: ready`: the deferred full edge-reconcile
 * (`fireEdgeReconcile`), the deferred coverage check, every watcher-driven
 * `indexFiles` batch (including the >200-file bulk full-pass fallback), and
 * every ready-state `indexAll` (drops/storm full-walk, forced reindex).
 *
 * Field datum: daemon v3.31.0 logged `projects_indexing: 0` through a whole
 * storm window at 99% CPU and 926→1629 MB RSS — the reconcile passes that
 * caused it run outside any in-flight window.
 *
 * The pipeline now holds a `beginReindex` mark for all of those, and
 * `getCounts` excludes marked roots from the status-based term so the initial
 * load is not counted twice. Guarded here: leaf semantics, the synchronous
 * mark on `indexAll`/`indexFiles`, and the mark held across a real deferred
 * reconcile flush.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../reindex-inflight.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../reindex-inflight.js')>();
  // Records begin/end pairing around the REAL registry, so tests can assert
  // post-hoc that a mark was held across an awaited run without racing it.
  const events: string[] = [];
  return {
    ...actual,
    beginReindex: (project: string) => {
      events.push(`begin:${project}`);
      const end = actual.beginReindex(project);
      let done = false;
      return () => {
        if (!done) {
          done = true;
          events.push(`end:${project}`);
        }
        end();
      };
    },
    __inflightEvents: events,
  };
});

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { initializeDatabase } = await import('../../db/schema.js');
const { Store } = await import('../../db/store.js');
const { TraceMcpConfigSchema } = await import('../../config.js');
const { PluginRegistry } = await import('../../plugin-api/registry.js');
const { TypeScriptLanguagePlugin } = await import('../plugins/language/typescript/index.js');
const { IndexingPipeline } = await import('../pipeline.js');
const { beginReindex, countReindexingProjects, isReindexing } = await import(
  '../reindex-inflight.js'
);
// @ts-expect-error — mock-only export, see the vi.mock factory above.
const { __inflightEvents } = await import('../reindex-inflight.js');
const { logger } = await import('../../logger.js');

function makePipeline(store: InstanceType<typeof Store>, workDir: string) {
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  const config = TraceMcpConfigSchema.parse({
    root: workDir,
    include: ['**/*.ts'],
    exclude: [],
  });
  return new IndexingPipeline(store, registry, config, workDir);
}

describe('reindex-inflight registry', () => {
  it('counts a project while held and releases it once done', () => {
    expect(countReindexingProjects()).toBe(0);
    const end = beginReindex('/tra1763/proj-a');
    expect(countReindexingProjects()).toBe(1);
    expect(isReindexing('/tra1763/proj-a')).toBe(true);
    expect(isReindexing('/tra1763/other')).toBe(false);
    end();
    expect(countReindexingProjects()).toBe(0);
    expect(isReindexing('/tra1763/proj-a')).toBe(false);
  });

  it('normalizes keys, so a trailing slash does not double-count', () => {
    const first = beginReindex('/tra1763/proj-b');
    const second = beginReindex('/tra1763/proj-b/');
    expect(countReindexingProjects()).toBe(1);
    expect(isReindexing('/tra1763/proj-b')).toBe(true);
    first();
    expect(countReindexingProjects()).toBe(1);
    second();
    expect(countReindexingProjects()).toBe(0);
  });

  it('is idempotent — a double release cannot drop a concurrent mark', () => {
    const first = beginReindex('/tra1763/proj-c');
    const second = beginReindex('/tra1763/proj-c');
    first();
    first(); // the extra call must not cancel `second`
    expect(countReindexingProjects()).toBe(1);
    second();
    expect(countReindexingProjects()).toBe(0);
  });
});

describe('pipeline in-flight marks (end to end)', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'tra1763-reconcile-'));
    writeFileSync(join(workDir, 'a.ts'), 'export function alpha() { return 1; }\n');
    writeFileSync(join(workDir, 'b.ts'), 'export function beta() { return 2; }\n');
    (__inflightEvents as string[]).length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    expect(countReindexingProjects()).toBe(0);
  });

  it('indexAll holds the mark from call to settle', async () => {
    const store = new Store(initializeDatabase(':memory:'));
    const pipeline = makePipeline(store, workDir);
    const pending = pipeline.indexAll();
    // beginReindex runs synchronously on enqueue — no awaiting needed, so
    // this cannot race the run it measures.
    expect(countReindexingProjects()).toBe(1);
    expect(isReindexing(workDir)).toBe(true);
    await pending;
    expect(countReindexingProjects()).toBe(0);
    expect(isReindexing(workDir)).toBe(false);
  });

  it('a watcher-style indexFiles batch holds the mark while queued and running', async () => {
    const store = new Store(initializeDatabase(':memory:'));
    const pipeline = makePipeline(store, workDir);
    await pipeline.indexAll();
    (__inflightEvents as string[]).length = 0;

    const pending = pipeline.indexFiles(['a.ts']);
    expect(countReindexingProjects()).toBe(1);
    expect(isReindexing(workDir)).toBe(true);
    await pending;
    expect(countReindexingProjects()).toBe(0);
  });

  it('the deferred edge reconcile holds the mark across the full pass', async () => {
    const store = new Store(initializeDatabase(':memory:'));
    const pipeline = makePipeline(store, workDir);
    await pipeline.indexAll();

    // Symbol churn (a brand-new export) is what schedules the debounced
    // reconcile in resolveAllEdges.
    writeFileSync(
      join(workDir, 'b.ts'),
      'export function beta() { return 2; }\nexport function brandNew() { return 3; }\n',
    );
    await pipeline.indexFiles(['b.ts']);
    (__inflightEvents as string[]).length = 0;
    vi.clearAllMocks();

    // Nothing is running while the reconcile is still debounced — idle reads
    // idle, honestly.
    expect(countReindexingProjects()).toBe(0);

    await pipeline.__flushEdgeReconcileForTests();

    const events = __inflightEvents as string[];
    const beginIdx = events.indexOf(`begin:${workDir}`);
    const endIdx = events.indexOf(`end:${workDir}`);
    // The mark was taken and released around the run…
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(beginIdx);
    // …the run did real work between them (not the superseded early return)…
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: expect.any(Number) }),
      'Deferred edge reconcile completed',
    );
    // …and nothing leaks.
    expect(countReindexingProjects()).toBe(0);
  });
});
