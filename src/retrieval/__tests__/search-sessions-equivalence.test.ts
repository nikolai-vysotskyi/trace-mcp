/**
 * SearchSessionsRetriever ↔ direct-call equivalence tests.
 *
 * Migration slice 2 of the search-tool migration arc. Behaviour-preserving
 * refactor — the new retriever returns the exact same row set as a direct
 * `DecisionStore.searchSessions()` call.
 *
 * Coverage matrix:
 *   1. literal query — matches across roles
 *   2. project_root filter narrows results
 *   3. limit caps the result set
 *   4. empty result when query matches no chunk
 *   5. cross-project query (no project_root filter) sees every chunk
 *   6. retriever exposes a stable `name`
 *
 * Note: SQLite FTS5 ranking is order-deterministic given identical inputs,
 * so byte-equality with `toEqual` is the right contract here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../memory/decision-store.js';
import {
  createSearchSessionsRetriever,
  type SearchSessionsQuery,
} from '../retrievers/search-sessions-retriever.js';
import { runRetriever } from '../types.js';

interface Fixture {
  store: DecisionStore;
  dbPath: string;
  tmpDir: string;
}

function seedFixture(): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-search-sessions-'));
  const dbPath = path.join(tmpDir, 'decisions.db');
  const store = new DecisionStore(dbPath);
  store.addSessionChunks([
    {
      session_id: 'sess-a',
      project_root: '/projects/alpha',
      chunk_index: 0,
      role: 'user',
      content: 'Should we switch to GraphQL for the new API?',
      timestamp: '2026-01-01T10:00:00Z',
    },
    {
      session_id: 'sess-a',
      project_root: '/projects/alpha',
      chunk_index: 1,
      role: 'assistant',
      content: 'GraphQL helps when clients need flexible queries; otherwise REST is simpler.',
      timestamp: '2026-01-01T10:01:00Z',
    },
    {
      session_id: 'sess-b',
      project_root: '/projects/beta',
      chunk_index: 0,
      role: 'user',
      content: 'Fix the auth middleware bug — JWT expiration leaking into refresh path.',
      timestamp: '2026-01-02T12:00:00Z',
    },
    {
      session_id: 'sess-c',
      project_root: '/projects/alpha',
      chunk_index: 0,
      role: 'assistant',
      content: 'Database migration approach: use a forward-only naming scheme with timestamps.',
      timestamp: '2026-01-03T09:00:00Z',
    },
  ]);
  return { store, dbPath, tmpDir };
}

function cleanup(fixture: Fixture): void {
  fixture.store.close();
  fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
}

async function runViaRetriever(fixture: Fixture, q: SearchSessionsQuery): Promise<unknown> {
  const retriever = createSearchSessionsRetriever({ store: fixture.store });
  const [out] = await runRetriever(retriever, q);
  return out;
}

describe('SearchSessionsRetriever ↔ direct-call equivalence', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = seedFixture();
  });

  afterEach(() => {
    cleanup(fixture);
  });

  it('case 1: literal query — matches across roles', async () => {
    const direct = fixture.store.searchSessions('GraphQL');
    const via = await runViaRetriever(fixture, { query: 'GraphQL' });
    expect(via).toEqual(direct);
    expect(direct.length).toBeGreaterThanOrEqual(2);
  });

  it('case 2: project_root filter narrows results', async () => {
    const direct = fixture.store.searchSessions('auth', { project_root: '/projects/beta' });
    const via = await runViaRetriever(fixture, {
      query: 'auth',
      projectRoot: '/projects/beta',
    });
    expect(via).toEqual(direct);
    for (const row of direct) expect(row.session_id).toBe('sess-b');
  });

  it('case 3: limit caps the result set', async () => {
    const direct = fixture.store.searchSessions('GraphQL OR migration OR auth', { limit: 1 });
    const via = await runViaRetriever(fixture, {
      query: 'GraphQL OR migration OR auth',
      limit: 1,
    });
    expect(via).toEqual(direct);
    expect(direct.length).toBeLessThanOrEqual(1);
  });

  it('case 4: empty result on unmatched query', async () => {
    const direct = fixture.store.searchSessions('zzz_no_such_topic_anywhere');
    const via = await runViaRetriever(fixture, { query: 'zzz_no_such_topic_anywhere' });
    expect(via).toEqual(direct);
    expect(direct).toEqual([]);
  });

  it('case 5: no project_root sees every project', async () => {
    const direct = fixture.store.searchSessions('GraphQL OR auth');
    const via = await runViaRetriever(fixture, { query: 'GraphQL OR auth' });
    expect(via).toEqual(direct);
    const projects = new Set(direct.map((row) => row.session_id));
    expect(projects.size).toBeGreaterThanOrEqual(2);
  });

  it('exposes name "search_sessions_tool" for registry routing', () => {
    const retriever = createSearchSessionsRetriever({ store: fixture.store });
    expect(retriever.name).toBe('search_sessions_tool');
  });
});
