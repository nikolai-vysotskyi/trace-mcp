import { describe, expect, it } from 'vitest';
import { createTestStore } from '../test-utils.js';

describe('FileRepository.insertFile idempotency', () => {
  it('does not throw UNIQUE constraint on duplicate path; returns same id', () => {
    const store = createTestStore();

    const id1 = store.insertFile('src/foo.ts', 'typescript', 'hash-a', 100, null, null);
    const id2 = store.insertFile('src/foo.ts', 'typescript', 'hash-b', 200, null, null);

    expect(id1).toBe(id2);

    const row = store.getFile('src/foo.ts');
    expect(row?.id).toBe(id1);
    expect(row?.content_hash).toBe('hash-b');
    expect(row?.byte_length).toBe(200);
  });

  it('preserves existing workspace when re-inserting without one', () => {
    const store = createTestStore();

    const id1 = store.insertFile('src/bar.ts', 'typescript', 'h1', 50, 'packages/api', null);
    const id2 = store.insertFile('src/bar.ts', 'typescript', 'h2', 60, null, null);

    expect(id1).toBe(id2);
    expect(store.getFile('src/bar.ts')?.workspace).toBe('packages/api');
  });

  it('creates file node exactly once across duplicate inserts', () => {
    const store = createTestStore();

    const id = store.insertFile('src/baz.ts', 'typescript', 'h', 10, null, null);
    store.insertFile('src/baz.ts', 'typescript', 'h2', 20, null, null);
    store.insertFile('src/baz.ts', 'typescript', 'h3', 30, null, null);

    const count = store.db
      .prepare("SELECT COUNT(*) AS c FROM nodes WHERE node_type = 'file' AND ref_id = ?")
      .get(id) as { c: number };
    expect(count.c).toBe(1);
  });
});
