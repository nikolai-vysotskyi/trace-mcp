import { describe, expect, it } from 'vitest';
import { ExtractPool } from '../../src/indexer/extract-pool.js';

describe('ExtractPool spawn is lazy (TRA-925)', () => {
  it('constructing a keepAlive pool spawns no worker threads', async () => {
    // A read-only / proxying session builds the indexing stack but never
    // extracts. Each live worker costs ~62 MB of the session's RSS, so
    // construction must stay free — see docs/perf/session-baseline.md.
    const pool = new ExtractPool({ keepAlive: true, size: 4 });
    expect((pool as unknown as { workers: unknown[] }).workers).toHaveLength(0);
    await pool.terminate();
  });
});
