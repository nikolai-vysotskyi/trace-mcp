/**
 * TRA-3099: once the embedding circuit breaker tripped, recovery depended
 * entirely on a file edit landing after the cooldown window — an idle
 * project whose provider came back online stayed FTS-only forever, because
 * nothing but a reindex ever called `indexUnembedded()` again. `setupAI`
 * now also re-checks the backlog on a fixed interval, independent of edits.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { embedBatch } = vi.hoisted(() => ({ embedBatch: vi.fn() }));

vi.mock('../../src/ai/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/index.js')>();
  return {
    ...actual,
    createAIProvider: () => ({
      isAvailable: async () => true,
      embedding: () => ({
        embed: async () => [0.1, 0.2, 0.3, 0.4],
        embedBatch,
        dimensions: () => 4,
        modelName: () => 'mock-model',
        providerName: () => 'openai',
      }),
      inference: () => {
        throw new Error('not used in this test');
      },
      fastInference: () => {
        throw new Error('not used in this test — summarize_on_index is false');
      },
    }),
  };
});

import { readEmbeddingBreakerState } from '../../src/ai/embedding-pipeline.js';
import type { TraceMcpConfig } from '../../src/config.js';
import { TraceMcpConfigSchema } from '../../src/config.js';
import {
  BranchIndex,
  DEFAULT_WORKTREE_INDEX_SETTINGS,
  type SnapshotMeta,
  WorktreeIndexManager,
} from '../../src/daemon/worktree-index.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { ProgressState } from '../../src/progress.js';

/** Realistic undici shape for `fetch(...)` with nothing listening. */
function refusedError(): TypeError {
  const conn = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), {
    code: 'ECONNREFUSED',
  });
  const aggregate = Object.assign(new AggregateError([conn], 'fetch failed'), {
    code: 'ECONNREFUSED',
  });
  return new TypeError('fetch failed', { cause: aggregate });
}

describe('branch index embedding retry (TRA-3099)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-wt-ai-retry-'));
    embedBatch.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('drains the backlog on the next periodic check once the provider recovers, with no file edit', async () => {
    const dbPath = path.join(tmp, 'x.db');
    const db = initializeDatabase(dbPath);
    const store = new Store(db);
    const progress = new ProgressState(db);
    const fileId = store.insertFile('src/a.ts', 'typescript', 'hash1', 30);
    for (const id of ['s1', 's2', 's3']) {
      store.insertSymbol(fileId, {
        symbolId: id,
        name: id,
        kind: 'function',
        byteStart: 0,
        byteEnd: 5,
      });
    }
    expect(store.countUnembeddedSymbols()).toBe(3);

    const owner = new WorktreeIndexManager({
      settings: DEFAULT_WORKTREE_INDEX_SETTINGS,
      getCanonical: () => undefined,
      dir: tmp,
    });
    const meta: SnapshotMeta = {
      schema: 1,
      worktree_root: tmp,
      canonical_root: tmp,
      canonical_head: 'a'.repeat(40),
      version: 'test',
      created_at: 0,
      last_used_at: 0,
      applied: [],
    };
    const index = new BranchIndex(owner, { dbPath, metaPath: path.join(tmp, 'x.json'), meta }, 0);
    index.markReady(0);

    const config: TraceMcpConfig = TraceMcpConfigSchema.parse({
      include: ['src/**/*.ts'],
      exclude: [],
      ai: { enabled: true, provider: 'onnx', summarize_on_index: false },
    });

    // Provider unreachable from the start — the common field case (LM Studio
    // / Ollama not running, or down for maintenance).
    embedBatch.mockImplementation(async () => {
      throw refusedError();
    });

    (
      index as unknown as {
        setupAI: (config: TraceMcpConfig, store: Store, progress: ProgressState) => void;
      }
    ).setupAI(config, store, progress);

    // First periodic check (5 min + debounce): the breaker trips on the
    // first failure and the backlog is left untouched.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10_000);
    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(store.countUnembeddedSymbols()).toBe(3);
    const tripped = readEmbeddingBreakerState(db);
    expect(tripped).not.toBeNull();
    expect(tripped!.disabledUntilMs).toBeGreaterThan(Date.now());

    // Provider comes back — nothing touches the project: no file edit, no
    // explicit embed_repo call, no daemon restart.
    embedBatch.mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]));

    // Advance past the 10-minute cooldown to the next periodic check (the
    // 15-minute mark from setupAI; one skipped check at 10 minutes lands
    // inside the still-open cooldown and must not call the provider again).
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(embedBatch).toHaveBeenCalledTimes(2);
    expect(store.countUnembeddedSymbols()).toBe(0);
    expect(readEmbeddingBreakerState(db)).toBeNull();

    (index as unknown as { cancelAI: (() => void) | null }).cancelAI?.();
    db.close();
  });
});
