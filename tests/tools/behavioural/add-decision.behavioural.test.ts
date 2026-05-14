/**
 * Behavioural coverage for the `add_decision` MCP tool. The tool wraps
 * `DecisionStore.addDecision` and is also exercised end-to-end through the
 * MCP surface (src/tools/register/memory.ts). The brief asks us to assert
 * the storage contract — every test here goes through the same store API the
 * tool handler uses, so the diff between "store" and "tool" is exactly the
 * Zod parser + projectRoot/branch resolution. Those are out-of-scope here.
 *
 * Cases:
 *  - row appears in query_decisions after add and returns id/type/title
 *  - tags array round-trips through JSON storage
 *  - service_name + symbol_id + file_path persist on the row
 *  - default review_status is null (auto-approved) when omitted
 *  - explicit review_status: 'pending' lands the row in the review queue
 *    (hidden by default; visible with include_pending)
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../../src/memory/decision-store.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

const PROJECT = '/projects/add-decision-fixture';

describe('add_decision — behavioural contract', () => {
  let store: DecisionStore;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = createTmpDir('add-decision-behav-');
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) removeTmpDir(tmpDir);
  });

  it('adding a decision returns an id and the row appears in query_decisions', () => {
    const added = store.addDecision({
      title: 'Use SQLite for indexing',
      content: 'SQLite is in-process, fast, and ships with Node.',
      type: 'tech_choice',
      project_root: PROJECT,
    });

    expect(added.id).toBeGreaterThan(0);
    expect(added.title).toBe('Use SQLite for indexing');
    expect(added.type).toBe('tech_choice');

    const found = store.queryDecisions({ project_root: PROJECT });
    expect(found.some((r) => r.id === added.id)).toBe(true);
  });

  it('tags array stored and retrievable', () => {
    const added = store.addDecision({
      title: 'Adopt Redis caching layer',
      content: 'Cache hot reads to cut DB load.',
      type: 'architecture_decision',
      project_root: PROJECT,
      tags: ['caching', 'performance', 'redis'],
    });

    // Tags stored as JSON string on the row.
    const fetched = store.getDecision(added.id);
    expect(fetched).toBeDefined();
    expect(fetched?.tags).toBeTruthy();
    const parsedTags = JSON.parse(fetched?.tags ?? '[]') as string[];
    expect(parsedTags).toEqual(['caching', 'performance', 'redis']);

    // Tag filter on query still matches.
    const byTag = store.queryDecisions({ project_root: PROJECT, tag: 'performance' });
    expect(byTag.some((r) => r.id === added.id)).toBe(true);
  });

  it('service_name, symbol_id, and file_path are persisted on the row', () => {
    const added = store.addDecision({
      title: 'Centralise auth provider',
      content: 'All requests go through AuthProvider.verify().',
      type: 'architecture_decision',
      project_root: PROJECT,
      service_name: 'auth-api',
      symbol_id: 'src/auth/provider.ts::AuthProvider#class',
      file_path: 'src/auth/provider.ts',
    });

    expect(added.service_name).toBe('auth-api');
    expect(added.symbol_id).toBe('src/auth/provider.ts::AuthProvider#class');
    expect(added.file_path).toBe('src/auth/provider.ts');

    // Each linkage column is independently queryable.
    const byService = store.queryDecisions({ project_root: PROJECT, service_name: 'auth-api' });
    expect(byService.some((r) => r.id === added.id)).toBe(true);

    const bySymbol = store.queryDecisions({
      project_root: PROJECT,
      symbol_id: 'src/auth/provider.ts::AuthProvider#class',
    });
    expect(bySymbol.some((r) => r.id === added.id)).toBe(true);

    const byFile = store.queryDecisions({
      project_root: PROJECT,
      file_path: 'src/auth/provider.ts',
    });
    expect(byFile.some((r) => r.id === added.id)).toBe(true);
  });

  it('default review_status is null (auto-approved) when not specified', () => {
    const added = store.addDecision({
      title: 'Pin Node to LTS',
      content: 'Stay on the LTS release line.',
      type: 'preference',
      project_root: PROJECT,
    });

    // Persisted as NULL — visible by default in queries.
    expect(added.review_status).toBeNull();

    const def = store.queryDecisions({ project_root: PROJECT });
    expect(def.some((r) => r.id === added.id)).toBe(true);
  });

  it('explicit review_status: "pending" lands the row in the review queue (hidden by default)', () => {
    const added = store.addDecision({
      title: 'Maybe move to gRPC',
      content: 'Borderline confidence — flag for human review.',
      type: 'tradeoff',
      project_root: PROJECT,
      review_status: 'pending',
    });

    expect(added.review_status).toBe('pending');

    // Default query hides the review queue.
    const def = store.queryDecisions({ project_root: PROJECT });
    expect(def.some((r) => r.id === added.id)).toBe(false);

    // include_pending=true brings it back.
    const withPending = store.queryDecisions({
      project_root: PROJECT,
      include_pending: true,
    });
    expect(withPending.some((r) => r.id === added.id)).toBe(true);

    // Or restrict to the pending tier explicitly.
    const pendingOnly = store.queryDecisions({
      project_root: PROJECT,
      review_status: 'pending',
    });
    expect(pendingOnly.some((r) => r.id === added.id)).toBe(true);
  });
});
